require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const axios = require("axios");

const Measurement = require("./models/Measurement");
const Sensor = require("./models/Sensor");
const User = require("./models/User");

const app = express();
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3000;

mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ MongoDB Conectado"))
  .catch((err) => console.error("❌ Error Mongo:", err.message));

app.use(express.json());
app.use(cors({ origin: "*" }));

const responderWhatsApp = async (number, text) => {
  try {
    await axios.post(
      `${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`,
      { number: number, text: text },
      { headers: { apikey: process.env.EVOLUTION_API_KEY }, timeout: 5000 }
    );
    console.log(`📤 WhatsApp enviado a ${number}`);
  } catch (error) {
    console.error("❌ Error API WhatsApp:", error.message);
  }
};

// ==========================================
// WEBHOOK: CHATBOT CON BÚSQUEDA FLEXIBLE
// ==========================================
app.post("/api/webhook/whatsapp", async (req, res) => {
  res.status(200).send("OK");

  try {
    const data = req.body.data;
    if (!data || !data.message) return;

    const fromRaw = data.key.remoteJid.split("@")[0]; // Ej: "5493412527455"

    const incomingText = (
      data.message.conversation ||
      data.message.extendedTextMessage?.text ||
      data.message.text ||
      ""
    )
      .trim()
      .toLowerCase();

    console.log(`💬 Mensaje de ${fromRaw}: "${incomingText}"`);

    // BÚSQUEDA FLEXIBLE: Buscamos el número tal cual, con "+" o que termine en esos dígitos
    const user = await User.findOne({
      $or: [
        { whatsapp: fromRaw },
        { whatsapp: `+${fromRaw}` },
        { whatsapp: new RegExp(fromRaw.substring(2) + "$") }, // Busca los últimos dígitos
      ],
    }).lean();

    if (!user) {
      console.log(`⚠️ Usuario ${fromRaw} no encontrado en DB.`);
      // Opcional: responder indicando que no está registrado
      return;
    }

    if (incomingText === "1") {
      const s = await Sensor.findOneAndUpdate(
        { owner: user._id, lastAlertSent: { $ne: null } },
        { isAcknowledged: true },
        { sort: { lastAlertSent: -1 } }
      );
      if (s)
        await responderWhatsApp(
          fromRaw,
          `✅ Alertas de "${s.friendlyName}" silenciadas.`
        );
    } else if (incomingText === "2") {
      const sensors = await Sensor.find({
        owner: user._id,
        enabled: true,
      }).lean();
      let msg = `📊 *HISTORIAL RECIENTE*\n\n`;
      for (const s of sensors) {
        const docs = await Measurement.find({ sensorId: s.hardwareId })
          .sort({ timestamp: -1 })
          .limit(5)
          .lean();
        msg += `*${s.friendlyName}:*\n`;
        if (docs.length > 0) {
          docs.forEach(
            (m) =>
              (msg += `• ${new Date(m.timestamp).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}: ${m.temperatureC.toFixed(2)}°C\n`)
          );
        } else msg += `(Sin datos)\n`;
        msg += `\n`;
      }
      await responderWhatsApp(fromRaw, msg);
    } else if (incomingText === "3" || incomingText === "estado") {
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
        reporte += `${icon} *${s.friendlyName}*: ${
          lastM ? lastM.temperatureC.toFixed(2) : "--"
        }°C\n`;
      }
      await responderWhatsApp(fromRaw, reporte);
    }
  } catch (err) {
    console.error("❌ Error Webhook:", err.message);
  }
});

// === MANTENER EL RESTO DE RUTAS IGUAL (LOGIN, DATA, HISTORY, ETC.) ===
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

app.post("/api/data", async (req, res) => {
  const { sensorId, tempC, voltageV } = req.body;
  try {
    const sensor = await Sensor.findOne({ hardwareId: sensorId }).populate(
      "owner"
    );
    if (!sensor) return res.status(404).send("No sensor");
    const tempNum = parseFloat(tempC);
    await new Measurement({
      sensorId,
      temperatureC: tempNum,
      voltageV: Number(voltageV),
    }).save();

    if (
      tempNum > sensor.alertThreshold &&
      !sensor.isAcknowledged &&
      sensor.owner?.whatsapp
    ) {
      const ahora = new Date();
      const cooldownMs = (process.env.ALERT_COOLDOWN || 30) * 60000;
      if (!sensor.lastAlertSent || ahora - sensor.lastAlertSent > cooldownMs) {
        const tempF = tempNum.toFixed(2);
        const mensaje = `🚨 *ALERTA:* ${sensor.friendlyName} a ${tempF}°C\n\n1️⃣ Recibido\n2️⃣ Historial\n3️⃣ Todo`;
        await responderWhatsApp(sensor.owner.whatsapp, mensaje);
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

app.get("/api/history", async (req, res) => {
  try {
    const docs = await Measurement.find({ sensorId: req.query.sensorId })
      .sort({ timestamp: -1 })
      .limit(50);
    res.json(docs);
  } catch (err) {
    res.status(500).json([]);
  }
});

app.listen(PORT, () => console.log(`🚀 Servidor Final en puerto ${PORT}`));
