const router = require("express").Router();
const deviceKey = require("../middlewares/device-key");
const auth = require("../middlewares/auth");
const controller = require("../controllers/device.controller");

router.post("/device/status", deviceKey, controller.updateStatus);
router.get("/device/status", auth, controller.getStatus);

// Endpoint de diagnóstico para debug
router.get("/device/status/debug", auth, (_req, res) => {
  // Endpoint para que usuario vea el último estado guardado en backend
  const lastStatus = controller.getLastDeviceStatus?.();
  res.json({
    message: "Último estado recibido del ESP32",
    data: lastStatus
  });
});

module.exports = router;
