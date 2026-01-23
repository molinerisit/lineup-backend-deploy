const config = require("../config/env");

// Protege endpoints consumidos por el hardware si se define DEVICE_API_KEY
module.exports = (req, res, next) => {
  if (!config.deviceApiKey) return next();
  const provided = req.headers["x-device-key"] || req.headers["x-api-key"];
  if (provided && provided === config.deviceApiKey) return next();
  return res.status(401).json({ message: "Device API key requerida" });
};
