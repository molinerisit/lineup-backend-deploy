const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  whatsapp: { type: String, required: true },
  // --- NUEVOS CAMPOS DE PREFERENCIAS ---
  whatsappAlerts: { type: Boolean, default: true },
  useDoorSensors: { type: Boolean, default: false },
});

// Encriptación automática de contraseña
UserSchema.pre("save", async function () {
  // Si la contraseña no fue modificada, no hacer nada
  if (!this.isModified("password")) return;

  // Si ya es un hash bcrypt, salir
  if (this.password && (this.password.startsWith("$2a$") || this.password.startsWith("$2b$"))) {
    return;
  }

  // Hashear contraseñas en texto plano
  if (this.password && typeof this.password === "string" && this.password.length > 0) {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
  }
});

module.exports = mongoose.model("User", UserSchema);