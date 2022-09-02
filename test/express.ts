import test from "ava";
import http from "http";
import express, { Express } from "express";
import bodyParser from "body-parser";
import got from "got";
import { createRequestHandler, ServiceDetails } from "../";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const inspect = (req: any, res: any, next: () => void) => {
  next();
  // console.log(req.body, req.headers); // eslint-disable-line no-console
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

test("basic integration test", async (t) => {
  const app = express();

  const implementation = {
    hello: (x: { msg: string }) => {
      return `success ${x.msg}`;
    },
  };
  const meta: ServiceDetails<typeof implementation> = {
    expose: [{ methodName: "hello" }],
    service: "hello-service",
  };

  app.use(
    "/rpc",
    bodyParser.json(),
    inspect,
    createRequestHandler([{ implementation, meta }])
  );

  const serverAddress = createServerAddress(app);

  const body = await got
    .post(`${serverAddress}/rpc/hello-service/hello`, {
      json: { msg: "world" },
    })
    .json();

  t.is(body, "success world");

  await t.throwsAsync(() =>
    got.post(`${serverAddress}/rpc/hello-service/missingMethod`, {
      json: { msg: "world" },
    })
  );

  await t.throwsAsync(() =>
    got.post(`${serverAddress}/rpc/missing-service/missingMethod`, {
      json: { msg: "world" },
    })
  );
});

test("legacy mode should expose methods under the root path", async (t) => {
  const app = express();

  const implementation = {
    hello: (x: { msg: string }) => {
      return `success ${x.msg}`;
    },
  };
  const meta: ServiceDetails<typeof implementation> = {
    expose: [{ methodName: "hello" }],
    service: "hello-service",
  };

  app.use(
    "/rpc",
    bodyParser.json(),
    inspect,
    createRequestHandler([{ implementation, meta }], { legacy: true })
  );

  const serverAddress = createServerAddress(app);

  const body = await got
    .post(`${serverAddress}/rpc/hello`, {
      json: { msg: "world" },
    })
    .json();

  t.is(body, "success world");
});

test("legacy mode should ALSO expose methods under the new nested path", async (t) => {
  const app = express();

  const implementation = {
    hello: (x: { msg: string }) => {
      return `success ${x.msg}`;
    },
  };
  const meta: ServiceDetails<typeof implementation> = {
    expose: [{ methodName: "hello" }],
    service: "hello-service",
  };

  app.use(
    "/rpc",
    bodyParser.json(),
    inspect,
    createRequestHandler([{ implementation, meta }], { legacy: true })
  );

  const serverAddress = createServerAddress(app);

  const body = await got
    .post(`${serverAddress}/rpc/hello-service/hello`, {
      json: { msg: "world" },
    })
    .json();

  t.is(body, "success world");
});

test("exposes metadata and documentation for a single service", async (t) => {
  const app = express();

  const implementation = { hello: (x: { msg: string }) => `success ${x.msg}` };
  const meta: ServiceDetails<typeof implementation> = {
    expose: [
      {
        methodName: "hello",
        methodTimeout: 15000,
        paramNames: ["greeting"],
        help: `This is a simple method.
It just returns success.`,
      },
    ],
    service: "hello-service",
    help: `This is the help for the service.
Can include **Markdown**.`,
  };

  app.use(
    "/rpc",
    bodyParser.json(),
    inspect,
    createRequestHandler([{ implementation, meta }])
  );

  const serverAddress = createServerAddress(app);

  // All service metadata
  const allMeta = (
    await got(`${serverAddress}/rpc/hello-service`, {
      responseType: "json",
    })
  ).body;
  t.deepEqual(allMeta, {
    serviceName: "hello-service",
    multiArg: false,
    help: "This is the help for the service.\nCan include **Markdown**.",
    interfaces: [
      {
        methodName: "hello",
        paramNames: ["greeting"],
        methodTimeout: 15000,
        help: "This is a simple method.\nIt just returns success.",
      },
    ],
  });

  // Method metadata
  const singleMeta = await got(
    `${serverAddress}/rpc/hello-service/hello`
  ).json();
  t.deepEqual(singleMeta, {
    methodName: "hello",
    paramNames: ["greeting"],
    methodTimeout: 15000,
    help: "This is a simple method.\nIt just returns success.",
  });
});

test("exposes metadata and documentation in legacy mode", async (t) => {
  const app = express();

  const implementation = { hello: (x: { msg: string }) => `success ${x.msg}` };
  const meta: ServiceDetails<typeof implementation> = {
    expose: [
      {
        methodName: "hello",
        methodTimeout: 15000,
        paramNames: ["greeting"],
        help: `This is a simple method.
It just returns success.`,
      },
    ],
    service: "hello-service",
    help: `This is the help for the service.
Can include **Markdown**.`,
  };

  app.use(
    "/rpc",
    bodyParser.json(),
    inspect,
    createRequestHandler([{ implementation, meta }], { legacy: true })
  );

  const serverAddress = createServerAddress(app);

  // All service metadata
  const allMeta = (
    await got(`${serverAddress}/rpc`, {
      responseType: "json",
    })
  ).body;
  t.deepEqual(allMeta, {
    services: [
      {
        serviceName: "hello-service",
        multiArg: false,
        help: "This is the help for the service.\nCan include **Markdown**.",
        interfaces: [
          {
            methodName: "hello",
            paramNames: ["greeting"],
            methodTimeout: 15000,
            help: "This is a simple method.\nIt just returns success.",
          },
        ],
      },
    ],
  });

  // Method metadata
  const singleMeta = await got(`${serverAddress}/rpc/hello`).json();
  t.deepEqual(singleMeta, {
    methodName: "hello",
    paramNames: ["greeting"],
    methodTimeout: 15000,
    help: "This is a simple method.\nIt just returns success.",
  });
});

test("exposes metadata for all services in handler", async (t) => {
  const app = express();

  const service1 = {
    implementation: {
      hello1: (x: { msg: string }) => {
        return `success ${x.msg}`;
      },
    },
    meta: {
      expose: [{ methodName: "hello1" }],
      service: "service-1",
      help: "hello",
    },
  };
  const service2 = {
    implementation: {
      hello2: (x: { msg: string }) => {
        return `success ${x.msg}`;
      },
    },
    meta: {
      expose: [{ methodName: "hello2" }],
      service: "service-2",
      help: "hello",
    },
  };

  app.use(
    "/rpc",
    bodyParser.json(),
    inspect,
    createRequestHandler([service1, service2])
  );

  const serverAddress = createServerAddress(app);

  const body = await got.get(`${serverAddress}/rpc`).json();

  t.deepEqual(body, {
    services: [
      {
        serviceName: "service-1",
        help: "hello",
        multiArg: false,
        interfaces: [
          {
            help: "hello1 method",
            methodName: "hello1",
            methodTimeout: 60000,
            paramNames: [],
          },
        ],
      },
      {
        serviceName: "service-2",
        help: "hello",
        multiArg: false,
        interfaces: [
          {
            help: "hello2 method",
            methodName: "hello2",
            methodTimeout: 60000,
            paramNames: [],
          },
        ],
      },
    ],
  });
});
