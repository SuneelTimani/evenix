const User = require("../models/User");
const Booking = require("../models/Booking");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { authError } = require("../utils/authResponse");
const { isStrongPassword, isValidEmail, normalizeEmail, sanitizeText } = require("../utils/validation");
const {
  setAuthCookies,
  clearAuthCookies,
  parseCookies,
  REFRESH_COOKIE_NAME
} = require("../utils/authTokens");
const {
  notifyUserWelcome,
  notifyAdminNewSignup,
  notifyUserLoginAlert,
  notifyPasswordReset,
  notifySignupOtp
} = require("../utils/notifications");
const { calculateAttendeeReputation } = require("../utils/reputation");
const jwt = require("jsonwebtoken");
const JWT_SECRET = process.env.JWT_SECRET;

function generateSixDigitOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

const OTP_MAX_ATTEMPTS = 5;
const OTP_LOCK_MINUTES = 15;
const OTP_RESEND_COOLDOWN_SECONDS = 60;

function getLockMinutesLeft(lockedUntil) {
  const ms = new Date(lockedUntil).getTime() - Date.now();
  return Math.max(1, Math.ceil(ms / (60 * 1000)));
}

function getSecondsLeft(availableAt) {
  const ms = new Date(availableAt).getTime() - Date.now();
  return Math.max(1, Math.ceil(ms / 1000));
}

// Signup
exports.register = async (req, res) => {
  try {
    const { name, email, password } = req.body;
    const cleanName = sanitizeText(name, { min: 2, max: 80 });
    const cleanEmail = normalizeEmail(email);
    const rawPassword = String(password || "");

    if (!cleanName || !cleanEmail || !rawPassword) {
      return authError(res, 400, "name, email and password are required", "INVALID_INPUT");
    }

    if (!isValidEmail(cleanEmail)) {
      return authError(res, 400, "Please provide a valid email address", "INVALID_EMAIL");
    }

    if (!isStrongPassword(rawPassword)) {
      return authError(
        res,
        400,
        "Password must be 8-72 chars with at least 1 uppercase, 1 lowercase and 1 number",
        "WEAK_PASSWORD"
      );
    }

    const existing = await User.findOne({ email: cleanEmail });
    if (existing && existing.isEmailVerified !== false) {
      return authError(res, 409, "Email already registered", "EMAIL_EXISTS");
    }
    if (
      existing &&
      existing.isEmailVerified === false &&
      existing.signupOtpResendAvailableAt &&
      new Date(existing.signupOtpResendAvailableAt) > new Date()
    ) {
      const secondsLeft = getSecondsLeft(existing.signupOtpResendAvailableAt);
      return authError(res, 429, `Please wait ${secondsLeft}s before requesting another OTP`, "OTP_RESEND_COOLDOWN");
    }

    const hashedPass = await bcrypt.hash(rawPassword, 12);
    const otp = generateSixDigitOtp();
    const otpHash = crypto.createHash("sha256").update(otp).digest("hex");
    const otpExpires = new Date(Date.now() + 1000 * 60 * 10); // 10 mins

    let user = existing;
    if (user) {
      user.name = cleanName;
      user.password = hashedPass;
      user.isEmailVerified = false;
      user.signupOtpHash = otpHash;
      user.signupOtpExpires = otpExpires;
      user.signupOtpResendAvailableAt = new Date(Date.now() + OTP_RESEND_COOLDOWN_SECONDS * 1000);
      user.signupOtpAttempts = 0;
      user.signupOtpLockedUntil = null;
      await user.save();
    } else {
      user = await User.create({
        name: cleanName,
        email: cleanEmail,
        password: hashedPass,
        isEmailVerified: false,
        signupOtpHash: otpHash,
        signupOtpExpires: otpExpires,
        signupOtpResendAvailableAt: new Date(Date.now() + OTP_RESEND_COOLDOWN_SECONDS * 1000),
        signupOtpAttempts: 0,
        signupOtpLockedUntil: null
      });
    }

    await notifySignupOtp({ toUserEmail: cleanEmail, userName: cleanName, otp });

    res.status(201).json({ message: "Signup OTP sent to your email.", email: user.email });
  } catch (err) {
    res.status(500).json({ error: "Failed to register user", code: "REGISTER_FAILED" });
  }
};

