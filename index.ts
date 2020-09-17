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
}

export interface Service {
  [methodName: string]: Method;
}

export function createRequestHandler<S extends Service>(
  service: S,
  serviceDetails: ServiceDetails<S>
): RequestHandler {
  const exposed = serviceDetails.expose;
  const methods = exposed.map((m) => m.methodName);
  const serviceName = serviceDetails.service;
  const serviceHelp = serviceDetails.help || serviceName + " service";

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
      return res.json(meta.interfaces.find((i) => i.methodName === methodName));
    }

    if (req.method !== "POST" || !methods.includes(methodName)) {
      return next();
    }

    const requestMeta = { handler: `${serviceName}.${methodName}` };
    const end = requestDuration.startTimer(requestMeta);

    requestCount.inc(requestMeta);

    return Promise.resolve()
      .then(() => service[methodName].call(service, req.body))
      .then((result) => (console.log("result", result), res.json(result)))
      .catch((err) => {
        failureCount.inc(Object.assign({ type: err.type }, requestMeta));
        next(new RpcError(serviceName, methodName, err));
      })
      .finally(end);
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
