import test from "ava";
import http from "http";
import express, { Express } from "express";
import bodyParser from "body-parser";
import got from "got";
import * as httpRpc from "..";

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
  const service = {
    hello: (x: { msg: string }) => {
      console.log("method", x.msg);
      return `success ${x.msg}`;
    },
  };
  const meta: httpRpc.ServiceDetails<typeof service> = {
    expose: [{ methodName: "hello" }],
    service: "hello-service",
  };

  app.use(
    "/rpc",
    bodyParser.json(),
    inspect,
    httpRpc.createRequestHandler(service, meta)
  );

  const serverAddress = createServerAddress(app);

  const body = await got
    .post(`${serverAddress}/rpc/hello`, {
      json: { msg: "world" },
    })
    .json();

  t.is(body, "success world");

  await t.throwsAsync(() =>
    got.post(`${serverAddress}/rpc/missing`, {
      json: { msg: "world" },
    })
  );
});

test("metadata and documentation", async (t) => {
  const app = express();
  const service = { hello: (x: { msg: string }) => `success ${x.msg}` };
  const meta: httpRpc.ServiceDetails<typeof service> = {
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
    httpRpc.createRequestHandler(service, meta)
  );

  const serverAddress = createServerAddress(app);

  // All service metadata
  const allMeta = (
    await got(`${serverAddress}/rpc`, {
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
  const singleMeta = await got(`${serverAddress}/rpc/hello`).json();
  t.deepEqual(singleMeta, {
    methodName: "hello",
    paramNames: ["greeting"],
    methodTimeout: 15000,
    help: "This is a simple method.\nIt just returns success.",
  });
});
