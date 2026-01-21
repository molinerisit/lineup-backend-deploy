const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  whatsapp: { type: String, required: true },
  // --- NUEVOS CAMPOS DE PREFERENCIAS ---
  whatsappAlerts: { type: Boolean, default: true },
  useDoorSensors: { type: Boolean, default: false }
});

// Encriptación automática de contraseña
UserSchema.pre('save', async function(next) {
  // Si la contraseña no fue modificada, continuar
  if (!this.isModified('password')) {
    return next();
  }
  
  try {
    // Si la contraseña ya es un hash bcrypt válido, no volver a hashear
    if (this.password && (this.password.startsWith('$2a$') || this.password.startsWith('$2b$'))) {
      return next();
    }
    
    // Si la contraseña es válida y no es un hash, hashearla
    if (this.password && typeof this.password === 'string' && this.password.length > 0) {
      const salt = await bcrypt.genSalt(10);
      this.password = await bcrypt.hash(this.password, salt);
    }
    
    next();
  } catch (error) {
    console.error("❌ Error in password hashing middleware:", error.message);
    next(error);
  }
});

module.exports = mongoose.model('User', UserSchema);