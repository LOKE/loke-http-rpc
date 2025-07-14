import Ajv, {
  ErrorObject,
  JTDSchemaType,
  ValidateFunction,
} from "ajv/dist/jtd";
import {
  ServiceSet,
  Service,
  ContextService,
  ServiceDetails,
  requestContexts,
} from "./common";

interface ValidationErrorParams {
  instancePath?: string;
  schemaPath?: string;
}

export const voidSchema = { metadata: { void: true } } as const;

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

type Methods<
  S extends Service,
  Def extends Record<string, unknown> = Record<string, never>,
> = {
  [K in keyof S]?: MethodDetails<
    Parameters<S[K]>[0],
    Awaited<ReturnType<S[K]>>,
    Def
  >;
};

type ContextMethods<
  S extends ContextService,
  Def extends Record<string, unknown> = Record<string, never>,
> = {
  [K in keyof S]?: MethodDetails<
    Parameters<S[K]>[1],
    Awaited<ReturnType<S[K]>>,
    Def
  >;
};

interface Logger {
  error: (str: string) => void;
}

export function contextServiceWithSchema<
  S extends ContextService,
  Def extends Record<string, unknown> = Record<string, never>,
>(
  service: S,
  serviceMeta: {
    name: string;
    definitions?: {
      [K in keyof Def]: JTDSchemaType<Def[K], Def>;
    };
    methods: ContextMethods<S, Def>;
    logger: Logger;
    strictResponseValidation?: boolean;
  },
): ServiceSet<any> {
  const wrappedService: Service = {};

  for (const methodName of Object.keys(serviceMeta.methods)) {
    wrappedService[methodName] = async (args: unknown) => {
      const ctx = requestContexts.get(args as object);
      if (!ctx) {
        throw new Error("missing request context");
      }

      return await service[methodName](ctx, args);
    };
  }

  return serviceWithSchema(wrappedService, serviceMeta);
}

export function serviceWithSchema<
  S extends Service,
  Def extends Record<string, unknown> = Record<string, never>,
>(
  service: S,
  serviceMeta: {
    name: string;
    definitions?: {
      [K in keyof Def]: JTDSchemaType<Def[K], Def>;
    };
    methods: Methods<S, Def>;
    logger: Logger;
    strictResponseValidation?: boolean;
  },
): ServiceSet<any> {
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

  const serviceDetails: ServiceDetails<S, Def> = {
    service: serviceMeta.name,
    definitions: serviceMeta.definitions,
    expose: [],
  };

  const {
    logger,
    strictResponseValidation = process.env.NODE_ENV !== "production",
  } = serviceMeta;

  const methods: [string, MethodDetails<unknown, unknown, Def>][] =
    Object.entries(serviceMeta.methods);

  for (const [methodName, methodMeta] of methods) {
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
    } catch (err: any) {
      throw new Error(
        `failed to compile "${methodName}" request schema: ${err.message}`,
      );
    }

    let responseSchema: ValidateFunction;
    try {
      responseSchema = ajv.compile({
        definitions: serviceMeta.definitions,
        ...methodMeta.responseTypeDef,
      });
    } catch (err: any) {
      throw new Error(
        `failed to compile "${methodName}" response schema: ${err.message}`,
      );
    }

    serviceDetails.expose.push({
      methodName,
      methodTimeout: methodMeta.methodTimeout,
      help: methodMeta.help,
      requestTypeDef: methodMeta.requestTypeDef,
      responseTypeDef: methodMeta.responseTypeDef,
    });

    const endpoint = service[methodName].bind(service);

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

/**
 * Formats an enhanced error message from an AJV JTD error object that includes
 * both the expected type/value and the actual received value.
 *
 * @param err - The AJV ErrorObject containing validation failure details
 * @param data - The original data that failed validation (optional)
 * @returns A human-readable error message with path, expected, and received values
 *
 * @example
 * // Type error
 * const err = { keyword: "type", params: { type: "string" }, instancePath: "/user/name", message: "must be string" };
 * const data = { user: { name: 123 } };
 * errorMessage(err, data);
 * // Returns: "user.name must be string, received number (123)"
 *
 * @example
 * // Enum error
 * const err = { keyword: "enum", params: { allowedValues: ["A", "B"] }, instancePath: "/status" };
 * const data = { status: "INVALID" };
 * errorMessage(err, data);
 * // Returns: "status must be one of [\"A\", \"B\"], received \"INVALID\""
 *
 * @example
 * // Missing property error
 * const err = { message: "must have property 'name'", instancePath: "" };
 * const data = { user: {} };
 * errorMessage(err, data);
 * // Returns: "must have property 'name', received {\"user\":{}}"
 */
function errorMessage(err: ErrorObject, data?: unknown): string {
  const pathPrefix = err.instancePath
    ? err.instancePath.slice(1).replace(/\//g, ".") + " "
    : "";

  // Get the actual value at the error path
  let actualValue: unknown;
  if (data && err.instancePath) {
    try {
      // Navigate to the actual value using the instance path
      const pathParts = err.instancePath.slice(1).split("/");
      actualValue = pathParts.reduce((obj: any, part) => {
        if (obj && typeof obj === "object") {
          return obj[part];
        }
        return undefined;
      }, data);
    } catch {
      actualValue = undefined;
    }
  }

  // Enhanced message based on error type
  let message = err.message || "";

  // For type errors, enhance with actual type received
  if (err.keyword === "type" && err.params && "type" in err.params) {
    const expectedType = err.params.type;
    const actualType = actualValue === null ? "null" : typeof actualValue;
    const actualValueStr =
      actualValue === undefined ? "undefined" : JSON.stringify(actualValue);

    message = `must be ${expectedType}, received ${actualType} (${actualValueStr})`;
  }
  // For enum errors, show expected values and what was received
  else if (
    err.keyword === "enum" &&
    err.params &&
    "allowedValues" in err.params
  ) {
    const allowedValues = err.params.allowedValues;
    const actualValueStr =
      actualValue === undefined ? "undefined" : JSON.stringify(actualValue);

    message = `must be one of [${allowedValues.map((v: any) => JSON.stringify(v)).join(", ")}], received ${actualValueStr}`;
  }
  // For other validation errors, try to include actual value if available
  else if (actualValue !== undefined) {
    const actualValueStr = JSON.stringify(actualValue);
    message = `${err.message}, received ${actualValueStr}`;
  }

  return pathPrefix + message;
}
