const jwt = require("jsonwebtoken");
const JWT_SECRET = process.env.JWT_SECRET;
const { authError } = require("../utils/authResponse");
const User = require("../models/User");
const {
  parseCookies,
  setAuthCookies,
  ACCESS_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
  clearAuthCookies
} = require("../utils/authTokens");
const { normalizePlan } = require("../utils/plans");

function extractHeaderToken(rawHeader) {
  const value = String(rawHeader || "").trim();
  if (!value) return "";
  if (/^Bearer\s+/i.test(value)) {
    return value.replace(/^Bearer\s+/i, "").trim();
  }
  return value;
}

exports.protect = async (req, res, next) => {
  const cookies = parseCookies(req);
  const headerToken = extractHeaderToken(req.header("Authorization"));
  const accessCookieToken = String(cookies[ACCESS_COOKIE_NAME] || "");
  try {
    const accessCandidates = [headerToken, accessCookieToken].filter(Boolean);
    for (const token of accessCandidates) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.typ && decoded.typ !== "access") {
          continue;
        }
        const user = await User.findById(decoded.id).select("_id role tokenVersion isAccountLocked plan");
        if (!user) continue;
        if (user.isAccountLocked) {
          return authError(res, 403, "Your account is locked. Contact admin support.", "ACCOUNT_LOCKED");
        }
        if (Number(decoded.tv || 0) !== Number(user.tokenVersion || 0)) {
          continue;
        }
        req.user = { id: String(user._id), role: user.role, plan: normalizePlan(user) };
        return next();
      } catch {
        // Try next candidate.
      }
    }

    const refreshToken = String(cookies[REFRESH_COOKIE_NAME] || "");
    if (!refreshToken) {
      if (!headerToken && !accessCookieToken) {
        return authError(res, 401, "Authorization token is required", "NO_TOKEN");
      }
      return authError(res, 401, "Invalid or expired token", "INVALID_TOKEN");
    }

    let refreshDecoded;
    try {
      refreshDecoded = jwt.verify(refreshToken, JWT_SECRET);
    } catch {
      clearAuthCookies(res);
      return authError(res, 401, "Invalid or expired refresh token", "INVALID_REFRESH_TOKEN");
    }

    if (refreshDecoded.typ !== "refresh" || !refreshDecoded.id) {
      clearAuthCookies(res);
      return authError(res, 401, "Invalid refresh token", "INVALID_REFRESH_TOKEN");
    }

    const user = await User.findById(refreshDecoded.id).select("_id role tokenVersion isAccountLocked plan");
    if (!user) {
      clearAuthCookies(res);
      return authError(res, 401, "Invalid or expired refresh token", "INVALID_REFRESH_TOKEN");
    }
    if (user.isAccountLocked) {
      clearAuthCookies(res);
      return authError(res, 403, "Your account is locked. Contact admin support.", "ACCOUNT_LOCKED");
    }
    if (Number(refreshDecoded.tv || 0) !== Number(user.tokenVersion || 0)) {
      clearAuthCookies(res);
      return authError(res, 401, "Session has been revoked. Please login again.", "SESSION_REVOKED");
    }

    const { accessToken } = setAuthCookies(res, user);
    res.setHeader("X-Access-Token", accessToken);
    req.user = { id: String(user._id), role: user.role, plan: normalizePlan(user) };
    return next();
  } catch {
    authError(res, 401, "Invalid or expired token", "INVALID_TOKEN");
  }
};