exports.verifySignupOtp = async (req, res) => {
  try {
    const cleanEmail = normalizeEmail(req.body.email);
    const otp = String(req.body.otp || "").trim();

    if (!cleanEmail || !otp) {
      return authError(res, 400, "email and otp are required", "INVALID_INPUT");
    }

    const user = await User.findOne({ email: cleanEmail, isEmailVerified: false });
    if (!user) return authError(res, 400, "Invalid or expired OTP", "INVALID_OTP");

    if (user.signupOtpLockedUntil && new Date(user.signupOtpLockedUntil) > new Date()) {
      const minutesLeft = getLockMinutesLeft(user.signupOtpLockedUntil);
      return authError(res, 429, `Too many incorrect OTP attempts. Try again in ${minutesLeft} minute(s).`, "OTP_LOCKED");
    }

    if (!user.signupOtpHash || !user.signupOtpExpires || new Date(user.signupOtpExpires) <= new Date()) {
      return authError(res, 400, "Invalid or expired OTP", "INVALID_OTP");
    }

    const otpHash = crypto.createHash("sha256").update(otp).digest("hex");
    if (user.signupOtpHash !== otpHash) {
      const attempts = Number(user.signupOtpAttempts || 0) + 1;
      user.signupOtpAttempts = attempts;
      if (attempts >= OTP_MAX_ATTEMPTS) {
        user.signupOtpLockedUntil = new Date(Date.now() + OTP_LOCK_MINUTES * 60 * 1000);
        user.signupOtpAttempts = 0;
      }
      await user.save();
      if (user.signupOtpLockedUntil && new Date(user.signupOtpLockedUntil) > new Date()) {
        return authError(res, 429, `Too many incorrect OTP attempts. Try again in ${OTP_LOCK_MINUTES} minute(s).`, "OTP_LOCKED");
      }
      return authError(res, 400, "Invalid or expired OTP", "INVALID_OTP");
    }

    user.isEmailVerified = true;
    user.signupOtpHash = "";
    user.signupOtpExpires = null;
    user.signupOtpResendAvailableAt = null;
    user.signupOtpAttempts = 0;
    user.signupOtpLockedUntil = null;
    await user.save();

    Promise.allSettled([
      notifyUserWelcome({ toUserEmail: user.email, userName: user.name }),
      notifyAdminNewSignup({ userName: user.name, userEmail: user.email })
    ]);

    res.json({ message: "Email verified successfully. You can login now." });
  } catch (err) {
    res.status(500).json({ error: "Failed to verify signup OTP", code: "VERIFY_SIGNUP_OTP_FAILED" });
  }
};

exports.resendSignupOtp = async (req, res) => {
  try {
    const cleanEmail = normalizeEmail(req.body.email);
    if (!cleanEmail || !isValidEmail(cleanEmail)) {
      return authError(res, 400, "Please provide a valid email address", "INVALID_EMAIL");
    }

    const user = await User.findOne({ email: cleanEmail });
    if (!user || user.isEmailVerified !== false) {
      return authError(res, 404, "Unverified account not found", "UNVERIFIED_USER_NOT_FOUND");
    }
    if (user.signupOtpResendAvailableAt && new Date(user.signupOtpResendAvailableAt) > new Date()) {
      const secondsLeft = getSecondsLeft(user.signupOtpResendAvailableAt);
      return authError(res, 429, `Please wait ${secondsLeft}s before requesting another OTP`, "OTP_RESEND_COOLDOWN");
    }

    const otp = generateSixDigitOtp();
    user.signupOtpHash = crypto.createHash("sha256").update(otp).digest("hex");
    user.signupOtpExpires = new Date(Date.now() + 1000 * 60 * 10);
    user.signupOtpResendAvailableAt = new Date(Date.now() + OTP_RESEND_COOLDOWN_SECONDS * 1000);
    user.signupOtpAttempts = 0;
    user.signupOtpLockedUntil = null;
    await user.save();
    await notifySignupOtp({ toUserEmail: user.email, userName: user.name, otp });

    res.json({ message: "OTP resent successfully." });
  } catch (err) {
    res.status(500).json({ error: "Failed to resend signup OTP", code: "RESEND_SIGNUP_OTP_FAILED" });
  }
};

