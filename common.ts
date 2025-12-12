import { JTDSchemaType } from "ajv/dist/jtd";
import { Context } from "@loke/context";

export const requestContexts = new WeakMap<object, Context>();

export type Method<A = any, R = any> = (args: A) => R;

/**
 * Strict type equality check that distinguishes between structurally similar types.
 * Returns true only if A and B are exactly the same type.
 */
type StrictEquals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;

/**
 * Checks if Member is strictly equal to any member of Union.
 * Distributes over Union and returns true if any member matches, never otherwise.
 */
type IsStrictUnionMember<Member, Union> = Union extends unknown
  ? StrictEquals<Member, Union> extends true
    ? true
    : never
  : never;

/**
 * Returns true if Member is strictly equal to some member of Union.
 */
type IsValidUnionRef<Member, Union> = true extends IsStrictUnionMember<Member, Union>
  ? true
  : false;

/**
 * Type for defining union schemas using metadata.
 * The refs must point to types in Defs that are strictly equal to a member of union type T.
 * This uses strict type equality to prevent structurally compatible but semantically
 * different types from being accepted.
 *
 * @example
 * ```typescript
 * type OrderingConfigMeta = KountaMeta | ZonalMeta | PublicApiMeta;
 *
 * // In definitions:
 * OrderingConfigMeta: {
 *   metadata: {
 *     union: [
 *       { ref: "KountaMeta" },
 *       { ref: "PublicApiMeta" },
 *       { ref: "ZonalMeta" },
 *     ],
 *   },
 * }
 * ```
 */
export type UnionSchemaType<T, Defs extends Record<string, unknown>> = {
  metadata: {
    union: Array<{
      ref: {
        [K in keyof Defs & string]: IsValidUnionRef<Defs[K], T> extends true ? K : never;
      }[keyof Defs & string];
    }>;
  };
};
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
  S, // eslint-disable-line @typescript-eslint/no-unused-vars
  Def extends Record<string, unknown> = Record<string, never>,
> {
  expose: MethodDetails[];
  service: string;
  help?: string;
  path?: string;
  definitions?: {
    [K in keyof Def]: JTDSchemaType<Def[K], Def> | UnionSchemaType<Def[K], Def>;
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
