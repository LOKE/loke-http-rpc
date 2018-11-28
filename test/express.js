import test from "ava";
import http from "http";
import express from "express";
import bodyParser from "body-parser";
import got from "got";
import httpRpc from "..";

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
    expose: ["hello"],
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

  t.throws(gotJsonPost(`${serverAddress}/rpc/missing`, {}));
});
