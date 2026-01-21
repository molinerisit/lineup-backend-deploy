const Sensor = require("../models/Sensor");
const Measurement = require("../models/Measurement");
const { sendWhatsAppAlert, responderWhatsApp } = require("../services/whatsapp.service");
const config = require("../config/env");
const asyncHandler = require("../utils/async-handler");

const parseNumber = (value) => {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

exports.ingestMeasurement = asyncHandler(async (req, res) => {
  const sensorId = req.body.sensorId || req.body.id;
  const tempNum = parseNumber(req.body.tempC ?? req.body.temp);
  const voltageNum = parseNumber(req.body.voltageV ?? req.body.battery ?? req.body.voltage);
  const doorOpenRaw = req.body.doorOpen ?? 0;
  const doorOpen = Number(doorOpenRaw) === 1 ? 1 : 0;
  const timestamp = req.body.timestamp ? new Date(req.body.timestamp) : new Date();

  if (!sensorId || tempNum === null || voltageNum === null)
    return res.status(400).json({ message: "sensorId, temp y voltage requeridos" });

  const sensor = await Sensor.findOne({ hardwareId: sensorId }).populate("owner");
  if (!sensor) return res.status(404).json({ message: "Sensor no configurado" });

  const user = sensor.owner;
  // Guardar historial
  await Measurement.create({
    sensorId,
    owner: user._id,
    temperatureC: tempNum,
    voltageV: voltageNum,
    doorOpen,
    timestamp,
  });

  // Lógica de puerta
  const now = new Date();
  const estaAbierta = doorOpen === 1;
  const doorUpdate = { isDoorOpen: estaAbierta };

  if (estaAbierta) {
    if (!sensor.isDoorOpen) doorUpdate.doorOpenedAt = now;
    else {
      const lastOpened = sensor.doorOpenedAt || now;
      const diff = now - lastOpened;
      if (diff > 120000 && user.whatsappAlerts && user.useDoorSensors) {
        await responderWhatsApp(
          user.whatsapp,
          `🚪 *PUERTA ABIERTA:* "${sensor.friendlyName}" lleva +2 min abierta.`
        );
        doorUpdate.doorOpenedAt = now;
      }
    }
  } else {
    doorUpdate.doorOpenedAt = null;
  }

  await Sensor.updateOne({ hardwareId: sensorId }, { $set: doorUpdate });

  // Reset de acknowledge cuando vuelve a rango
  if (
    tempNum >= sensor.minThreshold &&
    tempNum <= sensor.maxThreshold &&
    sensor.isAcknowledged
  ) {
    await Sensor.updateOne({ hardwareId: sensorId }, { isAcknowledged: false });
  }

  let tipoAlerta = null;
  if (tempNum > sensor.maxThreshold) tipoAlerta = "ALTA";
  if (tempNum < sensor.minThreshold) tipoAlerta = "BAJA";

  if (tipoAlerta && !sensor.isAcknowledged && user.whatsappAlerts) {
    const cooldownMs = config.alertCooldownMinutes * 60000;
    const puedeAlertar = !sensor.lastAlertSent || now - sensor.lastAlertSent > cooldownMs;
    if (puedeAlertar) {
      await sendWhatsAppAlert(user.whatsapp, sensor.friendlyName, tempNum, tipoAlerta);
      await Sensor.updateOne({ hardwareId: sensorId }, { lastAlertSent: now });
    }
  }

  res.json({ message: "OK" });
});

exports.deviceConfig = asyncHandler(async (_req, res) => {
  const sensors = await Sensor.find({ enabled: true }).select("hardwareId pin -_id");
  res.json(sensors);
});
