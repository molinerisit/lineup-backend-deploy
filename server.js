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
  .catch((err) => console.error("❌ Error Crítico Mongo:", err.message));

app.use(express.json());
app.use(cors({ origin: "*" }));

// ==========================================
// MIDDLEWARE DE AUTENTICACIÓN
// ==========================================
const authenticateUser = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) return res.status(401).json({ message: "No token provided" });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(401).json({ message: "Token inválido" });
    req.user = user;
    next();
  });
};

// ==========================================
// FUNCIONES WHATSAPP (CON PROTECCIÓN ANTI-CRASH)
// ==========================================

const responderWhatsApp = async (number, text) => {
  try {
    // Verificación de seguridad para evitar que el proceso explote si faltan variables
    if (!process.env.EVOLUTION_API_URL || !process.env.EVOLUTION_API_KEY) {
      console.error("❌ Error: Faltan credenciales de Evolution API");
      return;
    }

    await axios.post(
      `${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`,
      { number: number, text: text },
      { headers: { apikey: process.env.EVOLUTION_API_KEY }, timeout: 5000 } // Timeout para no colgar el servidor
    );
    console.log(`📤 Mensaje enviado con éxito a ${number}`);
  } catch (error) {
    console.error("❌ Error de comunicación con Evolution API:", error.message);
  }
};

const sendWhatsAppAlert = async (number, sensorName, temp) => {
  const tempF = parseFloat(temp).toFixed(2);
  const mensaje = `🚨 *ALERTA DE TEMPERATURA*\n\n📍 *Equipo:* ${sensorName}\n🌡️ *Temperatura:* ${tempF}°C\n\n⚠️ _Límite superado._\n\n*Responde con un número:*\n1️⃣ - ✅ *Recibido* (Silenciar avisos)\n2️⃣ - 📊 *Ver Historial* (Últimas 5)\n3️⃣ - 📋 *Estado General* (Todos)`;
  await responderWhatsApp(number, mensaje);
};

const responderWhatsAppConImagen = async (number, imageUrl, caption = "") => {
  try {
    await axios.post(
      `${process.env.EVOLUTION_API_URL}/message/sendImage/${process.env.EVOLUTION_INSTANCE}`,
      { number: number, url: imageUrl, caption: caption },
      { headers: { apikey: process.env.EVOLUTION_API_KEY }, timeout: 8000 }
    );
  } catch (error) {
    console.error("❌ Error imagen WA:", error.message);
  }
};

// ==========================================
// WEBHOOK: CHATBOT INTERACTIVO (VERSION BLINDADA)
// ==========================================
app.post("/api/webhook/whatsapp", async (req, res) => {
  // Respuesta inmediata para liberar a Evolution y evitar timeouts
  res.status(200).send("OK");

  try {
    const data = req.body.data;
    if (!data || !data.message) return;

    const from = data.key.remoteJid.split("@")[0];
    const incomingText = (
      data.message.conversation ||
      data.message.extendedTextMessage?.text ||
      data.message.text ||
      ""
    )
      .trim()
      .toLowerCase();

    console.log(`💬 Procesando mensaje de ${from}: "${incomingText}"`);

    const user = await User.findOne({ whatsapp: from }).lean();
    if (!user) {
      console.log(`⚠️ Número ${from} no registrado.`);
      return;
    }

    // OPCIÓN 1: SILENCIAR (ACK)
    if (incomingText === "1") {
      const s = await Sensor.findOneAndUpdate(
        { owner: user._id, enabled: true, lastAlertSent: { $ne: null } },
        { isAcknowledged: true },
        { sort: { lastAlertSent: -1 } }
      );
      if (s) {
        await responderWhatsApp(
          from,
          `✅ *Entendido.* Alertas de "${s.friendlyName}" silenciadas hasta que se normalice.`
        );
      } else {
        await responderWhatsApp(
          from,
          "❌ No encontré alertas activas para silenciar."
        );
      }
    }

    // OPCIÓN 2: HISTORIAL ÚLTIMAS 5 CON 2 DECIMALES
    else if (incomingText === "2") {
      const sensors = await Sensor.find({
        owner: user._id,
        enabled: true,
      }).lean();
      let historialMsg = `📊 *HISTORIAL RECIENTE*\n\n`;

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
            historialMsg += `• ${hora}: ${m.temperatureC.toFixed(2)}°C\n`;
          });
        } else {
          historialMsg += `(Sin mediciones)\n`;
        }
        historialMsg += `\n`;
      }
      await responderWhatsApp(from, historialMsg);
    }

    // OPCIÓN 3 o "Estado": REPORTE GENERAL
    else if (incomingText === "3" || incomingText === "estado") {
      const sensors = await Sensor.find({
        owner: user._id,
        enabled: true,
      }).lean();
      let reporte = `📋 *ESTADO ACTUAL*\n\n`;
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
    console.error("❌ Error en motor Webhook:", err.message);
  }
});

// ==========================================
// RUTAS DE AUTENTICACIÓN Y PERFIL
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
      { id: user._id.toString(), username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );
    console.log(`✅ Login: ${user.username}`);
    res.json({ token, username: user.username });
  } catch (e) {
    res.status(500).send("Error");
  }
});

app.get(
  ["/api/auth/profile", "/api/auth/profile/"],
  authenticateUser,
  async (req, res) => {
    try {
      const user = await User.findById(req.user.id).select("-password");
      if (!user) return res.status(404).json({ message: "No encontrado" });
      res.json(user);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ==========================================
// GESTIÓN DE SENSORES Y DASHBOARD (FLUTTER)
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
      .limit(Number(limit))
      .lean();
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
    if (!sensor) return res.status(404).send("Sensor no configurado");

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

app.get("/api/device/status", authenticateUser, (req, res) =>
  res.json(lastDeviceStatus)
);
app.get("/api/sensors/ids", authenticateUser, (req, res) =>
  res.json(ESP_HARDWARE_IDS)
);
app.get("/health", (req, res) => res.send("ALIVE"));

app.listen(PORT, () =>
  console.log(`🚀 Servidor LineUp Activo en Puerto ${PORT}`)
);
