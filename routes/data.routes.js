const router = require("express").Router();
const deviceKey = require("../middlewares/device-key");
const controller = require("../controllers/data.controller");

router.post("/data", deviceKey, controller.ingestMeasurement);
router.get("/device/config", deviceKey, controller.deviceConfig);

module.exports = router;
