const router = require("express").Router();
const deviceKey = require("../middlewares/device-key");
const auth = require("../middlewares/auth");
const controller = require("../controllers/device.controller");

router.post("/device/status", deviceKey, controller.updateStatus);
router.get("/device/status", auth, controller.getStatus);

module.exports = router;
