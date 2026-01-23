const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const compression = require("compression");
const mongoSanitize = require("express-mongo-sanitize");
const routes = require("./routes");
const { limiter } = require("./middlewares/rate-limit");
const errorHandler = require("./middlewares/error-handler");
const connectDatabase = require("./config/database");
const config = require("./config/env");

const app = express();
app.set("trust proxy", 1);

app.use(helmet());
app.use(morgan(config.env === "production" ? "combined" : "dev"));
app.use(
  cors({
    origin: config.cors.origins.includes("*") ? "*" : config.cors.origins,
  })
);
app.use(express.json({ limit: "512kb" }));
app.use(mongoSanitize());
app.use(compression());
app.use(limiter);

app.use("/api", routes);
app.get("/health", (_req, res) => res.send("ALIVE"));

app.use(errorHandler);

const start = async () => {
  await connectDatabase();
  app.listen(config.port, () => {
    console.log(`🚀 Servidor LineUp escuchando en puerto ${config.port}`);
  });
};

module.exports = { app, start };
