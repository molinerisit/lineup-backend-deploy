const router = require("express").Router();
const auth = require("../middlewares/auth");
const asyncHandler = require("../utils/async-handler");
const Measurement = require("../models/Measurement");
const Sensor = require("../models/Sensor");

// GET /api/latest - Get latest measurement for each sensor
router.get("/latest", auth, asyncHandler(async (req, res) => {
  const data = await Measurement.aggregate([
    { $match: { owner: req.user.id } },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: "$sensorId",
        tempC: { $first: "$tempC" },
        voltageV: { $first: "$voltageV" },
        createdAt: { $first: "$createdAt" },
      }
    }
  ]);

  res.json(data);
}));

// GET /api/history - Get measurement history
router.get("/history", auth, asyncHandler(async (req, res) => {
  const { sensorId, limit = 100 } = req.query;
  
  const query = { owner: req.user.id };
  if (sensorId) query.sensorId = sensorId;

  const data = await Measurement.find(query)
    .sort({ createdAt: -1 })
    .limit(parseInt(limit));

  res.json(data);
}));

module.exports = router;
