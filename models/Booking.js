const mongoose = require("mongoose");

const bookingSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  eventId: { type: mongoose.Schema.Types.ObjectId, ref: "Event", required: true },
  attendeeName: { type: String, trim: true, maxlength: 120 },
  attendeeEmail: { type: String, trim: true, lowercase: true, maxlength: 160 },
  attendeeWhatsApp: { type: String, trim: true, maxlength: 20 },
  recurrenceSeriesId: { type: mongoose.Schema.Types.ObjectId, ref: "Event", default: null, index: true },
  ticketType: { type: String, default: "Standard" },
  quantity: { type: Number, default: 1 },
  totalAmount: { type: Number, default: 0 },
  promoCode: { type: String, default: "", trim: true, uppercase: true },
  discountAmount: { type: Number, default: 0, min: 0 },
  paymentMethod: { type: String, default: "card" },
  stripeSessionId: { type: String, default: "", index: true, sparse: true },
  stripePaymentIntentId: { type: String, default: "", index: true, sparse: true },
  paymentStatus: { type: String, enum: ["unpaid", "paid", "failed", "refunded"], default: "unpaid" },
  status: {
    type: String,
    enum: ["pending", "confirmed", "cancelled", "checked_in", "refunded"],
    default: "pending"
  },
  date: { type: Date, default: Date.now }
}, { timestamps: true });

// Heavy-query indexes for admin/user booking views and analytics.
bookingSchema.index({ eventId: 1, date: -1, status: 1 });
bookingSchema.index({ userId: 1, date: -1 });
bookingSchema.index({ recurrenceSeriesId: 1, date: -1, status: 1 });

module.exports = mongoose.model("Booking", bookingSchema);
