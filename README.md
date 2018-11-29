# loke-http-rpc

```js
const lokeHttpRpc = require("loke-http-rpc");

const myService = {
  async doStuff() {
    return await Promise.resolve("stuff done");
  },
  moreStuff(stuffs) {
    return "you wanted " + stuffs;
  }
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
      params: [{ paramName: "stuffs", paramType: "integer" }],
      help: "This is a silly method",
      returnType: "string"
    }
  ]
};

const myRpcService = lokeHttpRpc.createRequestHandler(
  myService,
  MY_SERVICE_META
);

const errorLogger = msg => console.log(msg);

app.use("/rpc", myRpcService);
app.use(lokeHttpRpc.createErrorHandler({ log: errorLogger }));
```

Then, if running on port 5000:

```
curl -X POST http://localhost:5000/rpc/doStuff
```

Also, to list runtime RPC metadata you can GET /rpc

```
curl -X GET http://localhost:5000/rpc
```
