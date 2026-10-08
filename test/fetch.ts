import test from "ava";
import * as context from "@loke/context";
import { Counter, register } from "prom-client";
import { createFetchHandler, ServiceDetails } from "../index";
import { requestContexts } from "../common";

const implementation = {
  hello: (args: { msg: string }) => `success ${args.msg}`,
  voidMethod: () => undefined,
};
const meta: ServiceDetails<typeof implementation> = {
  service: "hello-service",
  expose: [{ methodName: "hello" }, { methodName: "voidMethod" }],
};

function request(
  path: string,
  body = "{}",
  headers = {},
  signal?: AbortSignal,
) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
    signal,
  });
}

test("fetch exposes root, service and method metadata", async (t) => {
  const handler = createFetchHandler([{ implementation, meta }]);
  const methodMeta = {
    methodName: "hello",
    methodTimeout: 60000,
    paramNames: [],
    help: "hello method",
  };
  const serviceMeta = {
    serviceName: "hello-service",
    multiArg: false,
    help: "hello-service service",
    interfaces: [
      methodMeta,
      { ...methodMeta, methodName: "voidMethod", help: "voidMethod method" },
    ],
  };
  for (const [path, expected] of [
    ["/", { services: [serviceMeta] }],
    ["/hello-service", serviceMeta],
    ["/hello-service/hello?ignored=true", methodMeta],
  ] as const) {
    const response = await handler(new Request(`http://localhost${path}`));
    t.is(response.status, 200);
    t.is(response.headers.get("content-type"), "application/json");
    t.deepEqual(await response.json(), expected);
  }
});

test("fetch calls methods and returns null for void", async (t) => {
  const handler = createFetchHandler([{ implementation, meta }]);
  const response = await handler(
    request("/hello-service/hello", JSON.stringify({ msg: "world" })),
  );
  t.is(response.status, 200);
  t.is(await response.json(), "success world");
  t.is(
    await (await handler(request("/hello-service/voidMethod"))).json(),
    null,
  );
});

test("fetch legacy aliases retain nested routes", async (t) => {
  const handler = createFetchHandler([{ implementation, meta }], {
    legacy: true,
  });
  for (const path of ["/hello", "/hello-service/hello"]) {
    t.is(
      await (await handler(request(path, '{"msg":"world"}'))).json(),
      "success world",
    );
  }
  t.deepEqual(
    await (await handler(new Request("http://localhost/hello"))).json(),
    await (
      await handler(new Request("http://localhost/hello-service/hello"))
    ).json(),
  );
  t.throws(() => createFetchHandler([], { legacy: true }), {
    message: "Only 1 service is supported in legacy mode",
  });
});

test("fetch maps typed and legacy errors and logs them", async (t) => {
  const typed = Object.assign(new Error("typed failure"), {
    type: "Invalid",
    detail: "bad",
  });
  const legacy = Object.assign(new Error("legacy failure"), { code: "BAD" });
  const service = {
    implementation: {
      typed: () => {
        throw typed;
      },
      legacy: () => {
        throw legacy;
      },
    },
    meta: {
      service: "errors",
      expose: [{ methodName: "typed" }, { methodName: "legacy" }],
    },
  };
  const logs: string[] = [];
  const handler = createFetchHandler([service], {
    log: (msg) => logs.push(msg),
  });
  const typedResponse = await handler(request("/errors/typed"));
  t.is(typedResponse.status, 400);
  t.deepEqual(await typedResponse.json(), { type: "Invalid", detail: "bad" });
  const legacyResponse = await handler(request("/errors/legacy"));
  t.is(legacyResponse.status, 400);
  t.deepEqual(await legacyResponse.json(), {
    message: "legacy failure",
    code: "BAD",
  });
  t.true(logs[0].startsWith("Error executing errors/typed:"));
  t.true(logs[1].startsWith("Error executing errors/legacy:"));
  t.is(
    logs[2],
    "Legacy error returned from errors/legacy: name=Error, code=BAD",
  );
  const failures = await (
    register.getSingleMetric("http_rpc_failures_total") as Counter
  ).get();
  t.true(
    failures.values.some(
      (value) =>
        value.labels.handler === "errors.typed" &&
        value.labels.type === "Invalid" &&
        value.value === 1,
    ),
  );
});

test("fetch maps internal transport errors to 500", async (t) => {
  const logs: string[] = [];
  const handler = createFetchHandler([{ implementation, meta }], {
    log: (msg) => logs.push(msg),
  });
  const input = request("/hello-service/hello");
  input.text = async () => {
    throw new Error("body read failed");
  };
  const response = await handler(input);
  t.is(response.status, 500);
  t.deepEqual(await response.json(), { message: "body read failed" });
  t.true(logs[0].startsWith("Internal error executing undefined/undefined:"));
});

