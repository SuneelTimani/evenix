const mongoose = require("mongoose");

const eventCommentSchema = new mongoose.Schema(
  {
    eventId: { type: mongoose.Schema.Types.ObjectId, ref: "Event", required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: "EventComment", default: null, index: true },
    userName: { type: String, required: true, trim: true, maxlength: 80 },
    userProfileImage: { type: String, default: "" },
    text: { type: String, required: true, trim: true, maxlength: 500 },
    contentType: { type: String, enum: ["comment", "qna"], default: "comment", index: true },
    qnaStatus: { type: String, enum: ["open", "answered", "dismissed"], default: "open", index: true },
    answeredAt: { type: Date, default: null },
    answeredBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    helpfulVotes: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    isHidden: { type: Boolean, default: false, index: true },
    hiddenAt: { type: Date, default: null },
    hiddenBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    hiddenReason: { type: String, default: "", maxlength: 200 },
    reports: {
      type: [{
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        reason: { type: String, default: "", maxlength: 200 },
        createdAt: { type: Date, default: Date.now }
      }],
      default: []
    }
  },
  { timestamps: true }
);

eventCommentSchema.index({ eventId: 1, contentType: 1, createdAt: -1 });
eventCommentSchema.index({ eventId: 1, parentId: 1, createdAt: 1 });
eventCommentSchema.index({ eventId: 1, contentType: 1, qnaStatus: 1, createdAt: 1 });

module.exports = mongoose.model("EventComment", eventCommentSchema);
