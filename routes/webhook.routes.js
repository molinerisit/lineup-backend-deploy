const router = require("express").Router();
const controller = require("../controllers/webhook.controller");

router.post("/webhook/whatsapp", controller.handleWebhook);

module.exports = router;
