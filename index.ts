import onFinished from "on-finished";
import { ServiceSet } from "./common";
import { createRoutes, toErrorResponse } from "./core";

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

export { RpcError } from "./core";

export {
  createFetchHandler,
  CreateFetchHandlerOptions,
  FetchHandler,
} from "./fetch";

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

interface CreateRequestHandlerOptions {
  /**
   * If true runs in legacy mode where only a single service is served from the root path.
   * Deprecated - do not use except for legacy scenarios.
   */
  legacy?: boolean;
}

export function createRequestHandler(
  services: ServiceSet<any>[],
  options?: CreateRequestHandlerOptions,
): RequestHandler {
  const { legacy = false } = options || {};
  const routes = createRoutes(services, legacy);

  return async (req, res, next) => {
    switch (req.method) {
      case "GET": {
        if (!routes.meta.has(req.path)) return next();
        res.json(routes.meta.get(req.path));
        return;
      }
      case "POST": {
        const invoke = routes.methods.get(req.path);
        if (!invoke) return next();

        const controller = new AbortController();
        onFinished(res as any, () => controller.abort());

        try {
          const result = await invoke(req.body, {
            getHeader: (name) => first(req.headers[name]),
            signal: controller.signal,
          });
          // Return null for void result to help old clients
          res.json(result ?? null);
        } catch (err) {
          next(err);
        }
        return;
      }
      default:
        return next();
    }
  };
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

    const { status, body, logs } = toErrorResponse(err);
    for (const msg of logs) log(msg);
    // Express v5: Don't return the result of res.json() - just call it
    res.status(status).json(body);
  };
}

function first(s: string | string[] | undefined) {
  if (!s) return undefined;
  return Array.isArray(s) ? s[0] : s;
}
