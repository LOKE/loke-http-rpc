import test, { ExecutionContext } from "ava";
import http from "http";
import got from "got";
import { createRequestHandler, ServiceDetails } from "../";

function createServerAddress(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  t: ExecutionContext,
) {
  const server = http.createServer(handler);
  server.listen(0);
  const address = server.address();
  if (!address || typeof address !== "object") {
    throw new Error("No server address found");
  }
  t.teardown(() => server.close());
  return `http://localhost:${address.port}`;
}

function adapt(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rawBody: string,
) {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  const body = rawBody ? (JSON.parse(rawBody) as object) : {};

  const rpcReq = Object.assign(req, { path, body });

  const rpcRes = {
    get headersSent() {
      return res.headersSent;
    },
    json(data: unknown) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(data));
    },
    status(code: number) {
      res.statusCode = code;
      return this;
    },
  };

  return { rpcReq, rpcRes };
}

test("works with plain node:http without express", async (t) => {
  const implementation = {
    hello: (x: { msg: string }) => `success ${x.msg}`,
  };
  const meta: ServiceDetails<typeof implementation> = {
    expose: [{ methodName: "hello" }],
    service: "hello-service",
  };

  const rpcHandler = createRequestHandler([{ implementation, meta }]);

  const serverAddress = createServerAddress((req, res) => {
    let rawBody = "";
    req.on("data", (chunk: Buffer) => {
      rawBody += chunk.toString();
    });
    req.on("end", () => {
      const { rpcReq, rpcRes } = adapt(req, res, rawBody);
      void rpcHandler(rpcReq, rpcRes, () => {
        res.statusCode = 404;
        res.end();
      });
    });
  }, t);

  const body = await got
    .post(`${serverAddress}/hello-service/hello`, { json: { msg: "world" } })
    .json();

  t.is(body, "success world");
});
