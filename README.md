# loke-http-rpc

## Breaking Changes for v5

Services need to be registered before a request handler can be created.

### Migrating from v4 to v5

- Services now needs to be registered before creating a request handler
- Added new well know handler ("createWellKnownMetaHandler()") that serves service metadata
- Exposing well-known URL for uniformity across the system to access service metadata

### v4:

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

```js
const {
  registry,
  createErrorHandler,
  WELL_KNOWN_META_PATH,
} = require("loke-http-rpc");

const myRpcService = registry.register(myService, MY_SERVICE_META)
  .createRequestHandler;

app.use("/rpc", myRpcService);
app.get(WELL_KNOWN_META_PATH, registry.createWellKnownMetaHandler());
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

const myRpcService = registry.register(myService, MY_SERVICE_META)
  .createRequestHandler;

const errorLogger = (msg) => console.log(msg);

app.use("/rpc", myRpcService);
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
