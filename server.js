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
    console.log("⚠️ Acceso denegado: No hay token");
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
// FUNCIONES WHATSAPP (Evolution API con Botones)
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

const sendWhatsAppButtons = async (number, sensorName, temp, sensorId) => {
  try {
    const data = {
      number: number,
      buttonText: "Opciones",
      description: `🚨 *ALERTA DE TEMPERATURA*\n\n📍 *Equipo:* ${sensorName}\n🌡️ *Temperatura:* ${temp}°C\n\n⚠️ _Límite superado._`,
      footerText: "LineUp Trazabilidad",
      buttons: [
        {
          buttonId: `ack_${sensorId}`,
          buttonText: { displayText: "✅ Recibido" },
          type: 1,
        },
        {
          buttonId: `status_${sensorId}`,
          buttonText: { displayText: "📊 Ver Estado" },
          type: 1,
        },
        {
          buttonId: `all_sensors`,
          buttonText: { displayText: "🔍 Otros Sensores" },
          type: 1,
        },
      ],
    };

    await axios.post(
      `${process.env.EVOLUTION_API_URL}/message/sendButtons/${process.env.EVOLUTION_INSTANCE}`,
      data,
      { headers: { apikey: process.env.EVOLUTION_API_KEY } }
    );
  } catch (error) {
    console.error("❌ Error enviando botones, enviando texto de respaldo...");
    await responderWhatsApp(
      number,
      `🚨 *ALERTA:* ${sensorName} a ${temp}°C\nEscribí 'Estado' para ver más.`
    );
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

// ==========================================
// RUTAS PARA EL ESP32 Y RECEPCIÓN DE DATOS
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

    await new Measurement({
      sensorId,
      temperatureC: Number(tempC),
      voltageV: Number(voltageV),
    }).save();

    // Si la temperatura vuelve a la normalidad, reseteamos el silenciado (ACK)
    if (tempC <= sensor.alertThreshold && sensor.isAcknowledged) {
      await Sensor.updateOne(
        { hardwareId: sensorId },
        { isAcknowledged: false }
      );
    }

    // Disparar alerta si supera límite Y no ha sido "Recibido"
    if (
      tempC > sensor.alertThreshold &&
      !sensor.isAcknowledged &&
      sensor.owner?.whatsapp
    ) {
      const ahora = new Date();
      const cooldownMs = (process.env.ALERT_COOLDOWN || 30) * 60000;
      if (!sensor.lastAlertSent || ahora - sensor.lastAlertSent > cooldownMs) {
        await sendWhatsAppButtons(
          sensor.owner.whatsapp,
          sensor.friendlyName,
          tempC,
          sensor.hardwareId
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
// WEBHOOK: PROCESAR BOTONES Y MENSAJES
// ==========================================
app.post("/api/webhook/whatsapp", async (req, res) => {
  try {
    const data = req.body.data;
    if (!data || !data.message) return res.sendStatus(200);

    const from = data.key.remoteJid.split("@")[0];
    const text = (
      data.message.conversation ||
      data.message.extendedTextMessage?.text ||
      ""
    )
      .toLowerCase()
      .trim();

    // Detectar si el mensaje es un click en un botón
    const buttonId =
      data.message.buttonsResponseMessage?.selectedButtonId ||
      data.message.templateButtonReplyMessage?.selectedId ||
      data.message.listResponseMessage?.singleSelectReply.selectedRowId;

    const user = await User.findOne({ whatsapp: from });
    if (!user) return res.sendStatus(200);

    // Lógica para botones e historial de texto
    if (buttonId) {
      if (buttonId.startsWith("ack_")) {
        const hId = buttonId.replace("ack_", "");
        await Sensor.findOneAndUpdate(
          { hardwareId: hId },
          { isAcknowledged: true }
        );
        await responderWhatsApp(
          from,
          "✅ *Alerta Silenciada.* No recibirás más avisos de este equipo hasta que la temperatura se normalice."
        );
      }

      if (buttonId.startsWith("status_")) {
        const hId = buttonId.replace("status_", "");
        const s = await Sensor.findOne({ hardwareId: hId });
        const docs = await Measurement.find({ sensorId: hId })
          .sort({ timestamp: -1 })
          .limit(5);
        let msg = `📊 *ESTADO RECIENTE: ${s.friendlyName}*\n\n`;
        docs.forEach((m) => {
          msg += `• ${new Date(m.timestamp).toLocaleTimeString()}: *${
            m.temperatureC
          }°C*\n`;
        });
        await responderWhatsApp(from, msg);
      }

      if (buttonId === "all_sensors") {
        const sensors = await Sensor.find({ owner: user._id, enabled: true });
        let reporte = `📋 *ESTADO DE TODOS LOS EQUIPOS*\n\n`;
        for (const s of sensors) {
          const lastM = await Measurement.findOne({
            sensorId: s.hardwareId,
          }).sort({ timestamp: -1 });
          reporte += `${
            lastM && lastM.temperatureC > s.alertThreshold ? "🔴" : "🟢"
          } *${s.friendlyName}*: ${lastM ? lastM.temperatureC : "--"}°C\n`;
        }
        await responderWhatsApp(from, reporte);
      }
    }

    // Comandos de texto tradicionales (compatibilidad)
    if (text === "estado") {
      const sensors = await Sensor.find({ owner: user._id, enabled: true });
      let reporte = `📋 *REPORTE DE EQUIPOS*\n\n`;
      for (const s of sensors) {
        const lastM = await Measurement.findOne({
          sensorId: s.hardwareId,
        }).sort({ timestamp: -1 });
        reporte += `${
          lastM && lastM.temperatureC > s.alertThreshold ? "🔴" : "🟢"
        } *${s.friendlyName}*: ${lastM ? lastM.temperatureC : "N/A"}°C\n`;
      }
      await responderWhatsApp(from, reporte);
    }
    res.sendStatus(200);
  } catch (err) {
    res.sendStatus(500);
  }
});

// ==========================================
// AUTENTICACIÓN Y PERFIL
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
    console.log(`✅ Login exitoso: ${user.username}`);
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

// ... (Demás rutas DELETE y PUT de perfil permanecen iguales a tu versión original)

// ==========================================
// DASHBOARD Y CONFIGURACIÓN
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

app.get("/api/sensors/ids", authenticateUser, (req, res) =>
  res.json(ESP_HARDWARE_IDS)
);
app.get("/api/device/status", authenticateUser, (req, res) =>
  res.json(lastDeviceStatus)
);

app.listen(PORT, () => console.log(`🚀 Servidor en puerto ${PORT}`));
