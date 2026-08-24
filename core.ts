import { Histogram, Counter } from "prom-client";
import * as context from "@loke/context";
import { randomBytes } from "crypto";
import {
  ServiceSet,
  ServiceDetails,
  MethodDetails,
  requestContexts,
} from "./common";

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

export type Invoke = (
  body: object,
  options: {
    getHeader: (name: string) => string | undefined;
    /** Aborted when the caller goes away, so the method Context is cancelled. */
    signal?: AbortSignal;
  },
) => Promise<unknown>;

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

/**
 * Transport independent routing table: paths to the metadata served for GET,
 * and paths to the method invokers used for POST.
 */
export function createRoutes(services: ServiceSet<any>[], legacy: boolean) {
  if (legacy && services.length !== 1) {
    throw new Error("Only 1 service is supported in legacy mode");
  }

  const meta = new Map<string, unknown>();
  const methods = new Map<string, Invoke>();

  const rootMeta = {
    services: Object.values(services.map((s) => getExposedMeta(s.meta))),
  };

  meta.set("/", rootMeta);

  for (const service of services) {
    const serviceName = service.meta.service;
    const serviceMeta = rootMeta.services.find(
      (s) => s.serviceName === serviceName,
    );

    meta.set(`/${serviceName}`, serviceMeta);

    for (const methodDef of service.meta.expose) {
      const { methodName } = methodDef;
      const methodMeta = serviceMeta?.interfaces.find(
        (s) => s.methodName === methodName,
      );

      meta.set(`/${serviceName}/${methodName}`, methodMeta);
      if (legacy) {
        meta.set(`/${methodName}`, methodMeta);
      }

      const requestMeta = { handler: `${serviceName}.${methodName}` };

      requestDuration.zero(requestMeta);
      requestCount.inc(requestMeta, 0);
      failureCount.inc({ type: "<none>", ...requestMeta }, 0);

      const methodFn = service.implementation[methodName].bind(
        service.implementation,
      );

      const invoke: Invoke = async (body, { getHeader, signal }) => {
        const end = requestDuration.startTimer(requestMeta);

        let abortable: context.Abortable | null = null;
        const onAbort = () => abortable?.abort();
        try {
          requestCount.inc(requestMeta);

          const requestDeadline = getHeader("x-request-deadline");

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
              getHeader("x-request-id") || randomBytes(6).toString("base64url"),
          });

          signal?.addEventListener("abort", onAbort, { once: true });

          requestContexts.set(body, ctx);
          return await methodFn(body);
        } catch (err: any) {
          failureCount.inc({ type: err.type || "<none>", ...requestMeta });
          throw new RpcError(serviceName, methodName, err);
        } finally {
          signal?.removeEventListener("abort", onAbort);
          end();
          abortable?.abort();
        }
      };

      methods.set(`/${serviceName}/${methodName}`, invoke);
      if (legacy) {
        methods.set(`/${methodName}`, invoke);
      }
    }
  }

  return { meta, methods };
}

export function toErrorResponse(err: any) {
  const source = `${err.serviceName}/${err.methodName}`;

  if (!(err instanceof RpcError)) {
    return {
      status: 500,
      body: { message: err.message },
      logs: [`Internal error executing ${source}: ${err.stack || err.message}`],
    };
  }

  const logs = [`Error executing ${source}: ${err.inner.stack}`];

  if (!err.inner.type) {
    logs.push(
      `Legacy error returned from ${source}: name=${err.inner.name}, code=${err.inner.code}`,
    );
    return {
      status: 400,
      body: { message: err.inner.message, code: err.inner.code },
      logs,
    };
  }

  return { status: 400, body: err.inner, logs };
}
