const asyncHandler = require("../utils/async-handler");
const config = require("../config/env");

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
  console.log('📤 POST /api/device/status body:', JSON.stringify(req.body, null, 2));
  
  const body = { ...req.body };
  // Normalización de doorPins: aceptar 'doorPin' numérico del firmware
  if (body.doorPins === undefined && body.doorPin !== undefined) {
    body.doorPins = String(body.doorPin);
    console.log('✅ doorPin normalizado a doorPins:', body.doorPins);
  }
  // Asegurar tipos básicos del mapeo: hardwareId/address como string
  if (Array.isArray(body.mapping)) {
    console.log('✅ Mapping recibido (antes):', JSON.stringify(body.mapping));
    body.mapping = body.mapping.map((m) => ({
      hardwareId: m && m.hardwareId != null ? String(m.hardwareId) : "",
      address: m && m.address != null ? String(m.address) : "",
    }));
    console.log('✅ Mapping normalizado (después):', JSON.stringify(body.mapping));
  } else {
    console.log('⚠️ Mapping no es array o vacío');
  }

  lastDeviceStatus = {
    ...lastDeviceStatus,
    ...body,
    online: true,
    timestamp: new Date(),
  };
  console.log('💾 lastDeviceStatus guardado:', JSON.stringify(lastDeviceStatus, null, 2));
  res.json({ message: "OK" });
});

exports.getStatus = asyncHandler((_req, res) => {
  const now = new Date();
  const thresholdMs = (config.deviceOfflineSeconds || 30) * 1000;
  const ts = lastDeviceStatus.timestamp ? new Date(lastDeviceStatus.timestamp) : null;
  const diffMs = ts ? now - ts : null;

  console.log(`📡 GET /api/device/status - Online antes: ${lastDeviceStatus.online}, Threshold: ${thresholdMs}ms, TimestampDiff: ${diffMs}ms`);
  if (!ts || now - ts > thresholdMs) {
    lastDeviceStatus.online = false;
    console.log('🔴 Marcando OFFLINE (sin timestamp o excedió umbral)');
  }

  console.log(`📤 GET /api/device/status respuesta:`, JSON.stringify(lastDeviceStatus, null, 2));
  res.json(lastDeviceStatus);
});
// Función getter para inspeccionar el estado
exports.getLastDeviceStatus = () => lastDeviceStatus;