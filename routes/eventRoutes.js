const express = require("express");
const router = express.Router();
const {
  createEvent,
  getEvents,
  getPersonalizedRecommendations,
  getFollowingFeed,
  getSavedEvents,
  getEventSeries,
  saveEventForUser,
  unsaveEventForUser,
  updateEvent,
  getEventComments,
  getEventQna,
  streamEventComments,
  publishTypingIndicator,
  addEventComment,
  addEventQnaQuestion,
  addEventReply,
  toggleCommentHelpful,
  reportEventComment,
  updateEventQnaStatus
} = require("../controllers/eventController");
const { protect } = require("../middleware/authMiddleware");
const { adminOnly } = require("../middleware/adminMiddleware");
const { createRateLimiter } = require("../middleware/rateLimiter");

const commentRateLimit = createRateLimiter({
  windowMs: 60 * 1000,
  max: 8,
  message: "Too many comments in a short time. Please wait a minute."
});
const reportRateLimit = createRateLimiter({
  windowMs: 60 * 1000,
  max: 12,
  message: "Too many reports in a short time. Please wait a minute."
});
const typingRateLimit = createRateLimiter({
  windowMs: 60 * 1000,
  max: 40,
  message: "Typing updates are too frequent. Please slow down."
});

router.get("/", getEvents);
router.get("/recommendations", protect, getPersonalizedRecommendations);
router.get("/feed/following", protect, getFollowingFeed);
router.get("/saved", protect, getSavedEvents);
router.get("/:id/series", getEventSeries);
router.post("/:id/save", protect, saveEventForUser);
router.delete("/:id/save", protect, unsaveEventForUser);
router.get("/:id/comments", getEventComments);
router.get("/:id/qna", getEventQna);
router.get("/:id/comments/stream", streamEventComments);
router.post("/:id/comments/typing", protect, typingRateLimit, publishTypingIndicator);
router.post("/:id/comments", protect, commentRateLimit, addEventComment);
router.post("/:id/qna", protect, commentRateLimit, addEventQnaQuestion);
router.post("/:id/comments/:commentId/reply", protect, commentRateLimit, addEventReply);
router.patch("/:id/comments/:commentId/helpful", protect, reportRateLimit, toggleCommentHelpful);
router.patch("/:id/qna/:commentId/status", protect, reportRateLimit, updateEventQnaStatus);
router.post("/:id/comments/:commentId/report", protect, reportRateLimit, reportEventComment);
router.post("/create", protect, adminOnly, createEvent);
router.put("/:id", protect, adminOnly, updateEvent);

module.exports = router;
