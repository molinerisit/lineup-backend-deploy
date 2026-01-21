const path = require("path");
const dotenv = require("dotenv");

// Carga de variables de entorno desde la raíz del proyecto
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const requiredKeys = ["MONGODB_URI", "JWT_SECRET"];
const missing = requiredKeys.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`❌ Faltan variables de entorno requeridas: ${missing.join(", ")}`);
  process.exit(1);
}

const toNumber = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const rawOrigins = process.env.CORS_ORIGINS || "*";
const corsOrigins = rawOrigins
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

module.exports = {
  env: process.env.NODE_ENV || "development",
  port: toNumber(process.env.PORT, 3000),
  mongoUri: process.env.MONGODB_URI,
  jwtSecret: process.env.JWT_SECRET,
  alertCooldownMinutes: toNumber(process.env.ALERT_COOLDOWN, 30),
  evolution: {
    url: process.env.EVOLUTION_API_URL,
    apiKey: process.env.EVOLUTION_API_KEY,
    instance: process.env.EVOLUTION_INSTANCE,
  },
  deviceApiKey: process.env.DEVICE_API_KEY || null,
  cors: {
    origins: corsOrigins.length ? corsOrigins : ["*"],
  },
};
