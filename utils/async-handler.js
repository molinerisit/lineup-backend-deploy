// Envuelve controladores async para propagar errores al manejador central
module.exports = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
