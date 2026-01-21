// Manejador de errores centralizado
module.exports = (err, _req, res, _next) => {
  const status = err.status || 500;
  const message = err.message || "Error inesperado";
  console.error("❌", message, err.stack);
  res.status(status).json({ message });
};
