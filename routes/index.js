const router = require("express").Router();

router.use("/auth", require("./auth.routes"));
router.use("/", require("./data.routes"));
router.use("/", require("./device.routes"));
router.use("/", require("./sensor.routes"));
router.use("/", require("./webhook.routes"));

module.exports = router;
