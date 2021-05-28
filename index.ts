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

class RegisteredService<S extends Service> {
  constructor(private service: S, private serviceDetails: ServiceDetails<S>) {}

  /**
   * Creates an express HTTP handler that will process RPC requests for methods exposed by the service, as well as return metadata about the service.
   */
  createRequestHandler(): RequestHandler {
    const exposed = this.serviceDetails.expose;
    const methods = exposed.map((m) => m.methodName);
    const serviceName = this.serviceDetails.service;
    const serviceHelp = this.serviceDetails.help || serviceName + " service";

    const meta = {
      serviceName,
      multiArg: false,
      help: serviceHelp,
      interfaces: exposed.map((method: MethodDetails<S>) => {
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

    return (
      req: { path: string; method: string; body: unknown },
      res: { json: (body: unknown) => void },
      next: (err?: Error) => void
    ) => {
      const methodName: string = req.path.slice(1); // remove leading slash

      if (req.method === "GET" && req.path === "/") {
        return res.json(meta);
      }

      if (req.method === "GET" && methods.includes(methodName)) {
        return res.json(
          meta.interfaces.find((i) => i.methodName === methodName)
        );
      }

      if (req.method !== "POST" || !methods.includes(methodName)) {
        return next();
      }

      const requestMeta = { handler: `${serviceName}.${methodName}` };
      const end = requestDuration.startTimer(requestMeta);

      requestCount.inc(requestMeta);

      return Promise.resolve()
        .then(() => this.service[methodName].call(this.service, req.body))
        .then((result) => (console.log("result", result), res.json(result)))
        .catch((err) => {
          failureCount.inc(Object.assign({ type: err.type }, requestMeta));
          next(new RpcError(serviceName, methodName, err));
        })
        .finally(end);
    };
  }

  /**
   * Returns metadata of the registered service
   */
  toWellKnownMeta() {
    return {
      name: this.serviceDetails.service,
      help: this.serviceDetails.help,
      path: this.serviceDetails.path || `/rpc/${this.serviceDetails.service}`,
    };
  }
}

export class Registry {
  // TODO: Fix the RegisteredService type from 'any'
  private registeredServices: Record<string, RegisteredService<any>> = {};

  /**
   * Registers the service before processing RPC requests for methods exposed by the service.
   */
  register<S extends Service>(
    service: S,
    serviceDetails: ServiceDetails<S>
  ): RegisteredService<S> {
    const rs = new RegisteredService<S>(service, serviceDetails);

    this.registeredServices[serviceDetails.service] = rs;

    return rs;
  }

  /**
   * Creates an express HTTP handler that serves services metadata
   */
  createWellKnownMetaHandler(): RequestHandler {
    return (
      req: { path: string; method: string; body: unknown },
      res: { json: (body: unknown) => void }
    ) => {
      res.json({
        services: Object.values(this.registeredServices).map((rs) =>
          rs.toWellKnownMeta()
        ),
      });
    };
  }
}

/** Default registry */
export const registry = new Registry();

/**  Default path to expose discovery metadata on a well-known URL */
export const WELL_KNOWN_META_PATH = "/.well-known/loke-rpc/server";

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
