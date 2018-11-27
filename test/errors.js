import test from "ava";
import http from "http";
import express from "express";
import bodyParser from "body-parser";
import got from "got";
import httpRpc from "..";
import { createErrorType } from "@loke/errors";

function gotJsonPost(url, options) {
  const jsonOptions = {
    ...options,
    json: true,
    headers: { ...options.headers, "Content-type": "application/json" },
    body: options.body && JSON.stringify(options.body)
  };

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

test("passes through messages", async t => {
  const app = express();
  const service = {
    basicError: () => {
      throw new Error("This is a basic error");
    }
  };
  const meta = {
    expose: [{ methodName: "basicError" }],
    service: "hello-service"
  };

  app.use(
    "/rpc",
    bodyParser.json(),
    inspect,
    httpRpc.createRequestHandler(service, meta),
    httpRpc.createErrorHandler()
  );

  const serverAddress = createServerAddress(app);

  const err = await t.throws(
    gotJsonPost(`${serverAddress}/rpc/basicError`, {
      body: {}
    })
  );
  t.deepEqual(err.response.body, {
    message: "This is a basic error",
    expose: false
  });
});

test("passes through codes if available and makes them exposed", async t => {
  const app = express();
  const service = {
    codeError: () => {
      const err = new Error("This is a code error");
      err.code = "CODE_ERROR";
      throw err;
    }
  };
  const meta = {
    expose: [{ methodName: "codeError" }],
    service: "hello-service"
  };

  app.use(
    "/rpc",
    bodyParser.json(),
    inspect,
    httpRpc.createRequestHandler(service, meta),
    httpRpc.createErrorHandler()
  );

  const serverAddress = createServerAddress(app);

  const err = await t.throws(
    gotJsonPost(`${serverAddress}/rpc/codeError`, {
      body: {}
    })
  );
  t.deepEqual(err.response.body, {
    message: "This is a code error",
    code: "CODE_ERROR",
    expose: true
  });
});

test("passes through expose if available", async t => {
  const app = express();
  const service = {
    exposeError: () => {
      const err = new Error("This is an exposed error");
      err.expose = true;
      throw err;
    }
  };
  const meta = {
    expose: [{ methodName: "exposeError" }],
    service: "hello-service"
  };

  app.use(
    "/rpc",
    bodyParser.json(),
    inspect,
    httpRpc.createRequestHandler(service, meta),
    httpRpc.createErrorHandler()
  );

  const serverAddress = createServerAddress(app);

  const err = await t.throws(
    gotJsonPost(`${serverAddress}/rpc/exposeError`, {
      body: {}
    })
  );
  t.deepEqual(err.response.body, {
    message: "This is an exposed error",
    expose: true
  });
});

test("doesn't expose errors with code if expose = false", async t => {
  const app = express();
  const service = {
    notExposeError: () => {
      const err = new Error("This is a not exposed error");
      err.code = "NOT_EXPOSED";
      err.expose = false;
      throw err;
    }
  };
  const meta = {
    expose: [{ methodName: "notExposeError" }],
    service: "hello-service"
  };

  app.use(
    "/rpc",
    bodyParser.json(),
    inspect,
    httpRpc.createRequestHandler(service, meta),
    httpRpc.createErrorHandler()
  );

  const serverAddress = createServerAddress(app);

  const err = await t.throws(
    gotJsonPost(`${serverAddress}/rpc/notExposeError`, {
      body: {}
    })
  );
  t.deepEqual(err.response.body, {
    message: "This is a not exposed error",
    code: "NOT_EXPOSED",
    expose: false
  });
});

test("passes through @loke/errors serialized in full", async t => {
  const app = express();
  const CustomError = createErrorType({
    message: "LOKE Error",
    code: "my_code",
    expose: true,
    help: "Some help"
  });
  const service = {
    lokeError: () => {
      throw new CustomError(null, { something: "else" });
    }
  };
  const meta = {
    expose: [{ methodName: "lokeError" }],
    service: "hello-service"
  };

  app.use(
    "/rpc",
    bodyParser.json(),
    inspect,
    httpRpc.createRequestHandler(service, meta),
    httpRpc.createErrorHandler()
  );

  const serverAddress = createServerAddress(app);

  const err = await t.throws(
    gotJsonPost(`${serverAddress}/rpc/lokeError`, {
      body: {}
    })
  );

  const bodyComp = Object.assign({}, err.response.body, {
    instance: "removed"
  });
  t.deepEqual(bodyComp, {
    instance: "removed",
    message: "LOKE Error",
    expose: true,
    code: "my_code",
    type: "my_code",
    something: "else"
  });
});

test("logs error stacktraces if not exposed", async t => {
  let logged = "";
  const log = str => {
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
    }
  };
  const meta = {
    expose: [{ methodName: "stackError" }],
    service: "hello-service"
  };

  app.use(
    "/rpc",
    bodyParser.json(),
    inspect,
    httpRpc.createRequestHandler(service, meta),
    httpRpc.createErrorHandler({ log })
  );

  const serverAddress = createServerAddress(app);

  await t.throws(
    gotJsonPost(`${serverAddress}/rpc/stackError`, {
      body: {}
    })
  );
  t.true(
    logged.startsWith(
      "Error executing hello-service/stackError: Error: Stacked\n    at stack2"
    )
  );
});
