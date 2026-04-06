/**
 * churnDetection.js
 * Identifies users likely to cancel upcoming bookings.
 * Scores each booking using behavioral signals — pure JS, no libraries.
 */

"use strict";

const { calculateAttendeeReputation } = require("../reputation");

// ─── User history features ────────────────────────────────────────────────────

function extractUserFeatures(userId, userBookings, allBookings) {
  const uid = String(userId);

  // Historical cancel rate for this user
  const pastBookings     = userBookings.filter((b) => b.status !== "pending");
  const pastCancellations = pastBookings.filter((b) => b.status === "cancelled").length;
  const userCancelRate   = pastBookings.length > 0
    ? pastCancellations / pastBookings.length
    : 0;

  // How many events has this user attended (checked_in)?
  const attendedCount = userBookings.filter((b) => b.status === "checked_in").length;

  // Recency: days since last booking
  const sortedBookings = [...userBookings].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );
  const lastBookingDate = sortedBookings[0]?.createdAt
    ? new Date(sortedBookings[0].createdAt)
    : null;
  const daysSinceLastBooking = lastBookingDate
    ? (Date.now() - lastBookingDate) / (1000 * 60 * 60 * 24)
    : 999;

  // Booking frequency (bookings per month over last 6 months)
  const sixMonthsAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
  const recentBookings = userBookings.filter(
    (b) => new Date(b.createdAt) >= sixMonthsAgo
  ).length;
  const bookingFrequency = recentBookings / 6; // per month

  return {
    userCancelRate,
    attendedCount,
    daysSinceLastBooking,
    bookingFrequency,
    totalBookings: userBookings.length,
  };
}

// ─── Booking-level churn features ─────────────────────────────────────────────

function extractBookingFeatures(booking, event, userFeatures) {
  const eventDate  = event ? new Date(event.date) : null;
  const now        = new Date();
  const daysUntil  = eventDate
    ? Math.max(0, (eventDate - now) / (1000 * 60 * 60 * 24))
    : 30;

  // Time between booking and event (last-minute bookings churn less)
  const bookingDate   = new Date(booking.createdAt);
  const daysBooked    = eventDate
    ? Math.max(0, (eventDate - bookingDate) / (1000 * 60 * 60 * 24))
    : 30;
  const isLastMinute  = daysBooked < 3 ? 1 : 0;

  // Ticket type — VIP churns less (higher commitment)
  const isVip = String(booking.ticketType || "").toLowerCase() === "vip" ? 1 : 0;

  // Payment status — paid bookings churn far less
  const isPaid = booking.paymentStatus === "paid" ? 1 : 0;

  // Quantity — group bookings churn less
  const quantity = Number(booking.quantity || 1);

  return {
    daysUntil,
    daysBooked,
    isLastMinute,
    isVip,
    isPaid,
    quantity,
    ...userFeatures,
  };
}

// ─── Churn score model ────────────────────────────────────────────────────────

const CHURN_WEIGHTS = {
  intercept:          0.15,
  userCancelRate:     0.40,   // strongest signal
  daysUntil:          0.001,  // further away = slightly higher churn
  daysBooked:         0.002,  // booked very early = higher dropout
  isLastMinute:      -0.10,   // last-minute = committed
  isVip:             -0.12,   // VIP = invested
  isPaid:            -0.20,   // paid = committed
  quantityBonus:     -0.03,   // per extra ticket
  lowFrequency:       0.10,   // infrequent users churn more
  neverAttended:      0.08,   // never checked in before
};

