const router = require("express").Router();
const mongoose = require("mongoose");
const auth = require("../middlewares/auth");
const asyncHandler = require("../utils/async-handler");
const Measurement = require("../models/Measurement");
const Sensor = require("../models/Sensor");

// GET /api/latest - Latest snapshot per sensor for the logged-in user
router.get("/latest", auth, asyncHandler(async (req, res) => {
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

  res.json(data);
}));

// GET /api/history - Get measurement history
router.get("/history", auth, asyncHandler(async (req, res) => {
  const { sensorId, limit = 100 } = req.query;
  
  const query = { owner: req.user.id };
  if (sensorId) query.sensorId = sensorId;

  const data = await Measurement.find(query)
    .sort({ timestamp: -1 })
    .limit(parseInt(limit))
    .lean();

  res.json(data);
}));

module.exports = router;
