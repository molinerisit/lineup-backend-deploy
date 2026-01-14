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

  if (!token) return res.status(401).json({ message: "No token provided" });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(401).json({ message: "Token inválido" });
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
    console.log(`📤 WhatsApp enviado a ${number}`);
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
  const tempF = parseFloat(temp).toFixed(2);
  const mensaje = `🚨 *ALERTA DE TEMPERATURA*\n\n📍 *Equipo:* ${sensorName}\n🌡️ *Temperatura:* ${tempF}°C\n\n⚠️ _Límite superado._\n\n*Responde con un número:*\n1️⃣ - ✅ *Recibido* (Silenciar)\n2️⃣ - 📊 *Ver Historial* (Últimas 5)\n3️⃣ - 📋 *Estado General* (Todos)`;
  await responderWhatsApp(number, mensaje);
};

// ==========================================
// WEBHOOK: CHATBOT INTERACTIVO (REVISADO)
// ==========================================
app.post("/api/webhook/whatsapp", async (req, res) => {
  res.sendStatus(200);

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

    console.log(`💬 Procesando "${incomingText}" de ${from}`);

    // Búsqueda inteligente de Juliana (ignorando el 9)
    const suffix = from.slice(-10);
    const user = await User.findOne({
      whatsapp: { $regex: suffix + "$" },
    }).lean();

    if (!user) return console.log(`⚠️ Usuario ${from} no hallado.`);

    // OPCIÓN 1: SILENCIAR (ACK)
    if (incomingText === "1") {
      const s = await Sensor.findOneAndUpdate(
        {
          owner: { $in: [user._id, user._id.toString()] },
          lastAlertSent: { $ne: null },
        },
        { isAcknowledged: true },
        { sort: { lastAlertSent: -1 } }
      );
      if (s)
        await responderWhatsApp(
          from,
          `✅ *Entendido.* Alertas de "${s.friendlyName}" silenciadas.`
        );
    }

    // OPCIÓN 2: HISTORIAL (BÚSQUEDA REFORZADA)
    else if (incomingText === "2") {
      const sensors = await Sensor.find({
        owner: { $in: [user._id, user._id.toString()] },
        enabled: true,
      }).lean();

      if (sensors.length === 0)
        return await responderWhatsApp(
          from,
          "❌ No tienes equipos vinculados."
        );

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
        } else historialMsg += `(Sin datos)\n`;
        historialMsg += `\n`;
      }
      await responderWhatsApp(from, historialMsg);
    }

    // OPCIÓN 3: ESTADO GENERAL
    else if (incomingText === "3" || incomingText === "estado") {
      const sensors = await Sensor.find({
        owner: { $in: [user._id, user._id.toString()] },
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

    // COMANDO GRAFICO
    else if (incomingText.startsWith("grafico")) {
      const busqueda = incomingText.replace("grafico", "").trim();
      const sensor = await Sensor.findOne({
        owner: { $in: [user._id, user._id.toString()] },
        friendlyName: { $regex: new RegExp(busqueda, "i") },
      });
      if (sensor) {
        const docs = await Measurement.find({ sensorId: sensor.hardwareId })
          .sort({ timestamp: -1 })
          .limit(15);
        const chart = new QuickChart();
        chart.setConfig({
          type: "line",
          data: {
            labels: docs
              .map((m) => new Date(m.timestamp).toLocaleTimeString())
              .reverse(),
            datasets: [
              {
                label: "Temp °C",
                data: docs.map((m) => m.temperatureC).reverse(),
                borderColor: "#36A2EB",
                fill: true,
              },
            ],
          },
        });
        await responderWhatsAppConImagen(
          from,
          chart.getUrl(),
          `📊 Curva de ${sensor.friendlyName}`
        );
      }
    }
  } catch (err) {
    console.error("❌ Error Webhook:", err);
  }
});

// ==========================================
// RUTAS DE AUTENTICACIÓN Y PERFIL (COMPLETAS)
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
    const sensors = await Sensor.find({ owner: userId });
    for (const s of sensors) {
      await Measurement.deleteMany({ sensorId: s.hardwareId });
    }
    await Sensor.deleteMany({ owner: userId });
    await User.findByIdAndDelete(userId);
    res.json({ message: "Cuenta eliminada" });
  } catch (err) {
    res.status(500).send("Error");
  }
});

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

app.delete("/api/sensors/:hardwareId", authenticateUser, async (req, res) => {
  try {
    const sensor = await Sensor.findOneAndDelete({
      hardwareId: req.params.hardwareId,
      owner: req.user.id,
    });
    if (sensor) await Measurement.deleteMany({ sensorId: sensor.hardwareId });
    res.json({ message: "Eliminado" });
  } catch (err) {
    res.status(500).send("Error");
  }
});

app.get("/api/sensors/ids", authenticateUser, (req, res) =>
  res.json(ESP_HARDWARE_IDS)
);

// ==========================================
// HARDWARE (ESP32)
// ==========================================
app.get("/api/device/config", async (req, res) => {
  try {
    const sensors = await Sensor.find({ enabled: true }).select(
      "hardwareId pin -_id"
    );
    res.json(sensors);
  } catch (err) {
    res.status(500).json([]);
  }
});

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

app.post("/api/device/status", async (req, res) => {
  lastDeviceStatus = { online: true, ...req.body, timestamp: new Date() };
  res.json({ message: "OK" });
});

app.get("/api/device/status", authenticateUser, (req, res) =>
  res.json(lastDeviceStatus)
);

app.get("/health", (req, res) => res.send("ALIVE"));

app.listen(PORT, () =>
  console.log(`🚀 Servidor LineUp Final desplegado en puerto ${PORT}`)
);
