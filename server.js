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
  .connect(
    process.env.MONGODB_URI || "mongodb://localhost:27017/trazabilidadDB"
  )
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
  if (!token) return res.sendStatus(401);

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

// ==========================================
// FUNCIONES DE WHATSAPP (Evolution API)
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
  const mensaje = `🚨 *ALERTA DE TEMPERATURA*\n\n📍 *Equipo:* ${sensorName}\n🌡️ *Temperatura:* ${temp}°C\n\n⚠️ _Límite superado._\n👉 Escribí *Estado* para ver todo.`;
  await responderWhatsApp(number, mensaje);
};

// ==========================================
// RUTAS PARA EL ESP32 (Públicas)
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

    const nuevaMedicion = new Measurement({
      sensorId,
      temperatureC: Number(tempC),
      voltageV: Number(voltageV),
    });
    await nuevaMedicion.save();

    // Lógica de Alerta con Cooldown
    if (tempC > sensor.alertThreshold && sensor.owner?.whatsapp) {
      const ahora = new Date();
      const cooldownMs = (process.env.ALERT_COOLDOWN || 30) * 60000;
      if (!sensor.lastAlertSent || ahora - sensor.lastAlertSent > cooldownMs) {
        await sendWhatsAppAlert(
          sensor.owner.whatsapp,
          sensor.friendlyName,
          tempC
        );
        sensor.lastAlertSent = ahora;
        await sensor.save();
      }
    }
    res.send("OK");
  } catch (err) {
    res.status(500).send("Error");
  }
});

app.post("/api/device/status", async (req, res) => {
  const { ip, oneWirePin, physicalSensors, configuredSensors, mapping } =
    req.body;
  lastDeviceStatus = {
    online: true,
    ip,
    oneWirePin,
    physicalSensors,
    configuredSensors,
    mapping,
    timestamp: new Date(),
  };
  if (mapping) {
    for (const m of mapping) {
      await Sensor.findOneAndUpdate(
        { hardwareId: m.hardwareId },
        { address: m.address }
      );
    }
  }
  res.json({ message: "Sincronizado" });
});

// ==========================================
// WEBHOOK BOT INTERACTIVO (WhatsApp)
// ==========================================
app.post("/api/webhook/whatsapp", async (req, res) => {
  try {
    const data = req.body.data;
    if (!data || !data.message) return res.sendStatus(200);
    const text = (
      data.message.conversation ||
      data.message.extendedTextMessage?.text ||
      ""
    )
      .toLowerCase()
      .trim();
    const from = data.key.remoteJid.split("@")[0];
    const user = await User.findOne({ whatsapp: from });
    if (!user) return res.sendStatus(200);

    if (text === "estado") {
      const sensors = await Sensor.find({ owner: user._id, enabled: true });
      let reporte = `📋 *REPORTE DE EQUIPOS*\n\n`;
      for (const s of sensors) {
        const lastM = await Measurement.findOne({
          sensorId: s.hardwareId,
        }).sort({ timestamp: -1 });
        const temp = lastM ? `${lastM.temperatureC}°C` : "N/A";
        const icon =
          lastM && lastM.temperatureC > s.alertThreshold ? "🔴" : "🟢";
        reporte += `${icon} *${s.friendlyName}*: ${temp}\n`;
      }
      await responderWhatsApp(from, reporte);
    }

    if (text.startsWith("historial")) {
      const busqueda = text.replace("historial", "").trim();
      const sensor = await Sensor.findOne({
        owner: user._id,
        friendlyName: { $regex: new RegExp(busqueda, "i") },
      });
      if (sensor) {
        const docs = await Measurement.find({ sensorId: sensor.hardwareId })
          .sort({ timestamp: -1 })
          .limit(10);
        if (docs.length > 0) {
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
                  backgroundColor: "rgba(54, 162, 235, 0.2)",
                },
              ],
            },
          });
          await responderWhatsAppConImagen(
            from,
            chart.getUrl(),
            `📊 Historial de ${sensor.friendlyName}`
          );
        }
      }
    }
    res.sendStatus(200);
  } catch (err) {
    res.sendStatus(500);
  }
});

// ==========================================
// RUTAS DE AUTENTICACIÓN
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
  const user = await User.findOne({ username: req.body.username });
  if (!user || !(await bcrypt.compare(req.body.password, user.password))) {
    return res.status(401).json({ message: "Credenciales inválidas" });
  }
  const token = jwt.sign(
    { id: user._id, username: user.username },
    process.env.JWT_SECRET
  );
  res.json({ token, username: user.username });
});

// ==========================================
// GESTIÓN DE PERFIL (Solución al 404)
// ==========================================
app.get(
  ["/api/auth/profile", "/api/profile"],
  authenticateUser,
  async (req, res) => {
    try {
      const user = await User.findById(req.user.id).select("-password");
      if (!user) return res.status(404).json({ message: "No encontrado" });
      res.json(user);
    } catch (err) {
      res.status(500).send("Error");
    }
  }
);

app.put(
  ["/api/auth/profile", "/api/profile"],
  authenticateUser,
  async (req, res) => {
    try {
      const { whatsapp, oldPassword, newPassword } = req.body;
      const user = await User.findById(req.user.id);
      if (newPassword) {
        const isMatch = await bcrypt.compare(oldPassword, user.password);
        if (!isMatch)
          return res.status(401).json({ message: "Contraseña incorrecta" });
        user.password = newPassword;
      }
      if (whatsapp) user.whatsapp = whatsapp;
      await user.save();
      res.json({ message: "Actualizado" });
    } catch (err) {
      res.status(500).send("Error");
    }
  }
);

app.delete(
  ["/api/auth/profile", "/api/profile"],
  authenticateUser,
  async (req, res) => {
    try {
      const sensors = await Sensor.find({ owner: req.user.id });
      for (const s of sensors) {
        await Measurement.deleteMany({ sensorId: s.hardwareId });
      }
      await Sensor.deleteMany({ owner: req.user.id });
      await User.findByIdAndDelete(req.user.id);
      res.json({ message: "Cuenta eliminada" });
    } catch (err) {
      res.status(500).send("Error");
    }
  }
);

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

app.delete("/api/sensors/:hardwareId", authenticateUser, async (req, res) => {
  try {
    await Sensor.deleteOne({
      hardwareId: req.params.hardwareId,
      owner: req.user.id,
    });
    await Measurement.deleteMany({ sensorId: req.params.hardwareId });
    res.json({ message: "Eliminado" });
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

app.listen(PORT, () =>
  console.log(`🚀 Servidor Final activo en puerto ${PORT}`)
);
