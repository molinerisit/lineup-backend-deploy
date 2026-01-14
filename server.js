require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const axios = require("axios");
const QuickChart = require("quickchart-js");

const Measurement = require("./models/Measurement");
const Sensor = require("./models/Sensor");
const User = require("./models/User");

const app = express();
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3000;

// ==========================================
// ESTADO Y CONFIGURACIÓN GLOBAL
// ==========================================
let lastDeviceStatus = {
  online: false,
  ip: "--",
  oneWirePin: 0,
  physicalSensors: 0,
  configuredSensors: 0,
  mapping: [],
  timestamp: null,
};

const ESP_HARDWARE_IDS = [
  "HELADERA-01",
  "HELADERA-02",
  "HELADERA-03",
  "HELADERA-04",
  "HELADERA-05",
];

// ==========================================
// CONEXIÓN A BASE DE DATOS
// ==========================================
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ MongoDB Conectado"))
  .catch((err) => console.error("❌ Error Mongo:", err));

app.use(express.json());
app.use(cors({ origin: "*" }));

// ==========================================
// MIDDLEWARE DE AUTENTICACIÓN
// ==========================================
const authenticateUser = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ message: "No token provided" });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      console.log("❌ Error de JWT:", err.message);
      return res.status(401).json({ message: "Token inválido o expirado" });
    }
    req.user = user;
    next();
  });
};

// ==========================================
// FUNCIONES WHATSAPP (Evolution API)
// ==========================================
const responderWhatsApp = async (number, text) => {
  try {
    await axios.post(
      `${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`,
      { number: number, text: text },
      { headers: { apikey: process.env.EVOLUTION_API_KEY } }
    );
  } catch (error) {
    console.error("❌ Error texto WA:", error.message);
  }
};

const responderWhatsAppConImagen = async (number, imageUrl, caption = "") => {
  try {
    await axios.post(
      `${process.env.EVOLUTION_API_URL}/message/sendImage/${process.env.EVOLUTION_INSTANCE}`,
      { number: number, url: imageUrl, caption: caption },
      { headers: { apikey: process.env.EVOLUTION_API_KEY } }
    );
  } catch (error) {
    console.error("❌ Error imagen WA:", error.message);
  }
};

const sendWhatsAppAlert = async (number, sensorName, temp) => {
  const mensaje = `🚨 *ALERTA DE TEMPERATURA*\n\n📍 *Equipo:* ${sensorName}\n🌡️ *Temperatura:* ${temp}°C\n\n⚠️ _Límite superado._`;
  await responderWhatsApp(number, mensaje);
};

// ==========================================
// RUTAS DE AUTENTICACIÓN Y PERFIL (CORREGIDAS)
// ==========================================
app.post("/api/auth/register", async (req, res) => {
  try {
    const user = new User(req.body);
    await user.save();
    res.json({ message: "Usuario creado" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const user = await User.findOne({ username: req.body.username });
    if (!user || !(await bcrypt.compare(req.body.password, user.password))) {
      return res.status(401).json({ message: "Credenciales inválidas" });
    }
    const token = jwt.sign(
      { id: user._id, username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );
    res.json({ token, username: user.username });
  } catch (e) {
    res.status(500).send("Error");
  }
});

// Usamos una ruta flexible para evitar el 404
app.get(
  ["/api/auth/profile", "/api/auth/profile/"],
  authenticateUser,
  async (req, res) => {
    try {
      console.log("👤 Petición de perfil para ID:", req.user.id);
      const user = await User.findById(req.user.id).select("-password");
      if (!user) return res.status(404).json({ message: "No encontrado" });
      res.json(user);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

app.put("/api/auth/profile", authenticateUser, async (req, res) => {
  try {
    const { whatsapp, oldPassword, newPassword } = req.body;
    const user = await User.findById(req.user.id);
    if (newPassword) {
      const isMatch = await bcrypt.compare(oldPassword, user.password);
      if (!isMatch) return res.status(401).json({ message: "Pass incorrecta" });
      user.password = newPassword;
    }
    if (whatsapp) user.whatsapp = whatsapp;
    await user.save();
    res.json({ message: "Actualizado" });
  } catch (err) {
    res.status(500).send("Error");
  }
});

app.delete("/api/auth/profile", authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;
    await Sensor.deleteMany({ owner: userId });
    await User.findByIdAndDelete(userId);
    res.json({ message: "Cuenta eliminada" });
  } catch (err) {
    res.status(500).send("Error");
  }
});

// ==========================================
// GESTIÓN DE SENSORES E HISTORIAL
// ==========================================
app.get("/api/latest", authenticateUser, async (req, res) => {
  try {
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
          alertThreshold: { $first: "$alertThreshold" },
          temperatureC: { $first: "$m.temperatureC" },
          voltageV: { $first: "$m.voltageV" },
          timestamp: { $first: "$m.timestamp" },
        },
      },
    ]);
    res.json(data);
  } catch (err) {
    res.status(500).send("Error");
  }
});

app.get("/api/history", authenticateUser, async (req, res) => {
  try {
    const { sensorId, limit = 50 } = req.query;
    const docs = await Measurement.find({ sensorId })
      .sort({ timestamp: -1 })
      .limit(Number(limit));
    res.json(docs);
  } catch (err) {
    res.status(500).json([]);
  }
});

app.post("/api/sensors/config", authenticateUser, async (req, res) => {
  try {
    const sensorData = { ...req.body, owner: req.user.id, enabled: true };
    const sensor = await Sensor.findOneAndUpdate(
      { hardwareId: req.body.hardwareId },
      sensorData,
      { upsert: true, new: true }
    );
    res.json(sensor);
  } catch (err) {
    res.status(500).json({ error: "Error" });
  }
});

// ==========================================
// RECEPCIÓN DE DATOS (ESP32)
// ==========================================
app.post("/api/data", async (req, res) => {
  const { sensorId, tempC, voltageV } = req.body;
  try {
    const sensor = await Sensor.findOne({ hardwareId: sensorId }).populate(
      "owner"
    );
    if (!sensor) return res.status(404).send("No sensor");
    await new Measurement({
      sensorId,
      temperatureC: Number(tempC),
      voltageV: Number(voltageV),
    }).save();
    res.send("OK");
  } catch (err) {
    res.status(500).send("Error");
  }
});

app.get("/api/sensors/ids", authenticateUser, (req, res) =>
  res.json(ESP_HARDWARE_IDS)
);
app.get("/api/device/status", authenticateUser, (req, res) =>
  res.json(lastDeviceStatus)
);

app.listen(PORT, () => console.log(`🚀 Servidor Final en puerto ${PORT}`));
