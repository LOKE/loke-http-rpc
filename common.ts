import { JTDSchemaType } from "ajv/dist/jtd";
import { Context } from "@loke/context";

export const requestContexts = new WeakMap<object, Context>();

export type Method<A = any, R = any> = (args: A) => R;
export type ContextMethod<A = any, R = any> = (ctx: Context, args: A) => R;

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

export interface ContextService {
  [methodName: string]: ContextMethod;
}

export interface ServiceSet<S extends Service> {
  implementation: S;
  meta: ServiceDetails<S, any>;
}
