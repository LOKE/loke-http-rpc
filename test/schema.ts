import test from "ava";
import http from "http";
import express, { Express } from "express";
import bodyParser from "body-parser";
import got, { HTTPError } from "got";
import { createErrorHandler, createRequestHandler } from "../";
import { serviceWithSchema } from "../schema";

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
  }

  type Service2 = {
    baz: (x: { msg: string; user?: User }) => Promise<string>;
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
    bodyParser.json(),
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
        logger: { warn: t.log },
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
        },
        logger: { warn: t.log },
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
});
