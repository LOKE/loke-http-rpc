import test from "ava";
import http from "http";
import express, { Express } from "express";
import bodyParser from "body-parser";
import got from "got";
import * as httpRpc from "..";
import { createErrorType } from "@loke/errors";

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

test("passes through messages", async (t) => {
  const app = express();
  const service = {
    basicError: () => {
      throw new Error("This is a basic error");
    },
  };
  const meta: httpRpc.ServiceDetails<typeof service> = {
    expose: [{ methodName: "basicError" }],
    service: "hello-service",
  };

  app.use(
    "/rpc",
    bodyParser.json(),
    inspect,
    httpRpc.createRequestHandler(service, meta),
    httpRpc.createErrorHandler()
  );

  const serverAddress = createServerAddress(app);

  const err: any = await t.throwsAsync(() =>
    got.post(`${serverAddress}/rpc/basicError`, {
      json: {},
      responseType: "json",
    })
  );
  t.deepEqual(err.response.body, {
    message: "This is a basic error",
  });
});

test("passes through codes if available and makes them exposed", async (t) => {
  const app = express();
  const service = {
    codeError: () => {
      const err: Error & { code?: string } = new Error("This is a code error");
      err.code = "CODE_ERROR";
      throw err;
    },
  };
  const meta: httpRpc.ServiceDetails<typeof service> = {
    expose: [{ methodName: "codeError" }],
    service: "hello-service",
  };

  app.use(
    "/rpc",
    bodyParser.json(),
    inspect,
    httpRpc.createRequestHandler(service, meta),
    httpRpc.createErrorHandler()
  );

  const serverAddress = createServerAddress(app);

  const err: any = await t.throwsAsync(() =>
    got.post(`${serverAddress}/rpc/codeError`, {
      json: {},
      responseType: "json",
    })
  );
  t.deepEqual(err.response.body, {
    message: "This is a code error",
    code: "CODE_ERROR",
  });
});

test("passes through expose if available on a @loke/errors type", async (t) => {
  const app = express();
  const CustomError = createErrorType({
    message: "LOKE Error",
    code: "my_code",
    help: "Some help",
    expose: true,
  });
  const service = {
    lokeError: () => {
      throw new CustomError();
    },
  };
  const meta: httpRpc.ServiceDetails<typeof service> = {
    expose: [{ methodName: "lokeError" }],
    service: "hello-service",
  };

  app.use(
    "/rpc",
    bodyParser.json(),
    inspect,
    httpRpc.createRequestHandler(service, meta),
    httpRpc.createErrorHandler()
  );

  const serverAddress = createServerAddress(app);

  const err: any = await t.throwsAsync(() =>
    got.post(`${serverAddress}/rpc/lokeError`, {
      json: {},
      responseType: "json",
    })
  );

  const bodyComp = Object.assign({}, err.response.body, {
    instance: "removed",
  });
  t.deepEqual(bodyComp, {
    instance: "removed",
    message: "LOKE Error",
    expose: true,
    code: "my_code",
    type: "my_code",
  });
});

test("passes through @loke/errors serialized in full", async (t) => {
  const app = express();
  const CustomError = createErrorType({
    message: "LOKE Error",
    code: "my_code",
    help: "Some help",
  });
  const service = {
    lokeError: () => {
      throw new CustomError(null, { something: "else" });
    },
  };
  const meta: httpRpc.ServiceDetails<typeof service> = {
    expose: [{ methodName: "lokeError" }],
    service: "hello-service",
  };

  app.use(
    "/rpc",
    bodyParser.json(),
    inspect,
    httpRpc.createRequestHandler(service, meta),
    httpRpc.createErrorHandler()
  );

  const serverAddress = createServerAddress(app);

  const err: any = await t.throwsAsync(() =>
    got.post(`${serverAddress}/rpc/lokeError`, {
      json: {},
      responseType: "json",
    })
  );

  const bodyComp = Object.assign({}, err.response.body, {
    instance: "removed",
  });
  t.deepEqual(bodyComp, {
    instance: "removed",
    message: "LOKE Error",
    code: "my_code",
    type: "my_code",
    something: "else",
  });
});

test("logs error stacktraces if not exposed", async (t) => {
  let logged = "";
  const log = (str: string) => {
    logged += str;
  };
  const app = express();
  function stack1() {
    stack2();
  }
  function stack2() {
    throw new Error("Stacked");
  }
  const service = {
    stackError: () => {
      stack1();
    },
  };
  const meta: httpRpc.ServiceDetails<typeof service> = {
    expose: [{ methodName: "stackError" }],
    service: "hello-service",
  };

  app.use(
    "/rpc",
    bodyParser.json(),
    inspect,
    httpRpc.createRequestHandler(service, meta),
    httpRpc.createErrorHandler({ log })
  );

  const serverAddress = createServerAddress(app);

  await t.throwsAsync(() =>
    got.post(`${serverAddress}/rpc/stackError`, {
      json: {},
    })
  );
  t.true(
    logged.startsWith(
      "Error executing hello-service/stackError: Error: Stacked\n    at stack2"
    )
  );
});
