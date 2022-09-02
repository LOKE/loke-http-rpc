import { Histogram, Counter } from "prom-client";
import { RequestHandler, ErrorRequestHandler } from "express";
import { JTDSchemaType } from "ajv/dist/jtd";

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

export interface MethodDetails {
  methodName: string;
  methodTimeout?: number;
  help?: string;
  paramNames?: string[];
  requestTypeDef?: JTDSchemaType<any, any>;
  responseTypeDef?: JTDSchemaType<any, any>;
}

export interface ServiceDetails<
  S,
  Def extends Record<string, unknown> = Record<string, never>
> {
  expose: MethodDetails[];
  service: string;
  help?: string;
  path?: string;
  definitions?: {
    [K in keyof Def]: JTDSchemaType<Def[K], Def>;
  };
}

export interface Service {
  [methodName: string]: Method;
}

export interface ServiceSet<S extends Service> {
  implementation: S;
  meta: ServiceDetails<S>;
}

function getExposedMeta<Def extends Record<string, unknown>>(
  serviceDetails: ServiceDetails<Def>
) {
  return {
    serviceName: serviceDetails.service,
    multiArg: false,
    help: serviceDetails.help || serviceDetails.service + " service",
    definitions: serviceDetails.definitions,
    interfaces: serviceDetails.expose.map((method: MethodDetails) => {
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
        requestTypeDef,
        responseTypeDef,
      } = method;

      return {
        methodName,
        paramNames,
        methodTimeout,
        help: help || methodName + " method",
        requestTypeDef,
        responseTypeDef,
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

export function createRequestHandler(
  services: ServiceSet<any>[],
  options?: CreateRequestHandlerOptions
): RequestHandler {
  const { legacy = false } = options || {};

  if (legacy && services.length !== 1) {
    throw new Error("Only 1 service is supported in legacy mode");
  }

  const postHandlers = new Map<string, RequestHandler>();
  const getHandlers = new Map<string, RequestHandler>();

  const meta = {
    services: Object.values(services.map((s) => getExposedMeta(s.meta))),
  };

  getHandlers.set("/", (req, res) => {
    res.json(meta);
  });

  for (const service of services) {
    const serviceName = service.meta.service;
    const serviceMeta = meta.services.find(
      (s) => s.serviceName === serviceName
    );

    getHandlers.set(`/${serviceName}`, (req, res) => {
      res.json(serviceMeta);
    });

    for (const methodDef of service.meta.expose) {
      const { methodName } = methodDef;
      const methodMeta = serviceMeta?.interfaces.find(
        (s) => s.methodName === methodName
      );

      const getHandler: RequestHandler = (req, res) => {
        res.json(methodMeta);
      };
      getHandlers.set(`/${serviceName}/${methodName}`, getHandler);
      if (legacy) {
        getHandlers.set(`/${methodName}`, getHandler);
      }

      const requestMeta = { handler: `${serviceName}.${methodName}` };

      const methodFn = service.implementation[methodName].bind(
        service.implementation
      );

      const postHandler: RequestHandler = async (req, res, next) => {
        const end = requestDuration.startTimer(requestMeta);

        try {
          requestCount.inc(requestMeta);

          const result = await methodFn(req.body);

          res.json(result);
        } catch (err: any) {
          failureCount.inc(Object.assign({ type: err.type }, requestMeta));
          next(new RpcError(serviceName, methodName, err));
        } finally {
          end();
        }
      };

      postHandlers.set(`/${serviceName}/${methodName}`, postHandler);
      if (legacy) {
        postHandlers.set(`/${methodName}`, postHandler);
      }
    }
  }

  return async (req, res, next) => {
    let handler: RequestHandler | undefined;
    switch (req.method) {
      case "GET":
        handler = getHandlers.get(req.path);
        break;
      case "POST":
        handler = postHandlers.get(req.path);
        break;
    }

    if (!handler) {
      return next();
    }

    handler(req, res, next);
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
