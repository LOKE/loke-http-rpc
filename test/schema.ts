import test from "ava";
import http from "http";
import express, { Express } from "express";
import bodyParser from "body-parser";
import got, { HTTPError } from "got";
import { Context } from "@loke/context";
import * as context from "@loke/context";
import {
  createErrorHandler,
  createRequestHandler,
  serviceWithSchema,
  contextServiceWithSchema,
  voidSchema,
} from "../";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const inspect = (req: any, res: any, next: () => void) => {
  next();
};

function createServerAddress(app: Express) {
  const server = http.createServer(app);

  server.listen(0);

  const address = server.address();
  if (!address || typeof address !== "object") {
    throw new Error("No server address found");
  }

  return `http://localhost:${address.port}`;
}

test("should validate schemas", async (t) => {
  const app = express();

  const untypedService = {
    foo: (x: { msg: string }) => {
      return `success ${x.msg}`;
    },
  };

  const service1 = {
    bar: async (x: { message: string; user: User; thing: any }) => {
      return x.user;
    },
  };

  class Service2Imp {
    async baz(x: { msg: string; user?: User }) {
      return `success ${x.msg}`;
    }
    async badResponse(): Promise<User> {
      return ({ username: 123 } as unknown) as User;
    }
    async refReq(): Promise<User> {
      throw new Error("for types only");
    }
    async voidSchema(args: { bad?: boolean }) {
      if (args.bad) {
        return 1 as any; // bad void
      }
      return;
    }
    async noSchema() {
      return;
    }
    async unlisted() {
      return;
    }
  }

  type Service2 = {
    baz: (x: { msg: string; user?: User }) => Promise<string>;
    refReq: (x: User) => Promise<User>;
    badResponse: () => Promise<User>;
    voidSchema: (args: { bad?: boolean }) => Promise<void>;
    noSchema: () => Promise<void>;
    unlisted: () => Promise<void>;
  };

  //   interface Service2 {
  //     baz: (x: { msg: string; user?: User }) => Promise<string>;
  //   }

  const service2: Service2 = new Service2Imp();

  interface User {
    name: string;
  }

  type Defs = { User: User };

  app.use(
    "/rpc",
    bodyParser.json() as any,
    inspect,
    createRequestHandler([
      {
        implementation: untypedService,
        meta: { service: "untypedService", expose: [{ methodName: "foo" }] },
      },
      serviceWithSchema<typeof service1, Defs>(service1, {
        name: "service1",
        definitions: {
          User: {
            properties: {
              name: { type: "string" },
            },
          },
        },
        methods: {
          bar: {
            requestTypeDef: {
              properties: {
                message: { type: "string" },
                user: { ref: "User" },
              },
              optionalProperties: {
                thing: {},
              },
            },
            responseTypeDef: { ref: "User" },
          },
        },
        logger: { error: t.log },
      }),
      serviceWithSchema<Service2, Defs>(service2, {
        name: "service2",
        definitions: {
          User: {
            properties: {
              name: { type: "string" },
            },
          },
        },
        methods: {
          baz: {
            requestTypeDef: {
              properties: {
                msg: { type: "string" },
              },
              optionalProperties: {
                user: { ref: "User" },
              },
            },
            responseTypeDef: { type: "string" },
          },
          badResponse: {
            responseTypeDef: { ref: "User" },
          },
          refReq: {
            requestTypeDef: { ref: "User" },
            responseTypeDef: { ref: "User" },
          },
          voidSchema: {
            responseTypeDef: voidSchema,
          },
          noSchema: {},
        },
        logger: { error: t.log },
      }),
    ]),
    createErrorHandler()
  );

  const serverAddress = createServerAddress(app);

  const body = await got
    .post(`${serverAddress}/rpc/service1/bar`, {
      json: { message: "world", user: { name: "1" } },
    })
    .json();

  t.deepEqual(body, { name: "1" });

  // Methods with void schema should work
  await got
    .post(`${serverAddress}/rpc/service2/voidSchema`, {
      json: {},
    })
    .json();

  // Methods with no schema should still work
  await got
    .post(`${serverAddress}/rpc/service2/noSchema`, {
      json: {},
    })
    .json();

  // Methods with invalid requests should fail
  {
    const err: HTTPError = await t.throwsAsync(() =>
      got
        .post(`${serverAddress}/rpc/service1/bar`, {
          json: { message: "c", user: { name: 1 } },
        })
        .json()
    );

    t.deepEqual(JSON.parse(err.response.body as string), {
      message: "user.name must be string",
      code: "validation",
      type: "https://errors.loke.global/@loke/http-rpc/validation",
      instancePath: "/user/name",
      schemaPath: "/definitions/User/properties/name/type",
    });
  }

  // Methods with invalid void should fail
  {
    const err: HTTPError = await t.throwsAsync(() =>
      got
        .post(`${serverAddress}/rpc/service2/voidSchema`, {
          json: { bad: true },
        })
        .json()
    );

    t.deepEqual(JSON.parse(err.response.body as string), {
      message: "must return void",
      code: "response-validation",
      type: "https://errors.loke.global/@loke/http-rpc/response-validation",
      instancePath: "",
      schemaPath: "",
    });
  }

  // Methods with invalid response should fail (can be turned off)
  {
    const err: HTTPError = await t.throwsAsync(() =>
      got
        .post(`${serverAddress}/rpc/service2/badResponse`, {
          json: {},
        })
        .json()
    );

    t.deepEqual(JSON.parse(err.response.body as string), {
      message: "must have property 'name'",
      code: "response-validation",
      type: "https://errors.loke.global/@loke/http-rpc/response-validation",
      instancePath: "",
      schemaPath: "/definitions/User/properties/name",
    });
  }

  // Unlisted methods should fail
  await t.throwsAsync(() =>
    got
      .post(`${serverAddress}/rpc/service2/unlisted`, {
        json: {},
      })
      .json()
  );
});

test("test context", async (t) => {
  const app = express();

  let lastReqId: string | undefined;
  let lastDeadline: number | undefined;

  const service1 = {
    bar: async (
      ctx: Context,
      args: { message: string; user: User; thing: any }
    ) => {
      lastReqId = context.getRequestId(ctx);
      lastDeadline = ctx.deadline;
      return args.user;
    },
  };

  interface User {
    name: string;
  }

  type Defs = { User: User };

  app.use(
    "/rpc",
    bodyParser.json() as any,
    inspect,
    createRequestHandler([
      contextServiceWithSchema<typeof service1, Defs>(service1, {
        name: "service1",
        definitions: {
          User: {
            properties: {
              name: { type: "string" },
            },
          },
        },
        methods: {
          bar: {
            requestTypeDef: {
              properties: {
                message: { type: "string" },
                user: { ref: "User" },
              },
              optionalProperties: {
                thing: {},
              },
            },
            responseTypeDef: { ref: "User" },
          },
        },
        logger: { error: t.log },
      }),
    ]),
    createErrorHandler()
  );

  const serverAddress = createServerAddress(app);

  // Can't use static because setTimeout maxes out at 32 bits (~24 days)
  const deadline = new Date(Date.now() + 1000 * 60);

  const body = await got
    .post(`${serverAddress}/rpc/service1/bar`, {
      headers: {
        "x-request-id": "the-request-id",
        "x-request-deadline": deadline.toISOString(),
      },
      json: { message: "world", user: { name: "1" } },
    })
    .json();

  t.is(lastReqId, "the-request-id");
  t.is(lastDeadline, deadline.getTime());
  t.deepEqual(body, { name: "1" });
});
