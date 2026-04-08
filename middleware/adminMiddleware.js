const User = require("../models/User");
const { authError } = require("../utils/authResponse");
const { normalizePlan } = require("../utils/plans");

exports.adminOnly = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).select("_id role plan");
    if (!user) return authError(res, 404, "User not found", "USER_NOT_FOUND");
    if (user.role !== "admin") return authError(res, 403, "Admins only", "ADMIN_ONLY");
    // Keep request role in sync with DB role for downstream logic (e.g. audit logging).
    req.user.role = user.role;
    req.user.plan = normalizePlan(user);
    next();
  } catch (err) {
    res.status(500).json({ error: "Failed to authorize admin request", code: "ADMIN_AUTH_FAILED" });
  }
};
