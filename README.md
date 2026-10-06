# @loke/http-rpc

## Breaking Changes for v5

- createRequestHandler now accepts a list of services.
- The root endpoint on a request handler now returns an array of metadata for each service
- Legacy mode can be enabled to still handle calls in the older `/methodName` format.
- It is now preferred to use the `/service-name/methodName` format, even if a process only hosts 1 service.

### Migrating from v4 to v5

- Pass in your services as an array, instead of 1-by-1.
- If using an older style setup with one service hosted at `/rpc` then enable legacy mode.

### v4:

RequestHandler is directly exposed in v4

```js
const lokeHttpRpc = require("@loke/http-rpc");

const myRpcService = lokeHttpRpc.createRequestHandler(
  myService,
  MY_SERVICE_META,
);
app.use("/rpc", myRpcService);
app.use(lokeHttpRpc.createErrorHandler({ log: (msg) => console.log(msg) }));
```

### v5:

createRequestHandler adds the service name to the path where its exposed. ("/rpc/service-name"). This allows to handle multiple services with single handler.

```js
const { createRequestHandler, createErrorHandler } = require("@loke/http-rpc");

// service will be exposed on /rpc/service-name
app.use(
  "/rpc",
  createRequestHandler([{ implementation: myService, meta: MY_SERVICE_META }]),
);
app.use(createErrorHandler({ log: (msg) => console.log(msg) }));

// or... service will be exposed on /rpc AND /rpc/service-name
// but will be limited to 1 service
app.use(
  "/rpc",
  createRequestHandler([{ implementation: myService, meta: MY_SERVICE_META }], {
    legacy: true,
  }),
);
app.use(createErrorHandler({ log: (msg) => console.log(msg) }));
```

## Implementation Guide

```js
const { createRequestHandler, createErrorHandler } = require("@loke/http-rpc");

const myService = {
  async doStuff() {
    return await Promise.resolve("stuff done");
  },
  moreStuff(stuffs) {
    return "you wanted " + stuffs;
  },
};

const MY_SERVICE_META = {
  service: "my-service", // display name
  help: "Documentation goes here",
  multiArg: false, // defaults to false. If true accepts an array for arguments, if false an array will be assumed to be the first (and only) argument.
  expose: [
    // The methods to be exposed publicly

    {
      methodName: "moreStuff",
      methodTimeout: 15000,
      paramNames: ["stuffs"],
      help: "This is a silly method",
    },
  ],
};

const rpcHandler = createRequestHandler([
  {
    implementation: service,
    meta: SERVICE_META,
  },
]);

const errorLogger = (msg) => console.log(msg);

app.use("/rpc", rpcHandler);
app.use(createErrorHandler({ log: errorLogger }));
```

Then, if running on port 5000:

```
curl -X POST http://localhost:5000/rpc/doStuff
```

Also, to list runtime RPC metadata you can GET /rpc

```
curl -X GET http://localhost:5000/rpc
```

## Fetch-native handler (v5.11.0)

`createFetchHandler(services, { legacy?, log? })` returns an async
`(request: Request) => Promise<Response>` handler for Bun or other Fetch runtimes:

```ts
import { createFetchHandler } from "@loke/http-rpc";

const fetch = createFetchHandler([
  { implementation: myService, meta: MY_SERVICE_META },
]);
Bun.serve({ fetch, maxRequestBodySize: 11 * 1024 * 1024 });
```

Routes use the URL pathname: GET `/`, `/:service`, `/:service/:method`, and POST
`/:service/:method`. Strip any mount prefix before passing the request.
`legacy: true` also exposes `/:method` for a single service.
POST bodies with `application/json` (including charset parameters) are parsed;
empty bodies and other content types supply `{}`. Malformed JSON or non-object
JSON returns HTTP 400 with `{ "message": "Invalid JSON" }`.
Unmatched paths or methods return HTTP 404 with
`{ "message": "Not Found" }`: unlike Express middleware fall-through, a standalone
Fetch handler must produce a response.

Service errors and logging match `createErrorHandler`; void results become `null`.
Request IDs and deadlines use `x-request-id` and `x-request-deadline`. Contexts
abort on request-signal cancellation and when execution finishes. Configure body
size limits in the hosting server; the handler does not enforce them.

## Schemas and Context

Since v5.1.0 we now support
[JTD Schemas](https://jsontypedef.com/docs/jtd-in-5-minutes/) for requests and
responses validation (Via [AJV](https://ajv.js.org/json-type-definition.html)).

For more in-depth information about using the schema see `SCHEMAS.md`.

Since v5.3.0 we now support passing a context object to the service methods. Use `serviceWithSchema` if you don't want to use the context.

```ts
import {
  createRequestHandler,
  createErrorHandler,
  serviceWithSchema,
} from "@loke/http-rpc";
import { Context } from "@loke/context";

interface Thing {
  name: string;
}

const myService = {
  async doStuff(ctx: Context, args: {}) {
    return await Promise.resolve("stuff done");
  },
  async getThing(ctx: Context, args: { name: string }): Promise<Thing> {
    return { name: args.name };
  },
};

// Type for definitions
type Defs = { Thing: Thing };

// instead of `typeof myService` you could also name a type like
// type Service = {}
const myRpcService = contextServiceWithSchema<typeof myService, Defs>(
  myService,
  {
    name: "my-service",
    logger: console,
    // Record<string, JTD>
    definitions: {
      Thing: {
        properties: {
          name: { type: "string" },
        },
      },
    },
    methods: {
      doStuff: {
        help: "This is a silly method",
        // JTD
        requestTypeDef: {
          properties: {},
        },
        responseTypeDef: { type: "string" },
      },
      getThing: {
        help: "Get a thing",
        requestTypeDef: {
          properties: { name: { type: "string" } },
        },
        responseTypeDef: { ref: "Thing" },
      },
    },
  },
);

const rpcHandler = createRequestHandler([myRpcService]);

const errorLogger = (msg) => console.log(msg);

app.use("/rpc", rpcHandler);
app.use(createErrorHandler({ log: errorLogger }));
```

### Void result schema

Return types of `void` should generally be avoided, but if you need to use them
you can use `voidSchema` to define the schema for the response.

```ts
import { voidSchema } from "@loke/http-rpc";

const myService = {
  async doSomething(): Promise<void> {
    return;
  },
};

const myRpcService = serviceWithSchema(myService, {
  name: "my-service",
  logger: console,
  methods: {
    doSomething: {
      requestTypeDef: {
        properties: {},
      },
      responseTypeDef: voidSchema,
    },
  },
});
```
