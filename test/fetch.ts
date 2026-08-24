import test from "ava";
import { createFetchHandler, ServiceDetails } from "../";

const implementation = {
  hello: (x: { msg: string }) => `success ${x.msg}`,
  fail: () => {
    throw Object.assign(new Error("nope"), { type: "test-error" });
  },
};
const meta: ServiceDetails<typeof implementation> = {
  expose: [{ methodName: "hello" }, { methodName: "fail" }],
  service: "fetch-service",
};

const handler = createFetchHandler([{ implementation, meta }]);

const post = (path: string, body: unknown) =>
  handler(
    new Request(`http://localhost${path}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );

test("invokes a method", async (t) => {
  const res = await post("/rpc/fetch-service/hello", { msg: "world" });
  t.is(res.status, 200);
  t.is(await res.json(), "success world");
});

test("exposes metadata", async (t) => {
  const res = await handler(new Request("http://localhost/rpc"));
  t.is((await res.json()).services[0].serviceName, "fetch-service");
});

test("returns errors thrown by a method", async (t) => {
  const res = await post("/rpc/fetch-service/fail", {});
  t.is(res.status, 400);
  t.like(await res.json(), { type: "test-error" });
});

test("404s unknown methods", async (t) => {
  const res = await post("/rpc/fetch-service/nope", {});
  t.is(res.status, 404);
});

test("rejects non object bodies", async (t) => {
  const res = await post("/rpc/fetch-service/hello", "nope");
  t.is(res.status, 400);
});
