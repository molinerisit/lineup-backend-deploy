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
const PORT = process.env.PORT || 3000;

app.set("trust proxy", 1);
app.use(express.json());
app.use(cors({ origin: "*" }));

// ==========================================
// MIDDLEWARE DE AUTENTICACIÓN
// ==========================================
const authenticateUser = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    console.log("⚠️ Intento de acceso sin Token");
    return res.status(401).json({ message: "No token provided" });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      console.log("❌ Token inválido:", err.message);
      return res.status(403).json({ message: "Token inválido" });
    }
    req.user = user;
    next();
  });
};

// ==========================================
// RUTAS DE AUTENTICACIÓN Y PERFIL
// ==========================================
app.get("/health", (req, res) =>
  res.send(`✅ Servidor Operativo en Puerto ${PORT}`)
);

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
    console.log(`✅ Login exitoso: ${user.username}`);
    res.json({ token, username: user.username });
  } catch (e) {
    res.status(500).send("Error");
  }
});

app.get("/api/auth/profile", authenticateUser, async (req, res) => {
  try {
    console.log(`👤 Petición de perfil para ID: ${req.user.id}`);
    const user = await User.findById(req.user.id).select("-password");
    if (!user) return res.status(404).json({ message: "No encontrado" });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// FUNCIONES DE WHATSAPP Y ALERTAS
// ==========================================
const responderWhatsApp = async (number, text) => {
  try {
    await axios.post(
      `${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`,
      { number: number, text: text },
      { headers: { apikey: process.env.EVOLUTION_API_KEY } }
    );
  } catch (error) {
    console.error("❌ Error WA:", error.message);
  }
};

// ==========================================
// RUTAS DE DATOS Y SENSORES
// ==========================================
app.post("/api/data", async (req, res) => {
  const { sensorId, tempC, voltageV } = req.body;
  try {
    const sensor = await Sensor.findOne({ hardwareId: sensorId }).populate(
      "owner"
    );
    if (!sensor) return res.status(404).send("Sensor no configurado");
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

mongoose.connect(process.env.MONGODB_URI).then(() => {
  console.log("✅ MongoDB Conectado");
  app.listen(PORT, () => console.log(`🚀 Servidor en puerto ${PORT}`));
});
