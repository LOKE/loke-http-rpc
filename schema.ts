import Ajv, {
  ErrorObject,
  JTDSchemaType,
  ValidateFunction,
} from "ajv/dist/jtd";
import {
  ServiceSet,
  Service,
  ContextMethod,
  ServiceDetails,
  requestContexts,
  UnionSchemaType,
  Method,
} from "./common";

interface ValidationErrorParams {
  instancePath?: string;
  schemaPath?: string;
}

export const voidSchema: { readonly metadata: { readonly void: true } } = {
  metadata: { void: true },
};

export type VoidSchema = typeof voidSchema;

class ValidationError extends Error {
  type: string;
  code: string;
  instancePath?: string;
  schemaPath?: string;

  constructor(message: string, params: ValidationErrorParams) {
    super(message);

    this.code = "validation";
    this.type = "https://errors.loke.global/@loke/http-rpc/validation";
    Object.defineProperty(this, "message", {
      enumerable: true,
      value: message,
    });

    Object.assign(this, params);
  }
}

class ResponseValidationError extends Error {
  type: string;
  code: string;
  instancePath?: string;
  schemaPath?: string;

  constructor(message: string, params: ValidationErrorParams) {
    super(message);

    this.code = "response-validation";
    this.type = "https://errors.loke.global/@loke/http-rpc/response-validation";
    Object.defineProperty(this, "message", {
      enumerable: true,
      value: message,
    });

    Object.assign(this, params);
  }
}

export interface MethodDetails<
  Req,
  Res,
  Def extends Record<string, unknown> = Record<string, never>,
> {
  methodTimeout?: number;
  help?: string;
  requestTypeDef?: JTDSchemaType<Req, Def>;
  responseTypeDef?: JTDSchemaType<Res, Def> | VoidSchema;
}

type ServiceMethodKeys<S> = {
  [K in keyof S]-?: NonNullable<S[K]> extends Method ? K : never;
}[keyof S];

type ContextMethodKeys<S> = {
  [K in keyof S]-?: NonNullable<S[K]> extends ContextMethod ? K : never;
}[keyof S];

type ServiceMethod<S, K extends keyof S> =
  NonNullable<S[K]> extends Method ? NonNullable<S[K]> : never;

type ContextServiceMethod<S, K extends keyof S> =
  NonNullable<S[K]> extends ContextMethod ? NonNullable<S[K]> : never;

type Methods<
  S extends object,
  Def extends Record<string, unknown> = Record<string, never>,
> = {
  [K in ServiceMethodKeys<S>]?: MethodDetails<
    Parameters<ServiceMethod<S, K>>[0],
    Awaited<ReturnType<ServiceMethod<S, K>>>,
    Def
  >;
};

export type ContextMethods<
  S extends object,
  Def extends Record<string, unknown> = Record<string, never>,
> = {
  [K in ContextMethodKeys<S>]?: MethodDetails<
    Parameters<ContextServiceMethod<S, K>>[1],
    Awaited<ReturnType<ContextServiceMethod<S, K>>>,
    Def
  >;
};

type RuntimeMethods<Def extends Record<string, unknown>> = {
  [K in string]?: MethodDetails<unknown, unknown, Def>;
};

interface Logger {
  error: (str: string) => void;
}

interface ServiceMeta<
  Def extends Record<string, unknown>,
  M extends RuntimeMethods<Def>,
> {
  name: string;
  definitions?: {
    [K in keyof Def]: JTDSchemaType<Def[K], Def> | UnionSchemaType<Def[K], Def>;
  };
  methods: M;
  logger: Logger;
  strictResponseValidation?: boolean;
}

export function contextServiceWithSchema<
  S extends object,
  Def extends Record<string, unknown> = Record<string, never>,
  M extends ContextMethods<S, Def> = ContextMethods<S, Def>,
>(
  service: S & { [K in keyof M]-?: ContextMethod },
  serviceMeta: ServiceMeta<Def, M>,
): ServiceSet<Service> {
  return createServiceWithSchema(serviceMeta, (methodName) => {
    return async (args: unknown) => {
      if (typeof args !== "object" || args === null) {
        throw new Error("missing request context");
      }

      const ctx = requestContexts.get(args);
      if (!ctx) {
        throw new Error("missing request context");
      }

      return await service[methodName](ctx, args);
    };
  });
}

export function serviceWithSchema<
  S extends object,
  Def extends Record<string, unknown> = Record<string, never>,
  M extends Methods<S, Def> = Methods<S, Def>,
>(
  service: S & { [K in keyof M]-?: Method },
  serviceMeta: ServiceMeta<Def, M>,
): ServiceSet<Service> {
  return createServiceWithSchema(serviceMeta, (methodName) =>
    service[methodName].bind(service),
  );
}

