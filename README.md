# loke-http-rpc

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
const lokeHttpRpc = require("loke-http-rpc");

const myRpcService = lokeHttpRpc.createRequestHandler(
  myService,
  MY_SERVICE_META
);
app.use("/rpc", myRpcService);
app.use(lokeHttpRpc.createErrorHandler({ log: (msg) => console.log(msg) }));
```

### v5:

createRequestHandler adds the service name to the path where its exposed. ("/rpc/service-name"). This allows to handle multiple services with single handler.

```js
const { createRequestHandler, createErrorHandler } = require("loke-http-rpc");

// service will be exposed on /rpc/service-name
app.use(
  "/rpc",
  createRequestHandler([{ implementation: myService, meta: MY_SERVICE_META }])
);
app.use(createErrorHandler({ log: (msg) => console.log(msg) }));

// or... service will be exposed on /rpc AND /rpc/service-name
// but will be limited to 1 service
app.use(
  "/rpc",
  createRequestHandler([{ implementation: myService, meta: MY_SERVICE_META }], {
    legacy: true,
  })
);
app.use(createErrorHandler({ log: (msg) => console.log(msg) }));
```

## Implementation Guide

```js
const {
  registry,
  createErrorHandler,
  WELL_KNOWN_META_PATH,
} = require("loke-http-rpc");

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

registry.register(myService, MY_SERVICE_META);

const errorLogger = (msg) => console.log(msg);

app.use("/rpc", registry.createRequestHandler());
app.get(WELL_KNOWN_META_PATH, registry.createWellKnownMetaHandler());
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
