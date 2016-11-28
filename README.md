# loke-http-rpc

```js
const lokeHttpRpc = require('loke-http-rpc');

const myService = {
  doStuff() {
    return Promise.resolve('stuff done');
  }
};

const MY_SERVICE_META = {
  service: 'my-service',
  expose: [
    'doStuff'
  ]
};

const myRpcService = lokeHttpRpc.createRequestHandler(myService, MY_SERVICE_META);

app.use('/rpc', myRpcService);
```
