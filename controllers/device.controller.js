const asyncHandler = require("../utils/async-handler");

let lastDeviceStatus = {
  online: false,
  ip: "--",
  oneWirePin: 25,
  doorPins: "26, 27, 14",
  physicalSensors: 0,
  configuredSensors: 0,
  mapping: [],
  timestamp: null,
};

exports.updateStatus = asyncHandler((req, res) => {
  lastDeviceStatus = {
    ...lastDeviceStatus,
    ...req.body,
    online: true,
    timestamp: new Date(),
  };
  res.json({ message: "OK" });
});

exports.getStatus = asyncHandler((_req, res) => {
  const now = new Date();
  if (lastDeviceStatus.timestamp && now - new Date(lastDeviceStatus.timestamp) > 120000) {
    lastDeviceStatus.online = false;
  }
  res.json(lastDeviceStatus);
});
