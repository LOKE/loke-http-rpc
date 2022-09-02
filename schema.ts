import Ajv, { JTDSchemaType } from "ajv/dist/jtd";
import { ServiceSet, Service, ServiceDetails } from ".";

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
  }
): ServiceSet<Service> {
  const ajv = new Ajv();

  const implementation: {
    [methodName: string]: (args: unknown) => Promise<unknown>;
  } = {};

  const serviceDetails: ServiceDetails<unknown> = {
    service: serviceMeta.name,
    expose: [],
  };

  for (const [methodName, methodMeta] of Object.entries(serviceMeta.methods)) {
    const requestSchema = ajv.compile({
      definitions: serviceMeta?.definitions,
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
            msg =
              (err.instancePath
                ? err.instancePath.slice(1).replace(/\//g, ".") + " "
                : "") + err.message;
          }
        }

        throw new ValidationError(msg, params);
      }

      const result = await endpoint(args);

      if (!responseSchema(result)) {
        const errors = responseSchema.errors;
        console.log("result errors", errors);
        throw new Error("invalid response");
      }

      return result;
    };
  }

  return {
    implementation,
    meta: serviceDetails,
  };
}
