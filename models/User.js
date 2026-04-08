const mongoose = require("mongoose");

const savedEventSchema = new mongoose.Schema(
  {
    eventId: { type: mongoose.Schema.Types.ObjectId, ref: "Event", required: true },
    reminderHoursBefore: { type: Number, min: 0, max: 168, default: 24 },
    createdAt: { type: Date, default: Date.now },
    lastReminderSentAt: { type: Date, default: null },
    lastReminderEventDate: { type: Date, default: null }
  },
  { _id: false }
);

const pushSubscriptionSchema = new mongoose.Schema(
  {
    endpoint: { type: String, required: true, trim: true },
    keys: {
      p256dh: { type: String, default: "", trim: true },
      auth: { type: String, default: "", trim: true }
    },
    userAgent: { type: String, default: "", trim: true, maxlength: 300 },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
  },
  { _id: false }
);

const userPlanSchema = new mongoose.Schema(
  {
    tier: { type: String, enum: ["free", "pro"], default: "free" },
    status: { type: String, enum: ["active", "inactive"], default: "active" },
    startedAt: { type: Date, default: Date.now },
    renewsAt: { type: Date, default: null }
  },
  { _id: false }
);

const userSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  password: String,
  whatsapp: { type: String, default: "", trim: true, maxlength: 20 },
  profileImage: { type: String, default: "" },
  following: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  followers: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  savedEvents: { type: [savedEventSchema], default: [] },
  pushSubscriptions: { type: [pushSubscriptionSchema], default: [] },
  plan: { type: userPlanSchema, default: () => ({ tier: "free", status: "active", startedAt: new Date(), renewsAt: null }) },
  stripeCustomerId: { type: String, default: "", trim: true },
  stripeSubscriptionId: { type: String, default: "", trim: true },
  role: { type: String, default: "user" }, // user | admin
  tokenVersion: { type: Number, default: 0 },
  isEmailVerified: { type: Boolean, default: false },
  isAccountLocked: { type: Boolean, default: false },
  accountLockedAt: { type: Date, default: null },
  signupOtpHash: { type: String, default: "" },
  signupOtpExpires: { type: Date, default: null },
  signupOtpResendAvailableAt: { type: Date, default: null },
  signupOtpAttempts: { type: Number, default: 0 },
  signupOtpLockedUntil: { type: Date, default: null },
  resetPasswordToken: { type: String, default: "" },
  resetPasswordExpires: { type: Date, default: null },
  resetOtpHash: { type: String, default: "" },
  resetOtpExpires: { type: Date, default: null },
  resetOtpResendAvailableAt: { type: Date, default: null },
  resetOtpAttempts: { type: Number, default: 0 },
  resetOtpLockedUntil: { type: Date, default: null },
  resetVerifiedTokenHash: { type: String, default: "" },
  resetVerifiedExpires: { type: Date, default: null }
});

module.exports = mongoose.model("User", userSchema);