// Login
exports.login = async (req, res) => {
  try {
    const cleanEmail = normalizeEmail(req.body.email);
    const rawPassword = String(req.body.password || "");

    if (!cleanEmail || !rawPassword) {
      return authError(res, 400, "Email and password are required", "INVALID_INPUT");
    }

    if (!isValidEmail(cleanEmail)) {
      return authError(res, 400, "Please provide a valid email address", "INVALID_EMAIL");
    }

    const user = await User.findOne({ email: cleanEmail });
    if (!user) return authError(res, 401, "Invalid email or password", "INVALID_CREDENTIALS");
    if (user.isAccountLocked) {
      return authError(res, 403, "Your account is locked. Contact admin support.", "ACCOUNT_LOCKED");
    }
    if (user.isEmailVerified === false) {
      return authError(res, 403, "Please verify your email with OTP before login", "EMAIL_NOT_VERIFIED");
    }

    const match = await bcrypt.compare(rawPassword, user.password);
    if (!match) return authError(res, 401, "Invalid email or password", "INVALID_CREDENTIALS");

    const { accessToken } = setAuthCookies(res, user);

    const ipAddress = (req.headers["x-forwarded-for"] || req.ip || req.socket?.remoteAddress || "").toString();
    const userAgent = (req.headers["user-agent"] || "").toString();
    Promise.allSettled([
      notifyUserLoginAlert({
        toUserEmail: user.email,
        userName: user.name,
        ipAddress,
        userAgent
      })
    ]);

    res.json({ token: accessToken, role: user.role });
  } catch (err) {
    res.status(500).json({ error: "Failed to login", code: "LOGIN_FAILED" });
  }
};

exports.getMe = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password");
    if (!user) {
      return authError(res, 404, "User not found", "USER_NOT_FOUND");
    }
    const history = await Booking.find({ userId: req.user.id })
      .select("status date createdAt updatedAt eventId")
      .populate("eventId", "date")
      .lean();
    const reputation = calculateAttendeeReputation(history);
    res.json({
      ...user.toObject(),
      followerCount: Array.isArray(user.followers) ? user.followers.length : 0,
      followingCount: Array.isArray(user.following) ? user.following.length : 0,
      reputation
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch profile", code: "GET_ME_FAILED" });
  }
};

exports.getPublicUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select("name profileImage role followers following");
    if (!user) {
      return authError(res, 404, "User not found", "USER_NOT_FOUND");
    }
    const history = await Booking.find({ userId: req.params.id })
      .select("status date createdAt updatedAt eventId")
      .populate("eventId", "date")
      .lean();
    const reputation = calculateAttendeeReputation(history);
    res.json({
      _id: user._id,
      name: user.name || "User",
      profileImage: user.profileImage || "",
      role: user.role || "user",
      followerCount: Array.isArray(user.followers) ? user.followers.length : 0,
      followingCount: Array.isArray(user.following) ? user.following.length : 0,
      reputation
    });
  } catch {
    res.status(500).json({ error: "Failed to fetch public user", code: "GET_PUBLIC_USER_FAILED" });
  }
};

exports.followUser = async (req, res) => {
  try {
    const meId = String(req.user.id || "");
    const targetId = String(req.params.id || "");
    if (!targetId) return authError(res, 400, "User id is required", "INVALID_INPUT");
    if (meId === targetId) return authError(res, 400, "You cannot follow yourself", "INVALID_INPUT");

    const [me, target] = await Promise.all([
      User.findById(meId),
      User.findById(targetId)
    ]);
    if (!me || !target) return authError(res, 404, "User not found", "USER_NOT_FOUND");

    await Promise.all([
      User.updateOne({ _id: meId }, { $addToSet: { following: target._id } }),
      User.updateOne({ _id: target._id }, { $addToSet: { followers: me._id } })
    ]);

    const freshMe = await User.findById(meId).select("following");
    res.json({
      message: "Followed successfully.",
      followingCount: Array.isArray(freshMe?.following) ? freshMe.following.length : 0
    });
  } catch {
    res.status(500).json({ error: "Failed to follow user", code: "FOLLOW_USER_FAILED" });
  }
};

