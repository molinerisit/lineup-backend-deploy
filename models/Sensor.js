const mongoose = require("mongoose");

const sensorSchema = new mongoose.Schema(
  {
    hardwareId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    friendlyName: {
      type: String,
      required: true,
    },
    // Umbrales Duales
    minThreshold: {
      type: Number,
      default: 0.0,
    },
    maxThreshold: {
      type: Number,
      default: 10.0,
    },
    voltageThreshold: {
      type: Number,
      default: 4.2,
    },
    pin: {
      type: Number,
      required: true,
    },
    address: {
      type: String,
      default: null,
    },
    lastAlertSent: { type: Date, default: null },
    isAcknowledged: { type: Boolean, default: false },
    enabled: {
      type: Boolean,
      default: true,
    },
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Sensor", sensorSchema);