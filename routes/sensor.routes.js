const router = require("express").Router();
const auth = require("../middlewares/auth");
const controller = require("../controllers/sensor.controller");

router.get("/latest", auth, controller.getLatest);
router.get("/history", auth, controller.getHistory);
router.post("/config", auth, controller.upsertSensor);
router.delete("/:hardwareId", auth, controller.deleteSensor);
router.get("/ids", auth, controller.getHardwareIds);

module.exports = router;