exports.unfollowUser = async (req, res) => {
  try {
    const meId = String(req.user.id || "");
    const targetId = String(req.params.id || "");
    if (!targetId) return authError(res, 400, "User id is required", "INVALID_INPUT");
    if (meId === targetId) return authError(res, 400, "You cannot unfollow yourself", "INVALID_INPUT");

    const [me, target] = await Promise.all([
      User.findById(meId),
      User.findById(targetId)
    ]);
    if (!me || !target) return authError(res, 404, "User not found", "USER_NOT_FOUND");

    await Promise.all([
      User.updateOne({ _id: meId }, { $pull: { following: target._id } }),
      User.updateOne({ _id: target._id }, { $pull: { followers: me._id } })
    ]);

    const freshMe = await User.findById(meId).select("following");
    res.json({
      message: "Unfollowed successfully.",
      followingCount: Array.isArray(freshMe?.following) ? freshMe.following.length : 0
    });
  } catch {
    res.status(500).json({ error: "Failed to unfollow user", code: "UNFOLLOW_USER_FAILED" });
  }
};

exports.getMyFollowing = async (req, res) => {
  try {
    const me = await User.findById(req.user.id)
      .select("following")
      .populate("following", "name profileImage role");
    if (!me) return authError(res, 404, "User not found", "USER_NOT_FOUND");
    res.json(Array.isArray(me.following) ? me.following : []);
  } catch {
    res.status(500).json({ error: "Failed to load following list", code: "GET_FOLLOWING_FAILED" });
  }
};

