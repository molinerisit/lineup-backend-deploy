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
  
  // Recibir ambos sensores de puerta del ESP32
  const doorOpen1Raw = req.body.doorOpen1 ?? req.body.doorOpen ?? 0;
  const doorOpen2Raw = req.body.doorOpen2 ?? 0;
  const doorOpen1 = Number(doorOpen1Raw) === 1 ? 1 : 0;
  const doorOpen2 = Number(doorOpen2Raw) === 1 ? 1 : 0;
  
  const timestamp = req.body.timestamp ? new Date(req.body.timestamp) : new Date();

  if (!sensorId || tempNum === null || voltageNum === null)
    return res.status(400).json({ message: "sensorId, temp y voltage requeridos" });

  const sensor = await Sensor.findOne({ hardwareId: sensorId }).populate("owner");
  if (!sensor) return res.status(404).json({ message: "Sensor no configurado" });

  const user = sensor.owner;
  
  // Determinar qué doorOpen guardar según el doorPin del sensor
  let doorOpenToSave = 0;
  if (sensor.doorPin === 4) {
    doorOpenToSave = doorOpen1;
  } else if (sensor.doorPin === 16) {
    doorOpenToSave = doorOpen2;
  }
  
  // Guardar historial con el estado de puerta específico
  await Measurement.create({
    sensorId,
    owner: user._id,
    temperatureC: tempNum,
    voltageV: voltageNum,
    doorOpen: doorOpenToSave,
    timestamp,
  });

  // Lógica de puerta - solo procesamos la puerta asignada a este sensor
  const now = new Date();
  let estaAbierta = false;
  
  // Determinar qué puerta corresponde a este sensor según su doorPin configurado
  if (sensor.doorPin === 4) {
    estaAbierta = doorOpen1 === 1;
  } else if (sensor.doorPin === 16) {
    estaAbierta = doorOpen2 === 1;
  }
  
  const doorUpdate = { isDoorOpen: estaAbierta };

  if (estaAbierta) {
    if (!sensor.isDoorOpen) {
      doorUpdate.doorOpenedAt = now;
    } else {
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
  const sensors = await Sensor.find({ enabled: true }).select("hardwareId pin doorPin -_id");
  res.json(sensors);
});
