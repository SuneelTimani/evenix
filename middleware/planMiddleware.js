"use strict";

const User = require("../models/User");
const { authError } = require("../utils/authResponse");
const { hasPlanFeature, normalizePlan } = require("../utils/plans");

function requirePlanFeature(featureKey, message = "Upgrade to Pro to use this feature") {
  return async (req, res, next) => {
    try {
      const user = await User.findById(req.user?.id).select("_id role plan");
      if (!user) return authError(res, 404, "User not found", "USER_NOT_FOUND");
      req.user.role = user.role;
      req.user.plan = normalizePlan(user);
      if (!hasPlanFeature(user, featureKey)) {
        return authError(res, 403, message, "PLAN_UPGRADE_REQUIRED");
      }
      next();
    } catch {
      return res.status(500).json({ error: "Failed to validate subscription plan", code: "PLAN_CHECK_FAILED" });
    }
  };
}

module.exports = { requirePlanFeature };
