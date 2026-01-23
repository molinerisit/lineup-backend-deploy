const Sensor = require("../models/Sensor");
const Measurement = require("../models/Measurement");
const User = require("../models/User");
const { responderWhatsApp } = require("../services/whatsapp.service");
const asyncHandler = require("../utils/async-handler");

exports.handleWebhook = asyncHandler(async (req, res) => {
  res.sendStatus(200);
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
  const user = await User.findOne({ whatsapp: { $regex: suffix + "$" } }).lean();
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
    const sensors = await Sensor.find({ owner: user._id, enabled: true }).lean();
    if (sensors.length === 0)
      return await responderWhatsApp(from, "❌ No tienes equipos vinculados.");

    let historialMsg = `📊 *HISTORIAL RECIENTE*\n\n`;
    for (const s of sensors) {
      const docs = await Measurement.find({ sensorId: s.hardwareId, owner: user._id })
        .sort({ timestamp: -1 })
        .limit(5)
        .lean();
      historialMsg += `*${s.friendlyName}:*\n`;

      if (docs.length > 0) {
        docs.forEach((m) => {
          const horaLocal = new Date(m.timestamp).toLocaleTimeString("es-AR", {
            timeZone: "America/Argentina/Buenos_Aires",
            hour: "2-digit",
            minute: "2-digit",
            hour12: true,
          });
          historialMsg += `• ${horaLocal}: *${m.temperatureC.toFixed(2)}°C*\n`;
        });
      } else {
        historialMsg += `(Sin mediciones recientes)\n`;
      }
      historialMsg += `\n`;
    }
    await responderWhatsApp(from, historialMsg);
  } else if (incomingText === "3" || incomingText === "estado") {
    const sensors = await Sensor.find({ owner: user._id, enabled: true }).lean();
    let reporte = `📋 *ESTADO ACTUAL*\n\n`;
    for (const s of sensors) {
      const lastM = await Measurement.findOne({ sensorId: s.hardwareId, owner: user._id })
        .sort({ timestamp: -1 })
        .lean();
      const icon =
        lastM && (lastM.temperatureC > s.maxThreshold || lastM.temperatureC < s.minThreshold)
          ? "🔴"
          : "🟢";
      const val = lastM ? lastM.temperatureC.toFixed(2) : "--";
      const pIcon = s.isDoorOpen ? "🚪 ABIERTA" : "🔒 Cerrada";
      reporte += `${icon} *${s.friendlyName}*: ${val}°C (${pIcon})\n`;
    }
    await responderWhatsApp(from, reporte);
  }
});
