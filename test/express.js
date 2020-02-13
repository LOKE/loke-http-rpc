const test = require("ava");
const http = require("http");
const express = require("express");
const bodyParser = require("body-parser");
const got = require("got");
const httpRpc = require("..");

function gotJsonPost(url, options) {
  const jsonOptions = {
    ...options,
    json: true,
    headers: { ...options.headers, "Content-type": "application/json" },
    body: options.body && JSON.stringify(options.body)
  };

  // console.log(jsonOptions); // eslint-disable-line no-console

  return got.post(url, jsonOptions);
}

const inspect = (req, res, next) => {
  next();
  // console.log(req.body, req.headers); // eslint-disable-line no-console
};

function createServerAddress(app) {
  const server = http.createServer(app);

  server.listen(0);

  const port = server.address().port;

  return `localhost:${port}`;
}

test("basic integration test", async t => {
  const app = express();
  const service = {
    hello: x => `success ${x.msg}`
  };
  const meta = {
    expose: [{ methodName: "hello" }],
    service: "hello-service"
  };

  app.use(
    "/rpc",
    bodyParser.json(),
    inspect,
    httpRpc.createRequestHandler(service, meta)
  );

  const serverAddress = createServerAddress(app);

  const response = await gotJsonPost(`${serverAddress}/rpc/hello`, {
    body: { msg: "world" }
  });
  t.is(response.body, "success world");

  await t.throwsAsync(() => gotJsonPost(`${serverAddress}/rpc/missing`, {}));
});

test("metadata and documentation", async t => {
  const app = express();
  const service = { hello: x => `success ${x.msg}` };
  const meta = {
    expose: [
      {
        methodName: "hello",
        methodTimeout: 15000,
        params: [{ name: "greeting" }],
        help: `This is a simple method.
It just returns success.`
      }
    ],
    service: "hello-service",
    help: `This is the help for the service.
Can include **Markdown**.`
  };

  app.use(
    "/rpc",
    bodyParser.json(),
    inspect,
    httpRpc.createRequestHandler(service, meta)
  );

  const serverAddress = createServerAddress(app);

  // All service metadata
  const allMeta = (await got(`${serverAddress}/rpc`, {
    json: true
  })).body;
  t.deepEqual(allMeta, {
    serviceName: "hello-service",
    multiArg: false,
    help: "This is the help for the service.\nCan include **Markdown**.",
    interfaces: [
      {
        methodName: "hello",
        paramNames: ["greeting"],
        params: [{ name: "greeting" }],
        methodTimeout: 15000,
        help: "This is a simple method.\nIt just returns success.",
        returnType: "any"
      }
    ]
  });

  // Method metadata
  const singleMeta = (await got(`${serverAddress}/rpc/hello`, {
    json: true
  })).body;
  t.deepEqual(singleMeta, {
    methodName: "hello",
    paramNames: ["greeting"],
    params: [{ name: "greeting" }],
    methodTimeout: 15000,
    help: "This is a simple method.\nIt just returns success.",
    returnType: "any"
  });
});

test("param schemas are returned if available", async t => {
  const app = express();
  const service = { hello: x => `success ${x.msg}` };
  const meta = {
    expose: [
      {
        methodName: "hello",
        methodTimeout: 15000,
        params: [{ name: "greeting", type: "Greeting" }],
        returnType: "GizmosArray",
        help: `This is a simple method.
It returns gizmos.`
      }
    ],
    service: "hello-service",
    schemas: [
      {
        type: "object",
        required: ["message"],
        title: "Greeting",
        properties: {
          message: {
            type: "string",
            title: "GreetingMessage",
            default: "",
            examples: ["hello"],
            pattern: "^(.*)$"
          }
        },
        additionalProperties: false
      },
      {
        type: "array",
        title: "GizmosArray",
        items: {
          type: "string",
          title: "Gizmo",
          default: "",
          examples: ["one", "two"],
          pattern: "^(.*)$"
        }
      }
    ],
    help: `This is the help for the service.
Can include **Markdown**.`
  };

  app.use(
    "/rpc",
    bodyParser.json(),
    inspect,
    httpRpc.createRequestHandler(service, meta)
  );

  const serverAddress = createServerAddress(app);

  const rpcMeta = (await got(`${serverAddress}/rpc`, { json: true })).body;
  t.deepEqual(rpcMeta, {
    help: `This is the help for the service.\nCan include **Markdown**.`,
    interfaces: [
      {
        help: `This is a simple method.\nIt returns gizmos.`,
        methodName: "hello",
        methodTimeout: 15000,
        paramNames: ["greeting"],
        params: [
          {
            name: "greeting",
            type: "Greeting"
          }
        ],
        returnType: "GizmosArray"
      }
    ],
    multiArg: false,
    schemas: [
      {
        type: "object",
        required: ["message"],
        title: "Greeting",
        properties: {
          message: {
            type: "string",
            title: "GreetingMessage",
            default: "",
            examples: ["hello"],
            pattern: "^(.*)$"
          }
        },
        additionalProperties: false
      },
      {
        type: "array",
        title: "GizmosArray",
        items: {
          type: "string",
          title: "Gizmo",
          default: "",
          examples: ["one", "two"],
          pattern: "^(.*)$"
        }
      }
    ],
    serviceName: "hello-service"
  });
});
