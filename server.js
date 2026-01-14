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
// CONEXIÓN A DB
// ==========================================
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ MongoDB Conectado"))
  .catch((err) => console.error("❌ Error Mongo:", err));

app.use(express.json());
app.use(cors({ origin: "*" }));

// ==========================================
// ESTADO HARDWARE
// ==========================================
let lastDeviceStatus = { online: false, ip: "--", timestamp: null };
const ESP_HARDWARE_IDS = [
  "HELADERA-01",
  "HELADERA-02",
  "HELADERA-03",
  "HELADERA-04",
  "HELADERA-05",
];

// ==========================================
// FUNCIONES WHATSAPP (CON LOGS DE SALIDA)
// ==========================================
const responderWhatsApp = async (number, text) => {
  try {
    const url = `${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`;
    await axios.post(
      url,
      { number: number, text: text },
      { headers: { apikey: process.env.EVOLUTION_API_KEY } }
    );
    console.log(`📤 Respuesta enviada a ${number}`);
  } catch (error) {
    console.error(
      "❌ Error enviando a Evolution API:",
      error.response?.data || error.message
    );
  }
};

const sendWhatsAppAlert = async (number, sensorName, temp) => {
  const tempF = parseFloat(temp).toFixed(2);
  const mensaje = `🚨 *ALERTA DE TEMPERATURA*\n\n📍 *Equipo:* ${sensorName}\n🌡️ *Temperatura:* ${tempF}°C\n\n⚠️ _Límite superado._\n\n*Responde con un número:*\n1️⃣ - ✅ *Recibido*\n2️⃣ - 📊 *Historial Reciente*\n3️⃣ - 📋 *Estado General*`;
  await responderWhatsApp(number, mensaje);
};

// ==========================================
// WEBHOOK: CHATBOT (OPTIMIZADO PARA VELOCIDAD)
// ==========================================
app.post("/api/webhook/whatsapp", async (req, res) => {
  res.sendStatus(200); // Responder OK a WhatsApp de inmediato

  try {
    const data = req.body.data;
    if (!data || !data.message) return;

    const from = data.key.remoteJid.split("@")[0];
    const text = (
      data.message.conversation ||
      data.message.extendedTextMessage?.text ||
      data.message.text ||
      ""
    )
      .trim()
      .toLowerCase();

    console.log(`💬 Procesando "${text}" de ${from}`);

    const user = await User.findOne({ whatsapp: from });
    if (!user)
      return console.log("⚠️ Usuario no registrado para este WhatsApp.");

    // OPCIÓN 1: SILENCIAR
    if (text === "1") {
      const s = await Sensor.findOneAndUpdate(
        { owner: user._id, lastAlertSent: { $ne: null } },
        { isAcknowledged: true },
        { sort: { lastAlertSent: -1 } }
      );
      if (s)
        await responderWhatsApp(
          from,
          `✅ *Silenciado:* No recibirás más avisos de "${s.friendlyName}" hasta que se normalice.`
        );
    }

    // OPCIÓN 2: HISTORIAL (MEJORADO)
    else if (text === "2") {
      const sensors = await Sensor.find({
        owner: user._id,
        enabled: true,
      }).lean();
      if (!sensors.length)
        return await responderWhatsApp(from, "❌ No hay sensores activos.");

      let historialMsg = `📊 *ÚLTIMOS DATOS (2 decimales)*\n\n`;

      for (const s of sensors) {
        const docs = await Measurement.find({ sensorId: s.hardwareId })
          .sort({ timestamp: -1 })
          .limit(5)
          .lean();
        historialMsg += `*${s.friendlyName}:*\n`;
        if (docs.length > 0) {
          docs.forEach((m) => {
            const hora = new Date(m.timestamp).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            });
            historialMsg += `• ${hora}: *${m.temperatureC.toFixed(2)}°C*\n`;
          });
        } else {
          historialMsg += `(Sin datos recientes)\n`;
        }
        historialMsg += `\n`;
      }
      await responderWhatsApp(from, historialMsg);
    }

    // OPCIÓN 3: ESTADO GENERAL
    else if (text === "3" || text === "estado") {
      const sensors = await Sensor.find({
        owner: user._id,
        enabled: true,
      }).lean();
      let reporte = `📋 *ESTADO GENERAL*\n\n`;
      for (const s of sensors) {
        const lastM = await Measurement.findOne({ sensorId: s.hardwareId })
          .sort({ timestamp: -1 })
          .lean();
        const icon =
          lastM && lastM.temperatureC > s.alertThreshold ? "🔴" : "🟢";
        const val = lastM ? lastM.temperatureC.toFixed(2) : "--";
        reporte += `${icon} *${s.friendlyName}*: ${val}°C\n`;
      }
      await responderWhatsApp(from, reporte);
    }
  } catch (err) {
    console.error("❌ Error crítico Webhook:", err);
  }
});

// ==========================================
// RUTAS FLUTTER Y DATOS
// ==========================================
const authenticateUser = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ message: "No token" });
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(401).json({ message: "Invalid" });
    req.user = user;
    next();
  });
};

app.post("/api/data", async (req, res) => {
  const { sensorId, tempC, voltageV } = req.body;
  try {
    const sensor = await Sensor.findOne({ hardwareId: sensorId }).populate(
      "owner"
    );
    if (!sensor) return res.status(404).send("Error");
    const tempNum = parseFloat(tempC);
    await new Measurement({
      sensorId,
      temperatureC: tempNum,
      voltageV: Number(voltageV),
    }).save();

    if (tempNum <= sensor.alertThreshold && sensor.isAcknowledged) {
      await Sensor.updateOne(
        { hardwareId: sensorId },
        { isAcknowledged: false }
      );
    }

    if (
      tempNum > sensor.alertThreshold &&
      !sensor.isAcknowledged &&
      sensor.owner?.whatsapp
    ) {
      const ahora = new Date();
      const cooldownMs = (process.env.ALERT_COOLDOWN || 30) * 60000;
      if (!sensor.lastAlertSent || ahora - sensor.lastAlertSent > cooldownMs) {
        await sendWhatsAppAlert(
          sensor.owner.whatsapp,
          sensor.friendlyName,
          tempNum
        );
        await Sensor.updateOne(
          { hardwareId: sensorId },
          { lastAlertSent: ahora }
        );
      }
    }
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

app.get("/api/auth/profile", authenticateUser, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password");
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: "Error" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const user = await User.findOne({ username: req.body.username });
    if (!user || !(await bcrypt.compare(req.body.password, user.password)))
      return res.status(401).send("Error");
    const token = jwt.sign(
      { id: user._id.toString(), username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );
    res.json({ token, username: user.username });
  } catch (e) {
    res.status(500).send("Error");
  }
});

app.get("/api/sensors/ids", authenticateUser, (req, res) =>
  res.json(ESP_HARDWARE_IDS)
);
app.get("/api/device/status", authenticateUser, (req, res) =>
  res.json(lastDeviceStatus)
);
app.post("/api/device/status", (req) => {
  lastDeviceStatus = { online: true, ...req.body, timestamp: new Date() };
});
app.get("/health", (req, res) => res.send("ALIVE"));

app.listen(PORT, () =>
  console.log(`🚀 Servidor LineUp Integral en puerto ${PORT}`)
);
