const mongoose = require("mongoose");
const config = require("./env");

const connectDatabase = async () => {
  try {
    await mongoose.connect(config.mongoUri);
    console.log("✅ MongoDB conectado");
  } catch (error) {
    console.error("❌ Error al conectar MongoDB", error);
    process.exit(1);
  }
};

module.exports = connectDatabase;
