
module.exports = (service, serviceDetails) => {
  const exposed = serviceDetails.expose;
  const multArg = serviceDetails.multArg || false;
  const serviceName = serviceDetails.service;

  const meta = {
    serviceName,
    multArg,
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
    const args = multArg ? body : [body];

    console.log(req.method, methodName, body, args);

    if (req.method === 'GET' && req.path === '/') {
      return res.json(meta);
    }

    if (req.method !== 'POST' || exposed.indexOf(methodName) === -1) {
      return next();
    }

    if (!Array.isArray(args)) {
      return res.status(400).json({
        message: 'multArg services require an array as input',
        code: 'CRIT_INPUT_ERR'
      });
    }

    try {
      Promise.resolve(service[methodName].apply(null, args))
      .then(result => res.json(result))
      .catch(err => next(err));
    } catch (err) {
      next(err);
    }
  };
}
