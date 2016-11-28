# loke-http-rpc

```js
const lokeHttpRpc = require('loke-http-rpc');

const myService = {
  doStuff() {
    return Promise.resolve('stuff done');
  }
};

const MY_SERVICE_META = {
  service: 'my-service', // display name
  multiArg: false, // defaults to false. If true accepts an array for arguments, if false an array will be assumed to be the first (and only) argument.
  expose: [  // The methods to be exposed publically
    'doStuff'
  ]
};

const myRpcService = lokeHttpRpc.createRequestHandler(myService, MY_SERVICE_META);

app.use('/rpc', myRpcService);
```

Then, if running on port 5000:

```
curl -X POST http://localhost:5000/rpc/doStuff
```

Also, to list runtime RPC metadata you can GET /rpc

```
curl -X GET http://localhost:5000/rpc
```
