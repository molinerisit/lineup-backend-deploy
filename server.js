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
// ESTADO GLOBAL Y CONFIGURACIÓN
// ==========================================
let lastDeviceStatus = {
  online: false,
  ip: "--",
  oneWirePin: 25,
  doorPins: "26, 27, 14",
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

const sendWhatsAppAlert = async (number, sensorName, temp, tipo) => {
  const tempF = parseFloat(temp).toFixed(2);
  const emoji = tipo === "ALTA" ? "🔥" : "❄️";
  const mensaje = `🚨 *ALERTA DE TEMPERATURA ${tipo}*\n\n📍 *Equipo:* ${sensorName}\n🌡️ *Temperatura:* ${tempF}°C\n\n⚠️ _Límite superado ${emoji}_\n\n*Responde con un número:*\n1️⃣ - ✅ *Recibido* (Silenciar)\n2️⃣ - 📊 *Ver Historial*\n3️⃣ - 📋 *Estado General*`;
  await responderWhatsApp(number, mensaje);
};

// ==========================================
// WEBHOOK: CHATBOT INTERACTIVO (CON CORRECCIÓN HORARIA)
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

    const suffix = from.slice(-10);
    const user = await User.findOne({
      whatsapp: { $regex: suffix + "$" },
    }).lean();
    if (!user) return;

    if (incomingText === "1") {
      const s = await Sensor.findOneAndUpdate(
        { owner: user._id, lastAlertSent: { $ne: null } },
        { isAcknowledged: true },
        { sort: { lastAlertSent: -1 } }
      );
      if (s)
        await responderWhatsApp(
          from,
          `✅ *Entendido.* Alertas de "${s.friendlyName}" silenciadas.`
        );
    } else if (incomingText === "2") {
      const sensors = await Sensor.find({
        owner: user._id,
        enabled: true,
      }).lean();
      if (sensors.length === 0)
        return await responderWhatsApp(
          from,
          "❌ No tienes equipos vinculados."
        );

      let historialMsg = `📊 *HISTORIAL RECIENTE*\n\n`;
      for (const s of sensors) {
        const docs = await Measurement.find({
          sensorId: s.hardwareId,
          owner: user._id,
        })
          .sort({ timestamp: -1 })
          .limit(5)
          .lean();
        historialMsg += `*${s.friendlyName}:*\n`;
        if (docs.length > 0) {
          docs.forEach((m) => {
            const horaLocal = new Date(m.timestamp).toLocaleTimeString(
              "es-AR",
              {
                timeZone: "America/Argentina/Buenos_Aires",
                hour: "2-digit",
                minute: "2-digit",
                hour12: true,
              }
            );
            historialMsg += `• ${horaLocal}: *${m.temperatureC.toFixed(
              2
            )}°C*\n`;
          });
        } else historialMsg += `(Sin mediciones recientes)\n`;
        historialMsg += `\n`;
      }
      await responderWhatsApp(from, historialMsg);
    } else if (incomingText === "3" || incomingText === "estado") {
      const sensors = await Sensor.find({
        owner: user._id,
        enabled: true,
      }).lean();
      let reporte = `📋 *ESTADO ACTUAL*\n\n`;
      for (const s of sensors) {
        const lastM = await Measurement.findOne({
          sensorId: s.hardwareId,
          owner: user._id,
        })
          .sort({ timestamp: -1 })
          .lean();
        const icon =
          lastM &&
          (lastM.temperatureC > s.maxThreshold ||
            lastM.temperatureC < s.minThreshold)
            ? "🔴"
            : "🟢";
        const pIcon = s.isDoorOpen ? "🚪 ABIERTA" : "🔒 Cerrada";
        reporte += `${icon} *${s.friendlyName}*: ${
          lastM ? lastM.temperatureC.toFixed(2) : "--"
        }°C (${pIcon})\n`;
      }
      await responderWhatsApp(from, reporte);
    }
  } catch (err) {
    console.error("❌ Error Webhook:", err);
  }
});

// ==========================================
// RUTAS DE AUTENTICACIÓN Y PERFIL
// ==========================================
app.post("/api/auth/register", async (req, res) => {
  try {
    const { username, password, whatsapp } = req.body;
    const user = new User({ username, password, whatsapp });
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

app.get("/api/auth/profile", authenticateUser, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password");
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
    await Measurement.deleteMany({ owner: userId });
    await Sensor.deleteMany({ owner: userId });
    await User.findByIdAndDelete(userId);
    res.json({ message: "Cuenta eliminada" });
  } catch (err) {
    res.status(500).send("Error");
  }
});

// ==========================================
// GESTIÓN DE SENSORES Y DASHBOARD
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
  } catch (err) {
    res.status(500).send("Error");
  }
});

