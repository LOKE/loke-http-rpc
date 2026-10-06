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

type AnyMethod = (...args: never[]) => unknown;

// every method key, not just the well shaped ones: a mapped type over zero keys
// collapses to {} and silently accepts anything
type MethodKeys<S> = {
  [K in keyof S]-?: NonNullable<S[K]> extends AnyMethod ? K : never;
}[keyof S];

// the permissive schema props keep the only complaint on the missing marker, so
// the error lands on the method name and reads as the message
type WrongShape<Message extends string> = {
  [K in Message]: never;
} & Partial<Record<keyof MethodDetails<never, never>, unknown>>;

type MethodSchema<
  Fn extends AnyMethod,
  ArgIndex extends 0 | 1,
  Def extends Record<string, unknown>,
> = MethodDetails<Parameters<Fn>[ArgIndex], Awaited<ReturnType<Fn>>, Def>;

type Methods<
  S extends object,
  Def extends Record<string, unknown> = Record<string, never>,
> = {
  [K in MethodKeys<S>]?: NonNullable<S[K]> extends Method
    ? MethodSchema<Extract<NonNullable<S[K]>, Method>, 0, Def>
    : WrongShape<`${K & string} takes a Context first, use contextServiceWithSchema`>;
};

export type ContextMethods<
  S extends object,
  Def extends Record<string, unknown> = Record<string, never>,
> = {
  [K in MethodKeys<S>]?: NonNullable<S[K]> extends ContextMethod
    ? MethodSchema<Extract<NonNullable<S[K]>, ContextMethod>, 1, Def>
    : WrongShape<`${K & string} must accept a Context as its first argument`>;
};

interface Logger {
  error: (str: string) => void;
}

interface ServiceMeta<Def extends Record<string, unknown>, M> {
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
>(service: S, serviceMeta: ServiceMeta<Def, M>): ServiceSet<Service> {
  // ContextMethods has already rejected anything that isn't this shape
  const methods = service as Record<string, ContextMethod>;

  return createServiceWithSchema(serviceMeta, (methodName) => {
    return async (args: unknown) => {
      if (typeof args !== "object" || args === null) {
        throw new Error("missing request context");
      }

      const ctx = requestContexts.get(args);
      if (!ctx) {
        throw new Error("missing request context");
      }

      return await methods[methodName](ctx, args);
    };
  });
}

export function serviceWithSchema<
  S extends object,
  Def extends Record<string, unknown> = Record<string, never>,
  M extends Methods<S, Def> = Methods<S, Def>,
>(service: S, serviceMeta: ServiceMeta<Def, M>): ServiceSet<Service> {
  // Methods has already rejected anything that isn't this shape
  const methods = service as Record<string, Method>;

  return createServiceWithSchema(serviceMeta, (methodName) =>
    methods[methodName].bind(service),
  );
}

function asMethodDetails<Def extends Record<string, unknown>>(
  value: unknown,
): MethodDetails<unknown, unknown, Def> | undefined {
  return typeof value === "object" && value !== null
    ? (value as MethodDetails<unknown, unknown, Def>)
    : undefined;
}

// Shared: each instance compiles the JTD meta-schema on first use (~75ms), once per service otherwise.
const ajv = new Ajv({
  keywords: [
    {
      keyword: "void",
      validate: (_: unknown, data: unknown) => data === undefined,
      errors: false,
    },
  ],
});

function createServiceWithSchema<Def extends Record<string, unknown>>(
  serviceMeta: ServiceMeta<Def, Record<string, unknown>>,
  getEndpoint: (methodName: string) => Method,
): ServiceSet<Service> {
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

  for (const [methodName, value] of Object.entries(serviceMeta.methods)) {
    const methodMeta = asMethodDetails<Def>(value);
    if (!methodMeta) {
      continue;
    }

    const requestSchema = compileOnFirstUse(`"${methodName}" request schema`, {
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

    const responseSchema = compileOnFirstUse(
      `"${methodName}" response schema`,
      {
        definitions: serviceMeta.definitions,
        ...methodMeta.responseTypeDef,
      },
    );

    serviceDetails.expose.push({
      methodName,
      methodTimeout: methodMeta.methodTimeout,
      help: methodMeta.help,
      requestTypeDef: methodMeta.requestTypeDef,
      responseTypeDef: methodMeta.responseTypeDef,
    });

    const endpoint = getEndpoint(methodName);

    implementation[methodName] = async (args: unknown) => {
      const validateRequest = requestSchema();
      if (!validateRequest(args)) {
        const errors = validateRequest.errors;
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

      const validateResponse = responseSchema();
      if (!validateResponse(result)) {
        const errors = validateResponse.errors;

        if (strictResponseValidation) {
          const errors = validateResponse.errors;
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

// Compiling every method up front costs ~200ms of startup in large services.
function compileOnFirstUse(
  label: string,
  schema: Record<string, unknown>,
): () => ValidateFunction {
  let validate: ValidateFunction | undefined;
  return () => {
    if (!validate) {
      try {
        validate = ajv.compile(schema);
      } catch (err) {
        throw new Error(`failed to compile ${label}: ${errorDescription(err)}`);
      }
    }
    return validate;
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
