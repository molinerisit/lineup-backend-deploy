const router = require("express").Router();
const auth = require("../middlewares/auth");
const { authLimiter } = require("../middlewares/rate-limit");
const controller = require("../controllers/auth.controller");

router.post("/register", authLimiter, controller.register);
router.post("/login", authLimiter, controller.login);
router.get("/profile", auth, controller.getProfile);
router.put("/profile", auth, controller.updateProfile);
router.delete("/profile", auth, controller.deleteAccount);

module.exports = router;
