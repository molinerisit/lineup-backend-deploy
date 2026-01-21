const axios = require("axios");
const config = require("../config/env");

const responderWhatsApp = async (number, text) => {
  if (!config.evolution.url || !config.evolution.apiKey || !config.evolution.instance) {
    console.warn("⚠️ Evolución API no configurada; omitiendo envío WA");
    return;
  }
  await axios.post(
    `${config.evolution.url}/message/sendText/${config.evolution.instance}`,
    { number, text },
    { headers: { apikey: config.evolution.apiKey } }
  );
};

const sendWhatsAppAlert = async (number, sensorName, temp, tipo) => {
  const tempF = parseFloat(temp).toFixed(2);
  const emoji = tipo === "ALTA" ? "🔥" : "❄️";
  const mensaje = `🚨 *ALERTA DE TEMPERATURA ${tipo}*\n\n📍 *Equipo:* ${sensorName}\n🌡️ *Temperatura:* ${tempF}°C\n\n⚠️ _Límite superado ${emoji}_\n\n*Responde con un número:*\n1️⃣ - ✅ *Recibido* (Silenciar)\n2️⃣ - 📊 *Ver Historial*\n3️⃣ - 📋 *Estado General*`;
  await responderWhatsApp(number, mensaje);
};

module.exports = { responderWhatsApp, sendWhatsAppAlert };