exports.updateMe = async (req, res) => {
  try {
    const { name, password, profileImage, whatsapp } = req.body;
    const user = await User.findById(req.user.id);
    let passwordChanged = false;
    if (!user) {
      return authError(res, 404, "User not found", "USER_NOT_FOUND");
    }

    if (typeof name !== "undefined") {
      const cleanName = sanitizeText(name, { min: 2, max: 80 });
      if (!cleanName) {
        return authError(res, 400, "Name must be 2-80 characters", "INVALID_NAME");
      }
      user.name = cleanName;
    }

    if (password) {
      if (!isStrongPassword(password)) {
        return authError(
          res,
          400,
          "Password must be 8-72 chars with at least 1 uppercase, 1 lowercase and 1 number",
          "WEAK_PASSWORD"
        );
      }
      user.password = await bcrypt.hash(password, 12);
      user.tokenVersion = Number(user.tokenVersion || 0) + 1;
      passwordChanged = true;
    }

    if (typeof profileImage === "string") {
      if (profileImage && !profileImage.startsWith("data:image/")) {
        return authError(res, 400, "Invalid profile image format", "INVALID_IMAGE_FORMAT");
      }
      if (profileImage.length > 2_000_000) {
        return authError(res, 413, "Profile image is too large", "IMAGE_TOO_LARGE");
      }
      user.profileImage = profileImage;
    }

    if (typeof whatsapp === "string") {
      const cleanWhatsApp = String(whatsapp || "").trim();
      if (cleanWhatsApp && !/^\+\d{7,15}$/.test(cleanWhatsApp)) {
        return authError(res, 400, "WhatsApp must be in +E164 format, e.g. +15551234567", "INVALID_WHATSAPP");
      }
      user.whatsapp = cleanWhatsApp;
    }

    await user.save();

    let nextAccessToken = "";
    if (passwordChanged) {
      const issued = setAuthCookies(res, user);
      nextAccessToken = issued.accessToken;
    }

    res.json({
      id: user._id,
      name: user.name,
      email: user.email,
      whatsapp: user.whatsapp || "",
      profileImage: user.profileImage,
      role: user.role,
      ...(nextAccessToken ? { token: nextAccessToken } : {})
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to update profile", code: "UPDATE_ME_FAILED" });
  }
};

exports.requestPasswordReset = async (req, res) => {
  try {
    const cleanEmail = normalizeEmail(req.body.email);
    // Return same response to avoid email enumeration.
    const successPayload = {
      message: "If that email exists, a 6-digit password reset OTP has been sent."
    };

    if (!cleanEmail || !isValidEmail(cleanEmail)) {
      return res.json(successPayload);
    }

    const user = await User.findOne({ email: cleanEmail });
    if (!user) {
      return res.json(successPayload);
    }
    if (user.resetOtpResendAvailableAt && new Date(user.resetOtpResendAvailableAt) > new Date()) {
      const secondsLeft = getSecondsLeft(user.resetOtpResendAvailableAt);
      return authError(
        res,
        429,
        `Please wait ${secondsLeft}s before requesting another OTP`,
        "OTP_RESEND_COOLDOWN"
      );
    }

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const otpHash = crypto.createHash("sha256").update(otp).digest("hex");
    user.resetOtpHash = otpHash;
    user.resetOtpExpires = new Date(Date.now() + 1000 * 60 * 10); // 10 mins
    user.resetOtpResendAvailableAt = new Date(Date.now() + OTP_RESEND_COOLDOWN_SECONDS * 1000);
    user.resetOtpAttempts = 0;
    user.resetOtpLockedUntil = null;
    user.resetVerifiedTokenHash = "";
    user.resetVerifiedExpires = null;
    user.resetPasswordToken = "";
    user.resetPasswordExpires = null;
    await user.save();

    const baseUrl = String(process.env.CLIENT_BASE_URL || "http://localhost:5000").replace(/\/+$/, "");
    const verifyUrl = `${baseUrl}/verify-otp.html?email=${encodeURIComponent(user.email)}`;
    await notifyPasswordReset({
      toUserEmail: user.email,
      otp,
      verifyUrl
    });

    res.json(successPayload);
  } catch (err) {
    res.status(500).json({ error: "Failed to process password reset request", code: "RESET_REQUEST_FAILED" });
  }
};

exports.verifyResetOtp = async (req, res) => {
  try {
    const cleanEmail = normalizeEmail(req.body.email);
    const otp = String(req.body.otp || "").trim();

    if (!cleanEmail || !otp) {
      return authError(res, 400, "email and otp are required", "INVALID_INPUT");
    }

    const user = await User.findOne({ email: cleanEmail });
    if (!user) return authError(res, 400, "Invalid or expired OTP", "INVALID_OTP");

    if (user.resetOtpLockedUntil && new Date(user.resetOtpLockedUntil) > new Date()) {
      const minutesLeft = getLockMinutesLeft(user.resetOtpLockedUntil);
      return authError(res, 429, `Too many incorrect OTP attempts. Try again in ${minutesLeft} minute(s).`, "OTP_LOCKED");
    }

    if (!user.resetOtpHash || !user.resetOtpExpires || new Date(user.resetOtpExpires) <= new Date()) {
      return authError(res, 400, "Invalid or expired OTP", "INVALID_OTP");
    }

    const otpHash = crypto.createHash("sha256").update(otp).digest("hex");
    if (user.resetOtpHash !== otpHash) {
      const attempts = Number(user.resetOtpAttempts || 0) + 1;
      user.resetOtpAttempts = attempts;
      if (attempts >= OTP_MAX_ATTEMPTS) {
        user.resetOtpLockedUntil = new Date(Date.now() + OTP_LOCK_MINUTES * 60 * 1000);
        user.resetOtpAttempts = 0;
      }
      await user.save();
      if (user.resetOtpLockedUntil && new Date(user.resetOtpLockedUntil) > new Date()) {
        return authError(res, 429, `Too many incorrect OTP attempts. Try again in ${OTP_LOCK_MINUTES} minute(s).`, "OTP_LOCKED");
      }
      return authError(res, 400, "Invalid or expired OTP", "INVALID_OTP");
    }

    const resetToken = crypto.randomBytes(32).toString("hex");
    user.resetVerifiedTokenHash = crypto.createHash("sha256").update(resetToken).digest("hex");
    user.resetVerifiedExpires = new Date(Date.now() + 1000 * 60 * 10); // 10 mins
    user.resetOtpHash = "";
    user.resetOtpExpires = null;
    user.resetOtpResendAvailableAt = null;
    user.resetOtpAttempts = 0;
    user.resetOtpLockedUntil = null;
    await user.save();

    res.json({ message: "OTP verified", resetToken });
  } catch (err) {
    res.status(500).json({ error: "Failed to verify OTP", code: "VERIFY_OTP_FAILED" });
  }
};

exports.resetPassword = async (req, res) => {
  try {
    const cleanEmail = normalizeEmail(req.body.email);
    const resetToken = String(req.body.resetToken || "").trim();
    const newPassword = String(req.body.password || "");

    if (!cleanEmail || !resetToken || !newPassword) {
      return authError(res, 400, "email, resetToken and password are required", "INVALID_INPUT");
    }

    if (!isStrongPassword(newPassword)) {
      return authError(
        res,
        400,
        "Password must be 8-72 chars with at least 1 uppercase, 1 lowercase and 1 number",
        "WEAK_PASSWORD"
      );
    }

    const hashedResetToken = crypto.createHash("sha256").update(resetToken).digest("hex");
    const user = await User.findOne({
      email: cleanEmail,
      resetVerifiedTokenHash: hashedResetToken,
      resetVerifiedExpires: { $gt: new Date() }
    });

    if (!user) {
      return authError(res, 400, "Invalid or expired reset session", "INVALID_RESET_SESSION");
    }

    user.password = await bcrypt.hash(newPassword, 12);
    user.resetPasswordToken = "";
    user.resetPasswordExpires = null;
    user.resetOtpHash = "";
    user.resetOtpExpires = null;
    user.resetOtpResendAvailableAt = null;
    user.resetOtpAttempts = 0;
    user.resetOtpLockedUntil = null;
    user.resetVerifiedTokenHash = "";
    user.resetVerifiedExpires = null;
    user.isEmailVerified = true;
    user.tokenVersion = Number(user.tokenVersion || 0) + 1;
    await user.save();

    const { accessToken } = setAuthCookies(res, user);
    res.json({ message: "Password reset successful.", token: accessToken, role: user.role });
  } catch (err) {
    res.status(500).json({ error: "Failed to reset password", code: "RESET_PASSWORD_FAILED" });
  }
};

exports.refreshAccessToken = async (req, res) => {
  try {
    const cookies = parseCookies(req);
    const refreshToken = String(cookies[REFRESH_COOKIE_NAME] || "");
    if (!refreshToken) {
      return authError(res, 401, "Refresh token is required", "NO_REFRESH_TOKEN");
    }

    let decoded;
    try {
      decoded = jwt.verify(refreshToken, JWT_SECRET);
    } catch {
      clearAuthCookies(res);
      return authError(res, 401, "Invalid or expired refresh token", "INVALID_REFRESH_TOKEN");
    }

    if (decoded.typ !== "refresh" || !decoded.id) {
      clearAuthCookies(res);
      return authError(res, 401, "Invalid refresh token", "INVALID_REFRESH_TOKEN");
    }

    const user = await User.findById(decoded.id);
    if (!user) {
      clearAuthCookies(res);
      return authError(res, 401, "Invalid refresh token", "INVALID_REFRESH_TOKEN");
    }
    if (user.isAccountLocked) {
      clearAuthCookies(res);
      return authError(res, 403, "Your account is locked. Contact admin support.", "ACCOUNT_LOCKED");
    }

    const tokenVersion = Number(user.tokenVersion || 0);
    if (Number(decoded.tv || 0) !== tokenVersion) {
      clearAuthCookies(res);
      return authError(res, 401, "Session has been revoked. Please login again.", "SESSION_REVOKED");
    }

    const { accessToken } = setAuthCookies(res, user);
    res.json({ token: accessToken, role: user.role });
  } catch (err) {
    res.status(500).json({ error: "Failed to refresh token", code: "REFRESH_FAILED" });
  }
};

exports.logout = async (req, res) => {
  clearAuthCookies(res);
  res.json({ message: "Logged out." });
};
