import { Histogram, Counter } from "prom-client";
import { RequestHandler, ErrorRequestHandler } from "express";
import { Abortable } from "@loke/context";
import * as context from "@loke/context";
import onFinished from "on-finished";
import { randomBytes } from "crypto";

import {
  ServiceSet,
  ServiceDetails,
  MethodDetails,
  requestContexts,
} from "./common";

export {
  ServiceSet,
  ServiceDetails,
  MethodDetails,
  Service,
  Method,
  ContextMethod,
  ContextService,
} from "./common";
export { serviceWithSchema, contextServiceWithSchema } from "./schema";

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

        let abortable: Abortable | null = null;
        try {
          requestCount.inc(requestMeta);

          const requestDeadline = first(req.headers["x-request-deadline"]);

          if (requestDeadline) {
            abortable = context.withDeadline(
              context.background,
              Date.parse(requestDeadline)
            );
          } else {
            abortable = context.withAbort(context.background);
          }

          const ctx = context.withValues(abortable.ctx, {
            [context.requestIdKey]:
              req.headers["x-request-id"] ||
              randomBytes(6).toString("base64url"),
          });

          onFinished(res as any, () => abortable?.abort());

          requestContexts.set(req.body, ctx);
          const result = await methodFn(req.body);

          res.json(result);
        } catch (err: any) {
          failureCount.inc(Object.assign({ type: err.type }, requestMeta));
          next(new RpcError(serviceName, methodName, err));
        } finally {
          end();
          abortable?.abort();
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

function first(s: string | string[] | undefined) {
  if (!s) return undefined;
  return Array.isArray(s) ? s[0] : s;
}