test("fetch returns JSON 404 for unmatched paths and methods", async (t) => {
  const handler = createFetchHandler([{ implementation, meta }]);
  for (const input of [
    request("/missing"),
    request("/hello-service/hello/"),
    new Request("http://localhost/", { method: "PUT" }),
  ]) {
    const response = await handler(input);
    t.is(response.status, 404);
    t.deepEqual(await response.json(), { message: "Not Found" });
  }
});

test("fetch rejects invalid JSON and ignores non-JSON bodies", async (t) => {
  const handler = createFetchHandler([{ implementation, meta }]);
  for (const body of ["{", "null", "1", '"primitive"']) {
    const invalid = await handler(request("/hello-service/hello", body));
    t.is(invalid.status, 400);
    t.deepEqual(await invalid.json(), { message: "Invalid JSON" });
  }
  const empty = await handler(request("/hello-service/voidMethod", ""));
  t.is(empty.status, 200);
  t.is(await empty.json(), null);
  const plain = await handler(
    request("/hello-service/hello", "not JSON", {
      "content-type": "text/plain",
    }),
  );
  t.is(plain.status, 200);
  t.is(await plain.json(), "success undefined");
});

test("fetch registers context with deadline and request ID and aborts on completion", async (t) => {
  let ctx: context.Context | undefined;
  const service = {
    implementation: {
      inspect: (args: object) => {
        ctx = requestContexts.get(args);
        return null;
      },
    },
    meta: { service: "context", expose: [{ methodName: "inspect" }] },
  };
  const deadline = new Date(Date.now() + 60000).toISOString();
  const handler = createFetchHandler([service]);
  await handler(
    request("/context/inspect", "{}", {
      "x-request-deadline": deadline,
      "x-request-id": "fetch-id",
    }),
  );
  t.truthy(ctx);
  t.is(ctx?.deadline, Date.parse(deadline));
  t.is(context.getRequestId(ctx!), "fetch-id");
  t.true(ctx?.signal?.aborted);
});

test("fetch aborts context when the request signal aborts", async (t) => {
  const controller = new AbortController();
  const service = {
    implementation: {
      wait: async (args: object) => {
        const ctx = requestContexts.get(args);
        t.truthy(ctx?.signal);
        controller.abort();
        t.true(ctx?.signal?.aborted);
        return null;
      },
    },
    meta: { service: "abort", expose: [{ methodName: "wait" }] },
  };
  const handler = createFetchHandler([service]);
  t.is(
    (await handler(request("/abort/wait", "{}", {}, controller.signal))).status,
    200,
  );
});

test("fetch observes a signal already aborted before dispatch", async (t) => {
  const controller = new AbortController();
  controller.abort();
  const service = {
    implementation: {
      inspect: (args: object) => requestContexts.get(args)?.signal?.aborted,
    },
    meta: { service: "pre-abort", expose: [{ methodName: "inspect" }] },
  };
  const response = await createFetchHandler([service])(
    request("/pre-abort/inspect", "{}", {}, controller.signal),
  );
  t.is(await response.json(), true);
});

test("fetch keeps context active during serialization and records serialization failures", async (t) => {
  let signal: AbortSignal | undefined;
  const logs: string[] = [];
  const service = {
    implementation: {
      inspect: (args: object) => {
        signal = requestContexts.get(args)?.signal;
        return { toJSON: () => ({ aborted: signal?.aborted }) };
      },
      broken: () => ({
        toJSON: () => {
          throw new Error("serialization failed");
        },
      }),
    },
    meta: {
      service: "serialization",
      expose: [{ methodName: "inspect" }, { methodName: "broken" }],
    },
  };
  const handler = createFetchHandler([service], {
    log: (message) => logs.push(message),
  });
  t.deepEqual(await (await handler(request("/serialization/inspect"))).json(), {
    aborted: false,
  });
  t.true(signal?.aborted);
  const response = await handler(request("/serialization/broken"));
  t.is(response.status, 400);
  t.deepEqual(await response.json(), { message: "serialization failed" });
  t.true(logs[0].startsWith("Error executing serialization/broken:"));
  const failures = await (
    register.getSingleMetric("http_rpc_failures_total") as Counter
  ).get();
  t.true(
    failures.values.some(
      (value) =>
        value.labels.handler === "serialization.broken" && value.value === 1,
    ),
  );
});