function createServiceWithSchema<
  Def extends Record<string, unknown>,
  M extends RuntimeMethods<Def>,
>(
  serviceMeta: ServiceMeta<Def, M>,
  getEndpoint: (methodName: keyof M & string) => Method,
): ServiceSet<Service> {
  const ajv = new Ajv({
    keywords: [
      {
        keyword: "void",
        validate: (_: unknown, data: unknown) => data === undefined,
        errors: false,
      },
    ],
  });

  const implementation: {
    [methodName: string]: (args: unknown) => Promise<unknown>;
  } = {};

  const serviceDetails: ServiceDetails<Service, Def> = {
    service: serviceMeta.name,
    definitions: serviceMeta.definitions,
    expose: [],
  };

  const {
    logger,
    strictResponseValidation = process.env.NODE_ENV !== "production",
  } = serviceMeta;

  for (const methodName in serviceMeta.methods) {
    const methodMeta = serviceMeta.methods[methodName];
    if (!methodMeta) {
      continue;
    }

    let requestSchema: ValidateFunction;
    try {
      requestSchema = ajv.compile({
        definitions: serviceMeta.definitions,
        // Be liberal in what we accept, but let the consumer service force strict
        // if needed
        // https://en.wikipedia.org/wiki/Robustness_principle
        // this is a bit of a mess, default to additionalProperties true if schema has properties
        ...("properties" in (methodMeta.requestTypeDef || {})
          ? { additionalProperties: true }
          : undefined),

        ...methodMeta.requestTypeDef,
      });
    } catch (err) {
      throw new Error(
        `failed to compile "${methodName}" request schema: ${errorDescription(
          err,
        )}`,
      );
    }

    let responseSchema: ValidateFunction;
    try {
      responseSchema = ajv.compile({
        definitions: serviceMeta.definitions,
        ...methodMeta.responseTypeDef,
      });
    } catch (err) {
      throw new Error(
        `failed to compile "${methodName}" response schema: ${errorDescription(
          err,
        )}`,
      );
    }

    serviceDetails.expose.push({
      methodName,
      methodTimeout: methodMeta.methodTimeout,
      help: methodMeta.help,
      requestTypeDef: methodMeta.requestTypeDef,
      responseTypeDef: methodMeta.responseTypeDef,
    });

    const endpoint = getEndpoint(methodName);

    implementation[methodName] = async (args: unknown) => {
      if (!requestSchema(args)) {
        const errors = requestSchema.errors;
        let msg = "request schema validation error";

        const params: ValidationErrorParams = {};
        if (Array.isArray(errors)) {
          const err = errors[0];
          if (err) {
            params.instancePath = err.instancePath;
            params.schemaPath = err.schemaPath;
            msg = errorMessage(err, args);
          }
        }

        throw new ValidationError(msg, params);
      }

      const result = await endpoint(args);

      if (!responseSchema(result)) {
        const errors = responseSchema.errors;

        if (strictResponseValidation) {
          const errors = responseSchema.errors;
          let msg = "response schema validation error";

          const params: ValidationErrorParams = {};
          if (Array.isArray(errors)) {
            const err = errors[0];
            if (err) {
              params.instancePath = err.instancePath;
              params.schemaPath = err.schemaPath;
              msg = errorMessage(err, result);
            }
          }

          throw new ResponseValidationError(msg, params);
        } else {
          logger.error(
            `rpc response schema validation errors: ${
              serviceMeta.name
            }.${methodName} ${JSON.stringify(errors)}`,
          );
        }
      }

      return result;
    };
  }

  return {
    implementation,
    meta: serviceDetails,
  };
}

function errorDescription(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// errorMessage formats an error message from an AJV JTD error object
// example
//   { message : "must be string", instancePath : "/user/name" }
// becomes
//   "user.name must be string, received number"
function errorMessage(err: ErrorObject, data?: unknown): string {
  let received = "";
  if (data !== undefined && err.instancePath) {
    const parts = err.instancePath.slice(1).split("/");
    let current: unknown = data;
    for (const part of parts) {
      if (current === null || typeof current !== "object") {
        current = undefined;
        break;
      }
      current = Reflect.get(current, part);
    }
    if (current !== undefined) {
      const t = Array.isArray(current)
        ? "array"
        : current === null
          ? "null"
          : typeof current;
      // Show the actual value for non-string primitives (numbers, booleans).
      // For strings, objects, and arrays only show the type to avoid logging PII.
      const detail = t === "number" || t === "boolean" ? String(current) : t;
      received = `, received ${detail}`;
    }
  }
  return (
    (err.instancePath
      ? `${err.instancePath.slice(1).replace(/\//g, ".")} `
      : "") +
    err.message +
    received
  );
}
