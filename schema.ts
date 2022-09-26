import Ajv, { ErrorObject, JTDSchemaType } from "ajv/dist/jtd";
import { ServiceSet, Service, ServiceDetails } from "./common";

interface ValidationErrorParams {
  instancePath?: string;
  schemaPath?: string;
}

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

    this.code = "validation";
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
  Def extends Record<string, unknown> = Record<string, never>
> {
  methodTimeout?: number;
  help?: string;
  requestTypeDef?: JTDSchemaType<Req, Def>;
  responseTypeDef?: JTDSchemaType<Res, Def>;
}

type Methods<
  S extends Service,
  Def extends Record<string, unknown> = Record<string, never>
> = {
  [K in keyof S]?: MethodDetails<
    Parameters<S[K]>[0],
    Awaited<ReturnType<S[K]>>,
    Def
  >;
};

interface Logger {
  error: (str: string) => void;
}

export function serviceWithSchema<
  S extends Service,
  Def extends Record<string, unknown> = Record<string, never>
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
  }
): ServiceSet<any> {
  const ajv = new Ajv();

  const implementation: {
    [methodName: string]: (args: unknown) => Promise<unknown>;
  } = {};

  const serviceDetails: ServiceDetails<S, Def> = {
    service: serviceMeta.name,
    definitions: serviceMeta?.definitions,
    expose: [],
  };

  const {
    logger,
    strictResponseValidation = process.env.NODE_ENV !== "production",
  } = serviceMeta;

  for (const [methodName, methodMeta] of Object.entries(serviceMeta.methods)) {
    const requestSchema = ajv.compile({
      definitions: serviceMeta?.definitions,
      // Be liberal in what we accept, but let the consumer service force strict
      // if needed
      // https://en.wikipedia.org/wiki/Robustness_principle
      additionalProperties: true,
      ...methodMeta?.requestTypeDef,
    });

    const responseSchema = ajv.compile({
      definitions: serviceMeta?.definitions,
      ...methodMeta?.responseTypeDef,
    });

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
            msg = errorMessage(err);
          }
        }

        throw new ValidationError(msg, params);
      }

      const result = await endpoint(args);

      if (!responseSchema(result)) {
        const errors = responseSchema.errors;

        if (strictResponseValidation) {
          const errors = requestSchema.errors;
          let msg = "response schema validation error";

          const params: ValidationErrorParams = {};
          if (Array.isArray(errors)) {
            const err = errors[0];
            if (err) {
              params.instancePath = err.instancePath;
              params.schemaPath = err.schemaPath;
              msg = errorMessage(err);
            }
          }

          throw new ResponseValidationError(msg, params);
        } else {
          logger.error(
            `rpc response schema validation errors: ${JSON.stringify(errors)}`
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

function errorMessage(err: ErrorObject): string {
  return (
    (err.instancePath
      ? err.instancePath.slice(1).replace(/\//g, ".") + " "
      : "") + err.message
  );
}
