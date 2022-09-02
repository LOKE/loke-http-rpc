import { JTDSchemaType } from "ajv/dist/jtd";

export type Method<A = any, R = any> = (args: A) => R;

export interface MethodDetails {
  methodName: string;
  methodTimeout?: number;
  help?: string;
  paramNames?: string[];
  requestTypeDef?: JTDSchemaType<any, any>;
  responseTypeDef?: JTDSchemaType<any, any>;
}

export interface ServiceDetails<
  S,
  Def extends Record<string, unknown> = Record<string, never>
> {
  expose: MethodDetails[];
  service: string;
  help?: string;
  path?: string;
  definitions?: {
    [K in keyof Def]: JTDSchemaType<Def[K], Def>;
  };
}

export interface Service {
  [methodName: string]: Method;
}

export interface ServiceSet<S extends Service> {
  implementation: S;
  meta: ServiceDetails<S>;
}
