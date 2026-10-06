import { Histogram, Counter } from "prom-client";
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

// These types are shaped to be backwards compatible with Express — existing
// users can pass our handlers directly to app.use() without type errors.
// They can be made stricter in the next major version.
export interface RpcRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  path: string;
  body: object;
  on(event: "close", listener: () => void): void;
}

export interface RpcResponse {
  headersSent: boolean;
  json(body: unknown): void;
  status(code: number): this;
}

export type NextFunction = (err?: unknown) => void;

export type RequestHandler = (
  req: RpcRequest,
  res: RpcResponse,
  next: NextFunction,
) => void | Promise<void>;

export type ErrorRequestHandler = (
  err: any,
  req: RpcRequest,
  res: RpcResponse,
  next: NextFunction,
) => void;

export {
  ServiceSet,
  ServiceDetails,
  MethodDetails,
  Service,
  Method,
  ContextMethod,
  ContextService,
  UnionSchemaType,
} from "./common";

export {
  serviceWithSchema,
  contextServiceWithSchema,
  ContextMethods,
  voidSchema,
  VoidSchema,
} from "./schema";

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
      `An error occurred while executing method ${serviceName}/${methodName}`,
    );
    this.serviceName = serviceName;
    this.methodName = methodName;
    this.inner = inner;
  }
}