function churnScore(features) {
  const quantityBonus = Math.min((features.quantity - 1) * CHURN_WEIGHTS.quantityBonus, 0);
  const lowFrequency  = features.bookingFrequency < 0.5 ? CHURN_WEIGHTS.lowFrequency : 0;
  const neverAttended = features.attendedCount === 0   ? CHURN_WEIGHTS.neverAttended  : 0;

  const score =
    CHURN_WEIGHTS.intercept +
    CHURN_WEIGHTS.userCancelRate  * features.userCancelRate +
    CHURN_WEIGHTS.daysUntil       * Math.min(features.daysUntil, 90) +
    CHURN_WEIGHTS.daysBooked      * Math.min(features.daysBooked, 60) +
    CHURN_WEIGHTS.isLastMinute    * features.isLastMinute +
    CHURN_WEIGHTS.isVip           * features.isVip +
    CHURN_WEIGHTS.isPaid          * features.isPaid +
    quantityBonus +
    lowFrequency +
    neverAttended;

  return Math.min(0.99, Math.max(0.01, score));
}

function churnRisk(score) {
  if (score >= 0.65) return "high";
  if (score >= 0.35) return "medium";
  return "low";
}

function churnActions(risk, features) {
  if (risk === "high") {
    return [
      "Send personalised reminder with event highlights",
      features.isPaid ? "Remind them they have a paid ticket" : "Offer a small incentive to keep booking",
      features.daysUntil <= 7 ? "Send urgency: event is this week" : "Send reminder 3 days before event",
    ];
  }
  if (risk === "medium") {
    return [
      "Send standard event reminder",
      "Include agenda or speaker preview in reminder",
    ];
  }
  return ["No action needed — user is likely to attend"];
}

// ─── Main function ────────────────────────────────────────────────────────────

/**
 * Analyse churn risk for all pending/confirmed bookings of an event.
 *
 * @param {Object} event
 * @param {Array}  eventBookings  - bookings for this event (populated userId)
 * @param {Array}  allBookings    - all bookings system-wide
 * @returns {Array} sorted by churn score desc
 */
function detectChurn(event, eventBookings, allBookings) {
  const results = [];

  for (const booking of eventBookings) {
    if (!["pending", "confirmed"].includes(booking.status)) continue;

    const userId       = String(booking.userId?._id || booking.userId || "");
    const userBookings = allBookings.filter(
      (b) => String(b.userId?._id || b.userId) === userId
    );

    const userFeatures    = extractUserFeatures(userId, userBookings, allBookings);
    const bookingFeatures = extractBookingFeatures(booking, event, userFeatures);
    const score           = churnScore(bookingFeatures);
    const risk            = churnRisk(score);
    const actions         = churnActions(risk, bookingFeatures);

    results.push({
      bookingId:    String(booking._id),
      userId,
      userEmail:    booking.userId?.email || "unknown",
      userName:     booking.userId?.name  || "unknown",
      ticketType:   booking.ticketType || "Standard",
      quantity:     booking.quantity   || 1,
      paymentStatus: booking.paymentStatus || "unpaid",
      churnScore:   Math.round(score * 100),
      churnRisk:    risk,
      attendeeReputation: calculateAttendeeReputation(userBookings),
      recommendedActions: actions,
      features: {
        historicalCancelRate: Math.round(userFeatures.userCancelRate * 100),
        daysUntilEvent:       Math.round(bookingFeatures.daysUntil),
        isPaid:               !!bookingFeatures.isPaid,
        isVip:                !!bookingFeatures.isVip,
      },
    });
  }

  results.sort((a, b) => b.churnScore - a.churnScore);
  return results;
}

/**
 * Summary stats for an event's churn analysis.
 */
function churnSummary(churnResults) {
  const high   = churnResults.filter((r) => r.churnRisk === "high").length;
  const medium = churnResults.filter((r) => r.churnRisk === "medium").length;
  const low    = churnResults.filter((r) => r.churnRisk === "low").length;
  const avgScore = churnResults.length
    ? Math.round(churnResults.reduce((s, r) => s + r.churnScore, 0) / churnResults.length)
    : 0;
  const averageReputationScore = churnResults.length
    ? Math.round(churnResults.reduce((sum, row) => sum + Number(row.attendeeReputation?.score || 0), 0) / churnResults.length)
    : 0;

  return {
    total: churnResults.length,
    high,
    medium,
    low,
    averageChurnScore: avgScore,
    atRiskCount: high + medium,
    averageReputationScore
  };
}

module.exports = { detectChurn, churnSummary };
