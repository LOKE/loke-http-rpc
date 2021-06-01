# loke-http-rpc

## Breaking Changes for v5

Services need to be registered before a request handler can be created.

### Migrating from v4 to v5

- Services now needs to be registered before creating a request handler
- You can now create a request handler for multiple services contained in a separate registry
- Added new well know handler ("createWellKnownMetaHandler()") that serves service metadata
- Exposing well-known URL for uniformity across the system to access service metadata

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

Need to register service on registry before requesting request handler
createRequestHandler on Registry adds the service name to the path where its exposed. ("/rpc/service-name"). This allows to handle multiple services with single registry

- registry.register() registers the service
- registry.createRequestHandler() will process RPC requests for methods exposed by the service, as well as return metadata about the service
- registry.createWellKnownMetaHandler() serves service metadata
- registry.createErrorHandler() handles errors in processing rpc requests
- WELL_KNOWN_META_PATH returns default path to expose discovery metadata on a well-known URL

```js
const {
  registry,
  createErrorHandler,
  WELL_KNOWN_META_PATH,
} = require("loke-http-rpc");

registry.register(myService, MY_SERVICE_META);

//service will be exposed on /rpc/service-name
app.use("/rpc", registry.createRequestHandler());
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
