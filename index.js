const pTap = require('p-tap');
const pFinally = require('p-finally')
const {Histogram, Counter} = require('prom-client');

const requestDuration = new Histogram('http_rpc_request_duration_seconds', 'Duration of rpc requests', ['handler']);
const requestCount = new Counter('http_rpc_requests_total', 'The total number of rpc requests received', ['handler']);
const failureCount = new Counter('http_rpc_failures_total', 'The total number of rpc failures received', ['handler']);

class ExtendableError extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
    this.message = message;
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, this.constructor);
    } else {
      this.stack = (new Error(message)).stack;
    }
  }
}

class RpcError extends ExtendableError {
  constructor(methodName, inner) {
    super(`An error occurred while executing method ${methodName}`);
    this.inner = inner;
  }
}

exports.createRequestHandler = (service, serviceDetails) => {
  const exposed = serviceDetails.expose;
  const multiArg = serviceDetails.multiArg || serviceDetails.multArg || false;
  const serviceName = serviceDetails.service;

  const meta = {
    serviceName,
    multiArg,
    interfaces: exposed.map(methodName => {
      return {
        methodName,
        methodTimeout: 60000
      };
    })
  }

  return (req, res, next) => {
    const methodName = req.path.slice(1); // remove leading slash
    const body = req.body;
    const args = multiArg ? body : [body];

    if (req.method === 'GET' && req.path === '/') {
      return res.json(meta);
    }

    if (req.method !== 'POST' || exposed.indexOf(methodName) === -1) {
      return next();
    }

    if (!Array.isArray(args)) {
      return res.status(400).json({
        message: 'multiArg services require an array as input',
        code: 'CRIT_INPUT_ERR'
      });
    }

    const requestMeta = {handler: `${serviceName}.${methodName}`};
    const end = requestDuration.startTimer(requestMeta);

    requestCount.inc(requestMeta);

    const result = Promise.resolve()
    .then(() => service[methodName].apply(service, args))
    .then(result => res.json(result))
    .catch(pTap.catch(() => failureCount.inc(requestMeta)))
    .catch(err => {
      next(new RpcError(methodName, err));
    });

    return pFinally(result, end);
  }
};

exports.createErrorHandler = () => {
  return (err, req, res, next) => {
    if (err instanceof RpcError) {
      res.status(400).json({
        message: err.inner.message,
        code: err.inner.code
      });
    } else {
      res.status(500).json({
        message: err.message
      });
    }
  };
};
