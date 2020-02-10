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
        help: "This is a simple method.\nIt just returns success."
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
    help: "This is a simple method.\nIt just returns success."
  });
});

test.skip("param schemas", async t => {
  const app = express();
  const service = { hello: x => `success ${x.msg}` };
  const meta = {
    expose: [
      {
        methodName: "hello",
        methodTimeout: 15000,
        params: [{ name: "greeting", type: "greeting" }],
        help: `This is a simple method.
It just returns success.`
      }
    ],
    service: "hello-service",
    schemas: {
      greeting: {
        type: "object",
        required: ["message"],
        title: "Hi ho",
        properties: {
          message: {
            type: "string",
            title: "The Message Schema",
            default: "",
            examples: ["hello"],
            pattern: "^(.*)$"
          }
        }
      }
    },
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
        methodTimeout: 15000,
        help: "This is a simple method.\nIt just returns success."
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
    methodTimeout: 15000,
    help: "This is a simple method.\nIt just returns success."
  });
});
