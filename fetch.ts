import { ServiceSet } from "./common";
import { createRoutes, toErrorResponse } from "./core";

export type FetchHandler = (request: Request) => Promise<Response>;

export interface CreateFetchHandlerOptions {
  /**
   * Path the handler is mounted at, stripped before routing. Set to "" when
   * serving rpc from the root of the server.
   */
  basePath?: string;
  /**
   * If true runs in legacy mode where only a single service is served from the root path.
   * Deprecated - do not use except for legacy scenarios.
   */
  legacy?: boolean;
  log?: (msg: string) => void;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body ?? null), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Creates a handler for servers that speak WHATWG Request/Response.
 */
export function createFetchHandler(
  services: ServiceSet<any>[],
  options: CreateFetchHandlerOptions = {},
): FetchHandler {
  const { basePath = "/rpc", legacy = false, log = () => undefined } = options;
  const routes = createRoutes(services, legacy);

  return async (request) => {
    const { pathname } = new URL(request.url);
    const path = pathname.startsWith(basePath)
      ? pathname.slice(basePath.length) || "/"
      : pathname;

    if (request.method === "GET" && routes.meta.has(path)) {
      return json(routes.meta.get(path));
    }

    const invoke =
      request.method === "POST" ? routes.methods.get(path) : undefined;
    if (!invoke) {
      return json({ message: `Not found: ${request.method} ${path}` }, 404);
    }

    const raw = await request.text();
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = null;
    }
    if (typeof body !== "object" || body === null) {
      return json({ message: "Request body must be a JSON object" }, 400);
    }

    try {
      // Return null for void result to help old clients
      return json(
        await invoke(body, {
          getHeader: (name) => request.headers.get(name) ?? undefined,
          signal: request.signal,
        }),
      );
    } catch (err) {
      const { status, body, logs } = toErrorResponse(err);
      for (const msg of logs) log(msg);
      return json(body, status);
    }
  };
}
