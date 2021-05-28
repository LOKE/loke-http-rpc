# loke-http-rpc

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
    // BREAKING CHANGE: expose now requires an object
    { methodName: "doStuff" },
    {
      methodName: "moreStuff",
      methodTimeout: 15000,
      paramNames: ["stuffs"],
      help: "This is a silly method",
    },
  ],
};

//BREAKING CHANGE: `createRequestHandler` was renamed to createWellKnownHandler and can be accesed through register()
//Added new createWellKnownHandler which serves the metadata
//WELL_KNOWN_META_PATH represents the path where meta data served

const myRpcService = registry.register(myService, MY_SERVICE_META)
  .createWellKnownHandler;

const wellKnownHandler = registry.createWellKnownHandler();

const errorLogger = (msg) => console.log(msg);

app.use("/rpc", myRpcService);
app.use(createErrorHandler({ log: errorLogger }));
app.get(WELL_KNOWN_META_PATH, wellKnownHandler);
```

Then, if running on port 5000:

```
curl -X POST http://localhost:5000/rpc/doStuff
```

Also, to list runtime RPC metadata you can GET /rpc

```
curl -X GET http://localhost:5000/rpc
```