function getExposedMeta<Def extends Record<string, unknown>>(
  serviceDetails: ServiceDetails<Def>,
) {
  return {
    serviceName: serviceDetails.service,
    multiArg: false,
    help: serviceDetails.help || serviceDetails.service + " service",
    definitions: serviceDetails.definitions,
    interfaces: serviceDetails.expose.map((method: MethodDetails) => {
      if (typeof method === "string") {
        throw new Error(
          "Schema for expose has changed. Please refer to @loke/http-rpc documentation.",
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

interface DispatchRequest {
  body: object;
  headers: RpcRequest["headers"];
  onAbort(abort: () => void): () => void;
}

type DispatchHandler = (req: DispatchRequest) => Promise<unknown>;

function createDispatcher(
  services: ServiceSet<any>[],
  { legacy = false }: CreateRequestHandlerOptions = {},
) {
  if (legacy && services.length !== 1) {
    throw new Error("Only 1 service is supported in legacy mode");
  }

  const postHandlers = new Map<string, DispatchHandler>();
  const getHandlers = new Map<string, DispatchHandler>();

  const meta = {
    services: Object.values(services.map((s) => getExposedMeta(s.meta))),
  };

  getHandlers.set("/", async () => meta);

  for (const service of services) {
    const serviceName = service.meta.service;
    const serviceMeta = meta.services.find(
      (s) => s.serviceName === serviceName,
    );

    getHandlers.set(`/${serviceName}`, async () => serviceMeta);

    for (const methodDef of service.meta.expose) {
      const { methodName } = methodDef;
      const methodMeta = serviceMeta?.interfaces.find(
        (s) => s.methodName === methodName,
      );

      const getHandler: DispatchHandler = async () => methodMeta;
      getHandlers.set(`/${serviceName}/${methodName}`, getHandler);
      if (legacy) {
        getHandlers.set(`/${methodName}`, getHandler);
      }

      const requestMeta = { handler: `${serviceName}.${methodName}` };

      requestDuration.zero(requestMeta);
      requestCount.inc(requestMeta, 0);
      failureCount.inc({ type: "<none>", ...requestMeta }, 0);

      const methodFn = service.implementation[methodName].bind(
        service.implementation,
      );

      const postHandler: DispatchHandler = async (req) => {
        const end = requestDuration.startTimer(requestMeta);

        let abortable: Abortable | null = null;
        let removeAbortListener: () => void = () => undefined;
        try {
          requestCount.inc(requestMeta);

          const requestDeadline = first(req.headers["x-request-deadline"]);

          if (requestDeadline) {
            abortable = context.withDeadline(
              context.background,
              Date.parse(requestDeadline),
            );
          } else {
            abortable = context.withAbort(context.background);
          }

          const ctx = context.withValues(abortable.ctx, {
            [context.requestIdKey]:
              first(req.headers["x-request-id"]) ||
              randomBytes(6).toString("base64url"),
          });

          removeAbortListener = req.onAbort(abortable.abort);

          requestContexts.set(req.body, ctx);
          return await methodFn(req.body);
        } catch (err: any) {
          failureCount.inc({ type: err.type || "<none>", ...requestMeta });
          throw new RpcError(serviceName, methodName, err);
        } finally {
          end();
          abortable?.abort();
          removeAbortListener();
        }
      };

      postHandlers.set(`/${serviceName}/${methodName}`, postHandler);
      if (legacy) {
        postHandlers.set(`/${methodName}`, postHandler);
      }
    }
  }

  return (method: string | undefined, path: string) => {
    switch (method) {
      case "GET":
        return getHandlers.get(path);
      case "POST":
        return postHandlers.get(path);
    }
  };
}

export function createRequestHandler(
  services: ServiceSet<any>[],
  options?: CreateRequestHandlerOptions,
): RequestHandler {
  const dispatch = createDispatcher(services, options);
  return async (req, res, next) => {
    const handler = dispatch(req.method, req.path);
    if (!handler) return next();
    void handler({
      body: req.body,
      headers: req.headers,
      onAbort: (abort) => {
        onFinished(res as any, abort);
        return () => undefined;
      },
    }).then((result) => res.json(result ?? null), next);
  };
}

export function createFetchHandler(
  services: ServiceSet<any>[],
  options: { legacy?: boolean; log?: (msg: string) => void } = {},
): (request: Request) => Promise<Response> {
  const dispatch = createDispatcher(services, options);
  const log = options.log || (() => undefined);
  return async (request) => {
    try {
      const handler = dispatch(request.method, new URL(request.url).pathname);
      if (!handler)
        return Response.json({ message: "Not Found" }, { status: 404 });
      let body: object = {};
      const contentType = request.headers
        .get("content-type")
        ?.split(";")[0]
        .trim()
        .toLowerCase();
      if (request.method === "POST" && contentType === "application/json") {
        const text = await request.text();
        try {
          const parsed: unknown = text ? JSON.parse(text) : {};
          if (parsed === null || typeof parsed !== "object") {
            return Response.json({ message: "Invalid JSON" }, { status: 400 });
          }
          body = parsed;
        } catch (err) {
          if (!(err instanceof SyntaxError)) throw err;
          return Response.json({ message: "Invalid JSON" }, { status: 400 });
        }
      }
      const result = await handler({
        body,
        headers: {
          "x-request-deadline":
            request.headers.get("x-request-deadline") ?? undefined,
          "x-request-id": request.headers.get("x-request-id") ?? undefined,
        },
        onAbort: (abort) => {
          request.signal.addEventListener("abort", abort, { once: true });
          if (request.signal.aborted) abort();
          return () => request.signal.removeEventListener("abort", abort);
        },
      });
      return Response.json(result ?? null);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const { status, body } = mapError(error, log);
      return Response.json(body, { status });
    }
  };
}

function mapError(
  err: Error & Partial<Pick<RpcError, "serviceName" | "methodName">>,
  log: (msg: string) => void,
) {
  const source = `${err.serviceName}/${err.methodName}`;
  if (!(err instanceof RpcError)) {
    log(`Internal error executing ${source}: ${err.stack || err.message}`);
    return { status: 500, body: { message: err.message } };
  }
  log(`Error executing ${source}: ${err.inner.stack}`);
  if (!err.inner.type) {
    log(
      `Legacy error returned from ${source}: name=${err.inner.name}, code=${err.inner.code}`,
    );
    return {
      status: 400,
      body: { message: err.inner.message, code: err.inner.code },
    };
  }
  return { status: 400, body: err.inner };
}

export function createErrorHandler(
  args: { log?: (msg: string) => void } = {},
): ErrorRequestHandler {
  const { log = () => undefined } = args;

  // Express v5: Error handling middleware must have exactly 4 parameters
  // Express v5: ErrorRequestHandler return type must be void (not the result of res.json())
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (err, req, res, next) => {
    // Express v5: If headers have already been sent, delegate to default error handler
    if (res.headersSent) {
      return next(err);
    }

    const { status, body } = mapError(err, log);
    res.status(status).json(body);
  };
}

function first(s: string | string[] | undefined) {
  if (!s) return undefined;
  return Array.isArray(s) ? s[0] : s;
}
