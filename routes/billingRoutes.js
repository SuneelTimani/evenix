const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const {
  createProCheckoutSession,
  createBillingPortalSession,
  getMyPlan
} = require("../controllers/billingController");

router.get("/plan", protect, getMyPlan);
router.post("/pro/checkout-session", protect, createProCheckoutSession);
router.post("/portal-session", protect, createBillingPortalSession);

module.exports = router;
