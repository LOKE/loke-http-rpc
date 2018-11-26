const pTap = require("p-tap");
const pFinally = require("p-finally");
const { Histogram, Counter } = require("prom-client");

const requestDuration = new Histogram({
  name: "http_rpc_request_duration_seconds",
  help: "Duration of rpc requests",
  labelNames: ["handler"]
});
const requestCount = new Counter({
  name: "http_rpc_requests_total",
  help: "The total number of rpc requests received",
  labelNames: ["handler"]
});
const failureCount = new Counter({
  name: "http_rpc_failures_total",
  help: "The total number of rpc failures received",
  labelNames: ["handler"]
});

class ExtendableError extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
    this.message = message;
    if (typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(this, this.constructor);
    } else {
      this.stack = new Error(message).stack;
    }
  }
}

class RpcError extends ExtendableError {
  constructor(serviceName, methodName, inner) {
    super(
      `An error occurred while executing method ${serviceName}/${methodName}`
    );
    this.serviceName = serviceName;
    this.methodName = methodName;
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
  };

  return (req, res, next) => {
    const methodName = req.path.slice(1); // remove leading slash
    const body = req.body;
    const args = multiArg ? body : [body];

    if (req.method === "GET" && req.path === "/") {
      return res.json(meta);
    }

    if (req.method !== "POST" || exposed.indexOf(methodName) === -1) {
      return next();
    }

    if (!Array.isArray(args)) {
      return res.status(400).json({
        message: "multiArg services require an array as input",
        code: "CRIT_INPUT_ERR"
      });
    }

    const requestMeta = { handler: `${serviceName}.${methodName}` };
    const end = requestDuration.startTimer(requestMeta);

    requestCount.inc(requestMeta);

    const result = Promise.resolve()
      .then(() => service[methodName].apply(service, args))
      .then(result => res.json(result))
      .catch(pTap.catch(() => failureCount.inc(requestMeta)))
      .catch(err => {
        next(new RpcError(serviceName, methodName, err));
      });

    return pFinally(result, end);
  };
};

exports.createErrorHandler = (args = {}) => {
  const { log = () => {} } = args;
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    if (!(err instanceof RpcError)) {
      return res.status(500).json({ message: err.message });
    }

    log(
      `Error executing ${err.serviceName}/${err.methodName}: ${err.inner.stack}`
    );
    if (!err.inner.type) {
      return res.status(400).json({
        message: err.inner.message,
        code: err.inner.code,
        expose:
          typeof err.inner.expose === "boolean"
            ? err.inner.expose
            : Boolean(err.inner.code) // for legacy errors, set expose only if there is a code
      });
    }

    return res.status(400).json(err.inner);
  };
};
