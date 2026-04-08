const express = require("express");
const router = express.Router();
const {
  getAllEvents,
  deleteEvent,
  restoreEvent,
  permanentDeleteEvent,
  getAllBookings,
  getEventBookingSummary,
  sendTestEmail,
  sendTestWhatsApp,
  sendWeeklyOrganizerDigest,
  runReminderCycle,
  getMonitoringStats,
  getAuditLogs,
  getWebhookEvents,
  getNotificationJobs,
  getPushSubscribers,
  listPromoCodes,
  createPromoCode,
  togglePromoCode,
  checkInBooking,
  exportEventPasses,
  getUsers,
  forceVerifyUser,
  lockUser,
  unlockUser,
  getUserActionHistory,
  getComments,
  hideComment,
  unhideComment,
  deleteComment
} = require("../controllers/adminController");
const { protect } = require("../middleware/authMiddleware");
const { adminOnly } = require("../middleware/adminMiddleware");
const { requirePlanFeature } = require("../middleware/planMiddleware");

router.get("/events", protect, adminOnly, getAllEvents);
router.get("/bookings", protect, adminOnly, getAllBookings);
router.get("/event-booking-summary", protect, adminOnly, getEventBookingSummary);
router.get("/audit-logs", protect, adminOnly, getAuditLogs);
router.get("/webhook-events", protect, adminOnly, getWebhookEvents);
router.get("/notification-jobs", protect, adminOnly, getNotificationJobs);
router.get("/push-subscribers", protect, adminOnly, getPushSubscribers);
router.get("/monitoring", protect, adminOnly, getMonitoringStats);
router.get("/promo-codes", protect, adminOnly, requirePlanFeature("promo_codes", "Upgrade to Pro to manage promo codes"), listPromoCodes);
router.post("/promo-codes", protect, adminOnly, requirePlanFeature("promo_codes", "Upgrade to Pro to create promo codes"), createPromoCode);
router.patch("/promo-codes/:id/toggle", protect, adminOnly, requirePlanFeature("promo_codes", "Upgrade to Pro to manage promo codes"), togglePromoCode);
router.patch("/bookings/:id/check-in", protect, adminOnly, checkInBooking);
router.get("/events/:id/passes-export", protect, adminOnly, exportEventPasses);
router.get("/users", protect, adminOnly, getUsers);
router.patch("/users/:id/force-verify", protect, adminOnly, forceVerifyUser);
router.patch("/users/:id/lock", protect, adminOnly, lockUser);
router.patch("/users/:id/unlock", protect, adminOnly, unlockUser);
router.get("/users/:id/action-history", protect, adminOnly, getUserActionHistory);
router.get("/comments", protect, adminOnly, getComments);
router.patch("/comments/:id/hide", protect, adminOnly, hideComment);
router.patch("/comments/:id/unhide", protect, adminOnly, unhideComment);
router.delete("/comments/:id", protect, adminOnly, deleteComment);
router.post("/test-email", protect, adminOnly, sendTestEmail);
router.post("/test-whatsapp", protect, adminOnly, sendTestWhatsApp);
router.post("/weekly-digest", protect, adminOnly, requirePlanFeature("weekly_digest", "Upgrade to Pro to send weekly digest emails"), sendWeeklyOrganizerDigest);
router.post("/run-reminders", protect, adminOnly, runReminderCycle);
router.delete("/event/:id", protect, adminOnly, deleteEvent);
router.patch("/event/:id/restore", protect, adminOnly, restoreEvent);
router.delete("/event/:id/permanent", protect, adminOnly, permanentDeleteEvent);

module.exports = router;
