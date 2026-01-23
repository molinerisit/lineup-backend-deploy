const mongoose = require("mongoose");
const Sensor = require("../models/Sensor");
const Measurement = require("../models/Measurement");
const ESP_IDS = require("../constants/espHardwareIds");
const asyncHandler = require("../utils/async-handler");

exports.getLatest = asyncHandler(async (req, res) => {
  console.log('📡 GET /sensors/latest - Usuario:', req.user.id);
  
  const data = await Sensor.aggregate([
    {
      $match: {
        owner: new mongoose.Types.ObjectId(req.user.id),
        enabled: true,
      },
    },
    {
      $lookup: {
        from: "measurements",
        localField: "hardwareId",
        foreignField: "sensorId",
        as: "m",
      },
    },
    { $unwind: { path: "$m", preserveNullAndEmptyArrays: true } },
    { $sort: { "m.timestamp": -1 } },
    {
      $group: {
        _id: "$hardwareId",
        friendlyName: { $first: "$friendlyName" },
        maxThreshold: { $first: "$maxThreshold" },
        minThreshold: { $first: "$minThreshold" },
        isDoorOpen: { $first: "$isDoorOpen" },
        temperatureC: { $first: "$m.temperatureC" },
        voltageV: { $first: "$m.voltageV" },
        timestamp: { $first: "$m.timestamp" },
      },
    },
  ]);
  
  console.log(`✅ Sensores encontrados: ${data.length}`, data.map(d => ({ id: d._id, name: d.friendlyName })));
  res.json(data);
});

exports.getHistory = asyncHandler(async (req, res) => {
  const { sensorId, limit = 50 } = req.query;
  if (!sensorId) return res.status(400).json({ message: "sensorId requerido" });

  const docs = await Measurement.find({ sensorId, owner: req.user.id })
    .sort({ timestamp: -1 })
    .limit(Number(limit))
    .lean();
  res.json(docs);
});

exports.upsertSensor = asyncHandler(async (req, res) => {
  const { hardwareId, friendlyName, minThreshold, maxThreshold, voltageThreshold, pin } = req.body;
  console.log('📤 POST /sensors/config - Datos:', { hardwareId, friendlyName, minThreshold, maxThreshold, pin });
  
  if (!hardwareId || !friendlyName || pin === undefined)
    return res.status(400).json({ message: "hardwareId, friendlyName y pin son requeridos" });

  if (!ESP_IDS.includes(hardwareId))
    return res.status(400).json({ message: "ID de hardware no permitido" });

  const sensor = await Sensor.findOneAndUpdate(
    { hardwareId, owner: req.user.id },
    {
      hardwareId,
      friendlyName,
      minThreshold,
      maxThreshold,
      voltageThreshold,
      pin,
      enabled: true,
      owner: req.user.id,
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  console.log('✅ Sensor guardado:', sensor._id, sensor.hardwareId, sensor.friendlyName);
  res.json(sensor);
});

exports.deleteSensor = asyncHandler(async (req, res) => {
  const { hardwareId } = req.params;
  const sensor = await Sensor.findOneAndDelete({ hardwareId, owner: req.user.id });
  if (sensor) await Measurement.deleteMany({ sensorId: hardwareId, owner: req.user.id });
  res.json({ message: "Eliminado" });
});

exports.getHardwareIds = asyncHandler(async (_req, res) => {
  res.json(ESP_IDS);
});
