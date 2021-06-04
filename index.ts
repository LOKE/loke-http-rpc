import { Histogram, Counter } from "prom-client";
import { RequestHandler, ErrorRequestHandler } from "express";

const requestDuration = new Histogram({
  name: "http_rpc_request_duration_seconds",
  help: "Duration of rpc requests",
  labelNames: ["handler"],
});
const requestCount = new Counter({
  name: "http_rpc_requests_total",
  help: "The total number of rpc requests received",
  labelNames: ["handler"],
});
const failureCount = new Counter({
  name: "http_rpc_failures_total",
  help: "The total number of rpc failures received",
  labelNames: ["handler", "type"],
});

class ExtendableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    this.message = message;
    if (typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(this, this.constructor);
    } else {
      this.stack = new Error(message).stack;
    }
  }
}

export class RpcError extends ExtendableError {
  serviceName: string;
  methodName: string;
  inner: Error & { type?: string; code?: string | number };

  constructor(serviceName: string, methodName: string, inner: Error) {
    super(
      `An error occurred while executing method ${serviceName}/${methodName}`
    );
    this.serviceName = serviceName;
    this.methodName = methodName;
    this.inner = inner;
  }
}

export type Method<A = any, R = any> = (args: A) => R;

export interface MethodDetails<S> {
  methodName: keyof S;
  methodTimeout?: number;
  help?: string;
  paramNames?: string[];
}

export interface ServiceDetails<S> {
  expose: MethodDetails<S>[];
  service: string;
  help?: string;
  path?: string;
}

export interface Service {
  [methodName: string]: Method;
}

interface ServiceSet<S extends Service> {
  implementation: S;
  meta: ServiceDetails<S>;
}

function hasMethod(
  serviceDetails: ServiceDetails<any>,
  methodName: string
): boolean {
  return serviceDetails.expose.map((m) => m.methodName).includes(methodName);
}

function getExposedMeta<S extends Service>(serviceDetails: ServiceDetails<S>) {
  return {
    serviceName: serviceDetails.service,
    multiArg: false,
    help: serviceDetails.help || serviceDetails.service + " service",
    interfaces: serviceDetails.expose.map((method: MethodDetails<S>) => {
      if (typeof method === "string") {
        throw new Error(
          "Schema for expose has changed. Please refer to @loke/http-rpc documentation."
        );
      }
      const {
        methodName,
        methodTimeout = 60000,
        help,
        paramNames = [],
      } = method;

      return {
        methodName,
        paramNames,
        methodTimeout,
        help: help || methodName + " method",
      };
    }),
  };
}

interface CreateRequestHandlerOptions {
  /**
   * If true runs in legacy mode where only a single service is served from the root path.
   * Deprecated - do not use except for legacy scenarios.
   */
  legacy?: boolean;
}

function parsePath(
  path: string,
  legacy: boolean
): { serviceName?: string; methodName: string } {
  const pathParts = path.split("/");

  // Legacy mode still supports the new /service-name/methodName format
  // If length is 2 we assume it is the old /methodName format
  if (legacy && pathParts.length === 2) {
    const [, methodName] = path.split("/");
    return { methodName };
  }

  const [, serviceName, methodName] = path.split("/");

  return { serviceName, methodName };
}

// TODO: can't seem to get out of using any here because the type is an array
export function createRequestHandler(
  services: ServiceSet<any>[],
  options?: CreateRequestHandlerOptions
): RequestHandler {
  const serviceMap = services.reduce((obj, service) => {
    obj[service.meta.service] = service;
    return obj;
  }, {} as Record<string, ServiceSet<any>>);

  const { legacy = false } = options || {};

  if (legacy && services.length !== 1) {
    throw new Error("Only 1 service is supported in legacy mode");
  }

  return async (
    req: { path: string; method: string; body: unknown },
    res: { json: (body: unknown) => void },
    next: (err?: Error) => void
  ) => {
    // Is it requested the meta for all known services?
    if (req.path === "/") {
      // return an array of service metadata
      res.json({
        services: Object.values(services.map((s) => getExposedMeta(s.meta))),
      });
      return;
    }

    // eg /email-service/sendEmail -> ["", "email-service", "sendEmail"]
    const { serviceName: parsedServiceName, methodName } = parsePath(
      req.path,
      legacy
    );
    const serviceName = legacy
      ? services[0].meta.service
      : (parsedServiceName as string);

    if (!serviceMap[serviceName]) {
      // We don't have this service, don't handle
      return next();
    }

    const service = serviceMap[serviceName];

    if (req.method === "GET" && req.path === "/" + serviceName) {
      return res.json(getExposedMeta(service.meta));
    }

    if (req.method === "GET" && hasMethod(service.meta, methodName)) {
      return res.json(
        getExposedMeta(service.meta).interfaces.find(
          (i) => i.methodName === methodName
        )
      );
    }

    if (req.method !== "POST" || !hasMethod(service.meta, methodName)) {
      return next();
    }

    const requestMeta = { handler: `${serviceName}.${methodName}` };
    const end = requestDuration.startTimer(requestMeta);

    try {
      requestCount.inc(requestMeta);

      const result = await service.implementation[methodName].call(
        service.implementation,
        req.body
      );
      res.json(result);
    } catch (err) {
      failureCount.inc(Object.assign({ type: err.type }, requestMeta));
      next(new RpcError(serviceName, methodName, err));
    } finally {
      end();
    }
  };
}

export function createErrorHandler(
  args: { log?: (msg: string) => void } = {}
): ErrorRequestHandler {
  const { log = () => undefined } = args;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (err, req, res, next) => {
    const source = `${err.serviceName}/${err.methodName}`;
    if (!(err instanceof RpcError)) {
      log(`Internal error executing ${source}: ${err.stack || err.message}`);
      return res.status(500).json({ message: err.message });
    }

    log(`Error executing ${source}: ${err.inner.stack}`);
    if (!err.inner.type) {
      log(
        `Legacy error returned from ${source}: name=${err.inner.name}, code=${err.inner.code}`
      );
      return res.status(400).json({
        message: err.inner.message,
        code: err.inner.code,
      });
    }

    return res.status(400).json(err.inner);
  };
}