app.get("/api/history", authenticateUser, async (req, res) => {
  try {
    const docs = await Measurement.find({
      sensorId: req.query.sensorId,
      owner: req.user.id,
    })
      .sort({ timestamp: -1 })
      .limit(50)
      .lean();
    res.json(docs);
  } catch (err) {
    res.status(500).json([]);
  }
});

app.post("/api/sensors/config", authenticateUser, async (req, res) => {
  try {
    const sensor = await Sensor.findOneAndUpdate(
      { hardwareId: req.body.hardwareId },
      { ...req.body, owner: req.user.id, enabled: true },
      { upsert: true, new: true }
    );
    res.json(sensor);
  } catch (err) {
    res.status(500).send("Error");
  }
});

app.delete("/api/sensors/:hardwareId", authenticateUser, async (req, res) => {
  try {
    const sensor = await Sensor.findOneAndDelete({
      hardwareId: req.params.hardwareId,
      owner: req.user.id,
    });
    if (sensor)
      await Measurement.deleteMany({
        sensorId: sensor.hardwareId,
        owner: req.user.id,
      });
    res.json({ message: "Eliminado" });
  } catch (err) {
    res.status(500).send("Error");
  }
});

app.get("/api/sensors/ids", authenticateUser, (req, res) =>
  res.json(ESP_HARDWARE_IDS)
);

// ==========================================
// HARDWARE (ESP32) - RUTA DE CONFIGURACIÓN
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
  const { sensorId, tempC, voltageV, doorOpen } = req.body;
  try {
    const sensor = await Sensor.findOne({ hardwareId: sensorId }).populate(
      "owner"
    );
    if (!sensor) return res.status(404).send("Sensor no configurado");

    const tempNum = parseFloat(tempC);
    const vBat = parseFloat(voltageV);
    const estaAbierta = doorOpen === 1;

    // Guardar medición histórica
    await new Measurement({
      sensorId,
      owner: sensor.owner._id,
      temperatureC: tempNum,
      voltageV: vBat,
    }).save();

    // Lógica de Puerta Persistente
    let doorUpdate = { isDoorOpen: estaAbierta };
    if (estaAbierta) {
      if (!sensor.isDoorOpen) {
        doorUpdate.doorOpenedAt = new Date();
      } else {
        const diff = new Date() - (sensor.doorOpenedAt || new Date());
        if (diff > 120000) {
          // 2 minutos
          await responderWhatsApp(
            sensor.owner.whatsapp,
            `🚪 *PUERTA ABIERTA:* El equipo "${sensor.friendlyName}" lleva +2 min abierto.`
          );
          doorUpdate.doorOpenedAt = new Date(); // Reset para cooldown
        }
      }
    } else {
      doorUpdate.doorOpenedAt = null;
    }

    await Sensor.updateOne({ hardwareId: sensorId }, { $set: doorUpdate });

    // Lógica Batería
    if (vBat < 3.5 && vBat > 1.0) {
      await responderWhatsApp(
        sensor.owner.whatsapp,
        `🪫 *BATERÍA BAJA:* "${sensor.friendlyName}" tiene ${vBat.toFixed(2)}V.`
      );
    }

    // Lógica Temperatura
    if (
      tempNum >= sensor.minThreshold &&
      tempNum <= sensor.maxThreshold &&
      sensor.isAcknowledged
    ) {
      await Sensor.updateOne(
        { hardwareId: sensorId },
        { isAcknowledged: false }
      );
    }

    let tipoAlerta = null;
    if (tempNum > sensor.maxThreshold) tipoAlerta = "ALTA";
    if (tempNum < sensor.minThreshold) tipoAlerta = "BAJA";

    if (tipoAlerta && !sensor.isAcknowledged && sensor.owner?.whatsapp) {
      const ahora = new Date();
      const cooldownMs = (process.env.ALERT_COOLDOWN || 30) * 60000;
      if (!sensor.lastAlertSent || ahora - sensor.lastAlertSent > cooldownMs) {
        await sendWhatsAppAlert(
          sensor.owner.whatsapp,
          sensor.friendlyName,
          tempNum,
          tipoAlerta
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
  console.log(`🚀 Servidor LineUp Integral v3.1 desplegado en puerto ${PORT}`)
);
