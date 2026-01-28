import test, { ExecutionContext } from "ava";
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

function createServerAddress(app: Express, t: ExecutionContext) {
  const server = http.createServer(app);

  server.listen(0);

  const address = server.address();
  if (!address || typeof address !== "object") {
    throw new Error("No server address found");
  }

  t.teardown(() => {
    server.close();
  });

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
      return { username: 123 } as unknown as User;
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
    createErrorHandler(),
  );

  const serverAddress = createServerAddress(app, t);

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
        .json(),
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
        .json(),
    );

    t.deepEqual(JSON.parse(err.response.body as string), {
      message: 'must pass "void" keyword validation',
      code: "response-validation",
      type: "https://errors.loke.global/@loke/http-rpc/response-validation",
      instancePath: "",
      schemaPath: "/metadata/void",
    });
  }

  // Methods with invalid response should fail (can be turned off)
  {
    const err: HTTPError = await t.throwsAsync(() =>
      got
        .post(`${serverAddress}/rpc/service2/badResponse`, {
          json: {},
        })
        .json(),
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
      .json(),
  );
});

test("test context", async (t) => {
  const app = express();

  let lastReqId: string | undefined;
  let lastDeadline: number | undefined;

  const service1 = {
    bar: async (
      ctx: Context,
      args: { message: string; user: User; thing: any },
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
    createErrorHandler(),
  );

  const serverAddress = createServerAddress(app, t);

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

test("should validate union types correctly", async (t) => {
  const app = express();

  interface KountaMeta {
    type: "kounta";
    apiKey: string;
  }

  interface ZonalMeta {
    type: "zonal";
    token: string;
  }

  interface PublicApiMeta {
    type: "publicApi";
    clientId: string;
  }

  type OrderingConfigMeta = KountaMeta | ZonalMeta | PublicApiMeta;

  const service = {
    updateConfig: async (args: { config: OrderingConfigMeta }) => {
      return { success: true, configType: args.config.type };
    },
  };

  app.use(
    "/rpc",
    bodyParser.json() as any,
    inspect,
    createRequestHandler([
      serviceWithSchema<typeof service>(service, {
        name: "configService",
        methods: {
          updateConfig: {
            requestTypeDef: {
              properties: {
                config: {
                  discriminator: "type",
                  mapping: {
                    kounta: {
                      properties: {
                        apiKey: { type: "string" },
                      },
                    },
                    zonal: {
                      properties: {
                        token: { type: "string" },
                      },
                    },
                    publicApi: {
                      properties: {
                        clientId: { type: "string" },
                      },
                    },
                  },
                },
              },
            } as any,
            responseTypeDef: {
              properties: {
                success: { type: "boolean" },
                configType: { type: "string" },
              },
            } as any,
          },
        },
        logger: { error: t.log },
      }),
    ]),
    createErrorHandler(),
  );

  const serverAddress = createServerAddress(app, t);

  // Valid KountaMeta should work
  {
    const body = await got
      .post(`${serverAddress}/rpc/configService/updateConfig`, {
        json: { config: { type: "kounta", apiKey: "test-key-123" } },
      })
      .json();

    t.deepEqual(body, { success: true, configType: "kounta" });
  }

  // Valid ZonalMeta should work
  {
    const body = await got
      .post(`${serverAddress}/rpc/configService/updateConfig`, {
        json: { config: { type: "zonal", token: "test-token-456" } },
      })
      .json();

    t.deepEqual(body, { success: true, configType: "zonal" });
  }

  // Valid PublicApiMeta should work
  {
    const body = await got
      .post(`${serverAddress}/rpc/configService/updateConfig`, {
        json: { config: { type: "publicApi", clientId: "client-789" } },
      })
      .json();

    t.deepEqual(body, { success: true, configType: "publicApi" });
  }

  // Invalid type not in union should fail
  {
    const err: HTTPError = await t.throwsAsync(() =>
      got
        .post(`${serverAddress}/rpc/configService/updateConfig`, {
          json: { config: { type: "invalid", someField: "value" } },
        })
        .json(),
    );

    const errorBody = JSON.parse(err.response.body as string);
    t.is(errorBody.code, "validation");
    t.is(
      errorBody.type,
      "https://errors.loke.global/@loke/http-rpc/validation",
    );
  }

  // Missing required field for union member should fail
  {
    const err: HTTPError = await t.throwsAsync(() =>
      got
        .post(`${serverAddress}/rpc/configService/updateConfig`, {
          json: { config: { type: "kounta" } }, // missing apiKey
        })
        .json(),
    );

    const errorBody = JSON.parse(err.response.body as string);
    t.is(errorBody.code, "validation");
    t.is(
      errorBody.type,
      "https://errors.loke.global/@loke/http-rpc/validation",
    );
  }

  // Wrong type for required field should fail
  {
    const err: HTTPError = await t.throwsAsync(() =>
      got
        .post(`${serverAddress}/rpc/configService/updateConfig`, {
          json: { config: { type: "zonal", token: 123 } }, // token should be string
        })
        .json(),
    );

    const errorBody = JSON.parse(err.response.body as string);
    t.is(errorBody.code, "validation");
    t.is(
      errorBody.type,
      "https://errors.loke.global/@loke/http-rpc/validation",
    );
  }
});

test("should validate non-discriminated union types correctly", async (t) => {
  const app = express();

  interface SuccessResponse {
    status: "success";
    data: string;
  }

  interface ErrorResponse {
    status: "error";
    errorCode: number;
    message: string;
  }

  interface WarningResponse {
    status: "warning";
    warningLevel: number;
  }

  type ApiResponse = SuccessResponse | ErrorResponse | WarningResponse;

  type Defs = {
    SuccessResponse: SuccessResponse;
    ErrorResponse: ErrorResponse;
    WarningResponse: WarningResponse;
    ApiResponse: ApiResponse;
  };

  const service = {
    makeRequest: async (args: { input: string }): Promise<ApiResponse> => {
      if (args.input === "success") {
        return { status: "success", data: "result" };
      } else if (args.input === "error") {
        return { status: "error", errorCode: 500, message: "failed" };
      } else {
        return { status: "warning", warningLevel: 1 };
      }
    },
  };

  app.use(
    "/rpc",
    bodyParser.json() as any,
    inspect,
    createRequestHandler([
      serviceWithSchema<typeof service, Defs>(service, {
        name: "apiService",
        definitions: {
          SuccessResponse: {
            properties: {
              status: { enum: ["success"] },
              data: { type: "string" },
            },
          },
          ErrorResponse: {
            properties: {
              status: { enum: ["error"] },
              errorCode: { type: "int32" },
              message: { type: "string" },
            },
          },
          WarningResponse: {
            properties: {
              status: { enum: ["warning"] },
              warningLevel: { type: "int32" },
            },
          },
          ApiResponse: {
            metadata: {
              union: [
                { ref: "SuccessResponse" },
                { ref: "ErrorResponse" },
                { ref: "WarningResponse" },
              ],
            },
          },
        },
        methods: {
          makeRequest: {
            requestTypeDef: {
              properties: {
                input: { type: "string" },
              },
            },
            responseTypeDef: { ref: "ApiResponse" },
          },
        },
        logger: { error: t.log },
      }),
    ]),
    createErrorHandler(),
  );

  const serverAddress = createServerAddress(app, t);

  // Valid SuccessResponse should work
  {
    const body = await got
      .post(`${serverAddress}/rpc/apiService/makeRequest`, {
        json: { input: "success" },
      })
      .json();

    t.deepEqual(body, { status: "success", data: "result" });
  }

  // Valid ErrorResponse should work
  {
    const body = await got
      .post(`${serverAddress}/rpc/apiService/makeRequest`, {
        json: { input: "error" },
      })
      .json();

    t.deepEqual(body, {
      status: "error",
      errorCode: 500,
      message: "failed",
    });
  }

  // Valid WarningResponse should work
  {
    const body = await got
      .post(`${serverAddress}/rpc/apiService/makeRequest`, {
        json: { input: "warning" },
      })
      .json();

    t.deepEqual(body, { status: "warning", warningLevel: 1 });
  }
});

test("should throw validation errors for invalid non-discriminated union types", async (t) => {
  const app = express();

  interface StringValue {
    type: "string";
    value: string;
  }

  interface NumberValue {
    type: "number";
    value: number;
  }

  interface BooleanValue {
    type: "boolean";
    value: boolean;
  }

  type ConfigValue = StringValue | NumberValue | BooleanValue;

  type Defs = {
    StringValue: StringValue;
    NumberValue: NumberValue;
    BooleanValue: BooleanValue;
    ConfigValue: ConfigValue;
  };

  const service = {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- This is a mock
    updateValue: async (args: { config: ConfigValue }) => {
      return { success: true };
    },
  };

  app.use(
    "/rpc",
    bodyParser.json() as any,
    inspect,
    createRequestHandler([
      serviceWithSchema<typeof service, Defs>(service, {
        name: "configService",
        definitions: {
          StringValue: {
            properties: {
              type: { enum: ["string"] },
              value: { type: "string" },
            },
          },
          NumberValue: {
            properties: {
              type: { enum: ["number"] },
              value: { type: "float64" },
            },
          },
          BooleanValue: {
            properties: {
              type: { enum: ["boolean"] },
              value: { type: "boolean" },
            },
          },
          ConfigValue: {
            metadata: {
              union: [
                { ref: "StringValue" },
                { ref: "NumberValue" },
                { ref: "BooleanValue" },
              ],
            },
          },
        },
        methods: {
          updateValue: {
            requestTypeDef: {
              properties: {
                config: { ref: "ConfigValue" },
              },
            },
            responseTypeDef: {
              properties: {
                success: { type: "boolean" },
              },
            },
          },
        },
        logger: { error: t.log },
      }),
    ]),
    createErrorHandler(),
  );

  const serverAddress = createServerAddress(app, t);

  // Invalid: type not in union should fail
  {
    const err: HTTPError = await t.throwsAsync(() =>
      got
        .post(`${serverAddress}/rpc/configService/updateValue`, {
          json: { config: { type: "invalid", value: "test" } },
        })
        .json(),
    );

    const errorBody = JSON.parse(err.response.body as string);
    t.is(errorBody.code, "validation");
    t.is(
      errorBody.type,
      "https://errors.loke.global/@loke/http-rpc/validation",
    );
  }

  // Invalid: wrong value type for StringValue should fail
  {
    const err: HTTPError = await t.throwsAsync(() =>
      got
        .post(`${serverAddress}/rpc/configService/updateValue`, {
          json: { config: { type: "string", value: 123 } }, // value should be string
        })
        .json(),
    );

    const errorBody = JSON.parse(err.response.body as string);
    t.is(errorBody.code, "validation");
    t.is(
      errorBody.type,
      "https://errors.loke.global/@loke/http-rpc/validation",
    );
  }

  // Invalid: wrong value type for NumberValue should fail
  {
    const err: HTTPError = await t.throwsAsync(() =>
      got
        .post(`${serverAddress}/rpc/configService/updateValue`, {
          json: { config: { type: "number", value: "not a number" } },
        })
        .json(),
    );

    const errorBody = JSON.parse(err.response.body as string);
    t.is(errorBody.code, "validation");
    t.is(
      errorBody.type,
      "https://errors.loke.global/@loke/http-rpc/validation",
    );
  }

  // Invalid: missing required field should fail
  {
    const err: HTTPError = await t.throwsAsync(() =>
      got
        .post(`${serverAddress}/rpc/configService/updateValue`, {
          json: { config: { type: "boolean" } }, // missing value field
        })
        .json(),
    );

    const errorBody = JSON.parse(err.response.body as string);
    t.is(errorBody.code, "validation");
    t.is(
      errorBody.type,
      "https://errors.loke.global/@loke/http-rpc/validation",
    );
  }
});
