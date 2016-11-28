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

    return Promise.resolve()
    .then(() => service[methodName].apply(service, args))
    .then(result => res.json(result))
    .catch(err => {
      next(new RpcError(methodName, err));
    });
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
