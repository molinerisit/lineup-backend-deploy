const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Sensor = require("../models/Sensor");
const Measurement = require("../models/Measurement");
const config = require("../config/env");
const asyncHandler = require("../utils/async-handler");

const signToken = (user) =>
  jwt.sign({ id: user._id.toString(), username: user.username }, config.jwtSecret, {
    expiresIn: "7d",
  });

exports.register = asyncHandler(async (req, res) => {
  const { username, password, whatsapp, whatsappAlerts = true, useDoorSensors = false } = req.body;
  if (!username || !password || !whatsapp)
    return res.status(400).json({ message: "username, password y whatsapp son requeridos" });

  const exists = await User.findOne({ username });
  if (exists) return res.status(409).json({ message: "Usuario ya existe" });

  const user = await User.create({
    username,
    password,
    whatsapp,
    whatsappAlerts,
    useDoorSensors,
  });

  return res.status(201).json({
    message: "Usuario creado",
    token: signToken(user),
    username: user.username,
  });
});

exports.login = asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ message: "Credenciales incompletas" });

  const user = await User.findOne({ username });
  if (!user) return res.status(401).json({ message: "Credenciales inválidas" });

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) return res.status(401).json({ message: "Credenciales inválidas" });

  return res.json({ token: signToken(user), username: user.username });
});

exports.getProfile = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id).select("-password");
  if (!user) return res.status(404).json({ message: "Usuario no encontrado" });
  res.json(user);
});

exports.updateProfile = asyncHandler(async (req, res) => {
  const { whatsapp, oldPassword, newPassword, whatsappAlerts, useDoorSensors } = req.body;

  const whatsappStr = (whatsapp ?? "").toString().trim();
  if (!whatsappStr) {
    return res.status(400).json({ message: "WhatsApp es requerido" });
  }

  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ message: "Usuario no encontrado" });

  // Cambio de contraseña
  if (newPassword && newPassword.trim()) {
    let isMatch = false;
    try {
      isMatch = await bcrypt.compare(oldPassword || "", user.password);
    } catch (err) {
      console.error("❌ bcrypt.compare error:", err.message);
      return res.status(401).json({ message: "Contraseña actual incorrecta" });
    }
    if (!isMatch) return res.status(401).json({ message: "Contraseña actual incorrecta" });
    user.password = newPassword.trim();
  }
  
  // Actualizar campos
  user.whatsapp = whatsappStr;
  
  if (typeof whatsappAlerts === "boolean") {
    user.whatsappAlerts = whatsappAlerts;
  }
  if (typeof useDoorSensors === "boolean") {
    user.useDoorSensors = useDoorSensors;
  }

  try {
    await user.save();
    res.json({ 
      message: "Perfil actualizado",
      username: user.username,
      whatsapp: user.whatsapp,
      whatsappAlerts: user.whatsappAlerts,
      useDoorSensors: user.useDoorSensors
    });
  } catch (error) {
    console.error("❌ Error saving user profile:", error.message, error);
    return res.status(500).json({ message: "Error al guardar perfil: " + error.message });
  }
});

exports.deleteAccount = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  await Measurement.deleteMany({ owner: userId });
  await Sensor.deleteMany({ owner: userId });
  await User.findByIdAndDelete(userId);
  res.json({ message: "Cuenta eliminada" });
});
