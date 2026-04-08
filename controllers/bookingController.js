const mongoose = require("mongoose");
const Booking = require("../models/Booking");
const Event = require("../models/Event");
const PromoCode = require("../models/PromoCode");
const WaitlistEntry = require("../models/WaitlistEntry");
const StripeWebhookEvent = require("../models/StripeWebhookEvent");
const { isValidEmail, normalizeEmail, sanitizeText } = require("../utils/validation");
const { withRetry, createCircuitBreaker } = require("../utils/resilience");
const { logAdminAction } = require("../utils/audit");
const { getDynamicTicketPrice } = require("../utils/dynamicPricing");
const {
  notifyBookingConfirmed,
  notifyBookingCancelled,
  notifyAdminNewBooking,
  notifyBookingConfirmedWhatsApp,
  notifyBookingCancelledWhatsApp,
  notifyAdminNewBookingWhatsApp,
  notifyWaitlistPromoted
} = require("../utils/notifications");
const { calculateAttendeeReputation } = require("../utils/reputation");
const { handleStripeSubscriptionWebhook } = require("./billingController");
let Stripe = null;
try {
  Stripe = require("stripe");
} catch {
  Stripe = null;
}

const stripe = Stripe && process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const clientBaseUrl = process.env.CLIENT_BASE_URL || "http://localhost:5000";
const stripeBreaker = createCircuitBreaker("stripe", { failureThreshold: 4, cooldownMs: 20000 });

function bookingServerError(res, code, message = "Booking request failed") {
  return res.status(500).json({ error: message, code });
}

const BOOKING_STATUS_TRANSITIONS = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["checked_in", "cancelled", "refunded"],
  checked_in: ["refunded"],
  cancelled: [],
  refunded: []
};

function parseObjectId(id) {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return new mongoose.Types.ObjectId(id);
}

function pickTicket(event, ticketName) {
  if (!Array.isArray(event.ticketTypes) || event.ticketTypes.length === 0) return null;
  if (!ticketName) return event.ticketTypes[0];
  return event.ticketTypes.find((t) => t.name === ticketName) || null;
}

function assertSeatAvailability(event, ticket, quantity) {
  if (event.status === "cancelled") {
    return "This event is cancelled and cannot be booked";
  }
  if (event.seatsBooked + quantity > event.capacity) {
    return "Not enough seats remaining";
  }
  if (!ticket) {
    return "Selected ticket type is not available for this event";
  }
  if (ticket.sold + quantity > ticket.quantity) {
    return `Not enough availability for ${ticket.name} tickets`;
  }
  return null;
}

async function validateAndComputePromo({ eventId, codeRaw, subtotal }) {
  const code = String(codeRaw || "").trim().toUpperCase();
  if (!code) return { promo: null, promoCode: "", discountAmount: 0, finalAmount: subtotal };

  const promo = await PromoCode.findOne({ eventId, code, active: true });
  if (!promo) return { error: "Invalid promo code" };

  if (promo.expiresAt && new Date(promo.expiresAt).getTime() < Date.now()) {
    return { error: "Promo code has expired" };
  }
  if (Number(promo.maxUses || 0) > 0 && Number(promo.usedCount || 0) >= Number(promo.maxUses || 0)) {
    return { error: "Promo code usage limit reached" };
  }

  let discountAmount = 0;
  if (promo.discountType === "percent") {
    discountAmount = (subtotal * Number(promo.discountValue || 0)) / 100;
  } else {
    discountAmount = Number(promo.discountValue || 0);
  }
  discountAmount = Math.max(0, Math.min(subtotal, Number(discountAmount.toFixed(2))));
  const finalAmount = Number(Math.max(0, subtotal - discountAmount).toFixed(2));

  return {
    promo,
    promoCode: code,
    discountAmount,
    finalAmount
  };
}

function applySeatBooking(event, ticketName, quantity) {
  event.seatsBooked += quantity;
  const ticket = event.ticketTypes.find((t) => t.name === ticketName);
  if (ticket) {
    ticket.sold += quantity;
  }
}

function releaseSeatBooking(event, ticketName, quantity) {
  event.seatsBooked = Math.max(0, event.seatsBooked - quantity);
  const ticket = event.ticketTypes.find((t) => t.name === ticketName);
  if (ticket) {
    ticket.sold = Math.max(0, ticket.sold - quantity);
  }
}

function canTransition(current, next) {
  return BOOKING_STATUS_TRANSITIONS[current]?.includes(next) || false;
}

function getTicketCharge(event, ticket, quantity = 1) {
  const pricing = getDynamicTicketPrice(event, ticket);
  const qty = Math.max(1, Number(quantity || 1));
  return {
    ...pricing,
    quantity: qty,
    subtotal: Number((pricing.dynamicPrice * qty).toFixed(2))
  };
}

function getBookingSeriesFields(event) {
  const recurringSeriesId = event?.recurrenceSeriesId || (event?.recurrenceEnabled ? event?._id : null) || null;
  return {
    recurrenceSeriesId: recurringSeriesId || null
  };
}

function getWindowCutoff(eventDate, hoursBefore) {
  const eventTime = new Date(eventDate).getTime();
  const hours = Number(hoursBefore);
  const safeHours = Number.isFinite(hours) && hours >= 0 ? hours : 0;
  return eventTime - safeHours * 60 * 60 * 1000;
}

function isWindowOpen(eventDate, hoursBefore) {
  return Date.now() <= getWindowCutoff(eventDate, hoursBefore);
}

async function tryPromoteWaitlist(event, req = null) {
  if (!event || event.isDeleted || event.status === "cancelled" || event.waitlistEnabled === false) return null;
  if (!Array.isArray(event.ticketTypes)) return null;

  const entries = await WaitlistEntry.find({
    eventId: event._id,
    status: "waiting"
  }).sort({ createdAt: 1 }).limit(30);

  for (const entry of entries) {
    const ticket = pickTicket(event, entry.ticketType);
    const availabilityError = assertSeatAvailability(event, ticket, Number(entry.quantity || 1));
    if (availabilityError) continue;

    applySeatBooking(event, ticket.name, Number(entry.quantity || 1));
    await event.save();

    const pricing = getTicketCharge(event, ticket, Number(entry.quantity || 1));
    const booking = await Booking.create({
      userId: entry.userId,
      eventId: event._id,
      ...getBookingSeriesFields(event),
      attendeeName: entry.attendeeName || "",
      attendeeEmail: normalizeEmail(entry.attendeeEmail || ""),
      attendeeWhatsApp: String(entry.attendeeWhatsApp || "").trim(),
      ticketType: ticket.name,
      quantity: Number(entry.quantity || 1),
      totalAmount: pricing.subtotal,
      paymentMethod: "waitlist",
      paymentStatus: "unpaid",
      status: "pending"
    });

    entry.status = "promoted";
    entry.promotedAt = new Date();
    entry.note = `Promoted to booking ${booking._id}`;
    await entry.save();

    if (req) {
      await logAdminAction(req, {
        action: "waitlist_promote",
        targetType: "booking",
        targetId: booking._id,
        details: { eventId: event._id, waitlistEntryId: entry._id }
      });
    }

    Promise.allSettled([
      notifyWaitlistPromoted({
        toUserEmail: booking.attendeeEmail,
        userName: booking.attendeeName,
        eventTitle: event.title || "Event",
        eventDate: event.date,
        location: event.location,
        quantity: booking.quantity,
        amount: booking.totalAmount,
        dashboardUrl: process.env.CLIENT_BASE_URL
          ? `${process.env.CLIENT_BASE_URL.replace(/\/+$/, "")}/user.html`
          : ""
      }),
      notifyBookingConfirmedWhatsApp({
        toWhatsApp: booking.attendeeWhatsApp,
        eventTitle: event.title || "Event",
        quantity: booking.quantity,
        amount: booking.totalAmount
      })
    ]);

    return booking;
  }

  return null;
}

async function findActiveEventById(eventObjectId) {
  return Event.findOne({ _id: eventObjectId, isDeleted: { $ne: true } });
}

async function releaseSeatsForRefundIfNeeded(booking) {
  if (!booking) return;
  const releasableStatuses = ["pending", "confirmed", "checked_in"];
  if (!releasableStatuses.includes(booking.status)) return;
  const event = await Event.findById(booking.eventId);
  if (!event) return;
  releaseSeatBooking(event, booking.ticketType, booking.quantity);
  await event.save();
  await tryPromoteWaitlist(event);
}

async function buildReputationMap(userIds) {
  const ids = [...new Set((Array.isArray(userIds) ? userIds : []).map((id) => String(id || "")).filter(Boolean))];
  if (!ids.length) return new Map();

  const history = await Booking.find({ userId: { $in: ids } })
    .select("userId status date createdAt updatedAt eventId")
    .populate("eventId", "date")
    .lean();

  const grouped = new Map();
  history.forEach((row) => {
    const key = String(row.userId || "");
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  });

  return new Map(ids.map((id) => [id, calculateAttendeeReputation(grouped.get(id) || [])]));
}

async function finalizePaidStripeSession(session, expectedUserId = "") {
  if (!session || session.payment_status !== "paid") {
    throw new Error("Payment not completed for this session");
  }

  const existing = await Booking.findOne({ stripeSessionId: session.id });
  if (existing) return existing;

  if (!session.metadata) {
    throw new Error("Missing session metadata");
  }

  const metadataUserId = String(session.metadata.userId || "").trim();
  if (!metadataUserId) {
    throw new Error("Session metadata userId is missing");
  }
  if (expectedUserId && metadataUserId !== String(expectedUserId)) {
    const err = new Error("Session does not belong to this user");
    err.statusCode = 403;
    throw err;
  }

  const eventObjectId = parseObjectId(session.metadata.eventId);
  if (!eventObjectId) {
    throw new Error("Invalid event in payment session");
  }

  const event = await findActiveEventById(eventObjectId);
  if (!event) {
    const err = new Error("Event not found");
    err.statusCode = 404;
    throw err;
  }

  const qty = Number(session.metadata.quantity || 1);
  const ticketType = session.metadata.ticketType || "Standard";
  const promoCode = String(session.metadata.promoCode || "").trim().toUpperCase();
  const discountAmount = Number(session.metadata.discountAmount || 0);
  const metadataTotalAmount = Number(session.metadata.totalAmount || 0);
  const ticket = pickTicket(event, ticketType);
  const availabilityError = assertSeatAvailability(event, ticket, qty);
  if (availabilityError) {
    throw new Error(availabilityError);
  }

  applySeatBooking(event, ticket.name, qty);
  await event.save();

  const booking = await Booking.create({
    userId: metadataUserId,
    eventId: event._id,
    ...getBookingSeriesFields(event),
    attendeeName: session.metadata.attendeeName || "",
    attendeeEmail: normalizeEmail(session.metadata.attendeeEmail || ""),
    attendeeWhatsApp: String(session.metadata.attendeeWhatsApp || "").trim(),
    ticketType: ticket.name,
    quantity: qty,
    totalAmount: metadataTotalAmount > 0 ? metadataTotalAmount : getTicketCharge(event, ticket, qty).subtotal,
    promoCode: promoCode || "",
    discountAmount: Number.isFinite(discountAmount) && discountAmount > 0 ? discountAmount : 0,
    paymentMethod: "stripe",
    stripeSessionId: session.id,
    stripePaymentIntentId: String(session.payment_intent || ""),
    paymentStatus: "paid",
    status: "confirmed"
  });

  if (promoCode) {
    await PromoCode.updateOne(
      { eventId: event._id, code: promoCode, active: true },
      { $inc: { usedCount: 1 } }
    );
  }

    Promise.allSettled([
      notifyBookingConfirmed({
        toUserEmail: booking.attendeeEmail,
        eventTitle: event.title || "Event",
        quantity: qty,
        amount: booking.totalAmount,
        bookingId: booking._id,
        attendeeName: booking.attendeeName,
        eventDate: event.date,
        location: event.location,
        ticketType: booking.ticketType
      }),
    notifyBookingConfirmedWhatsApp({
      toWhatsApp: booking.attendeeWhatsApp,
      eventTitle: event.title || "Event",
      quantity: qty,
      amount: booking.totalAmount
    }),
    notifyAdminNewBooking({
      eventTitle: event.title || "Event",
      attendeeEmail: booking.attendeeEmail,
      quantity: qty,
      amount: booking.totalAmount
    }),
    notifyAdminNewBookingWhatsApp({
      eventTitle: event.title || "Event",
      attendeeEmail: booking.attendeeEmail,
      quantity: qty,
      amount: booking.totalAmount
    })
  ]);

  return booking;
}

function validateTicketPayload(payload) {
  const {
    eventId,
    attendeeName,
    attendeeEmail,
    attendeeWhatsApp = "",
    ticketType = "Standard",
    quantity = 1,
    paymentMethod = "card",
    promoCode = ""
  } = payload;

  const eventObjectId = parseObjectId(eventId);
  if (!eventObjectId) {
    return { error: "eventId must be a valid ObjectId" };
  }

  const cleanName = sanitizeText(attendeeName, { min: 2, max: 120 });
  const cleanEmail = normalizeEmail(attendeeEmail);
  if (!cleanName || !cleanEmail) {
    return { error: "attendeeName and attendeeEmail are required" };
  }
  if (!isValidEmail(cleanEmail)) {
    return { error: "attendeeEmail must be a valid email address" };
  }

  const cleanWhatsApp = String(attendeeWhatsApp || "").trim();
  if (cleanWhatsApp && !/^\+\d{7,15}$/.test(cleanWhatsApp)) {
    return { error: "attendeeWhatsApp must be in E.164 format, e.g. +15551234567" };
  }

  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty < 1 || qty > 10) {
    return { error: "quantity must be an integer between 1 and 10" };
  }

  return {
    value: {
      eventObjectId,
      cleanName,
      cleanEmail,
      cleanWhatsApp,
      ticketType,
      qty,
      paymentMethod,
      promoCode: String(promoCode || "").trim().toUpperCase()
    }
  };
}

// Book Event (user-only)
exports.bookEvent = async (req, res) => {
  try {
    const eventObjectId = parseObjectId(req.body.eventId);
    if (!eventObjectId) {
      return res.status(400).json({ error: "eventId must be a valid ObjectId" });
    }

    const event = await findActiveEventById(eventObjectId);
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }

    const ticket = pickTicket(event);
    const availabilityError = assertSeatAvailability(event, ticket, 1);
    if (availabilityError) {
      return res.status(400).json({ error: availabilityError });
    }

    applySeatBooking(event, ticket.name, 1);
    await event.save();

    const pricing = getTicketCharge(event, ticket, 1);
    const booking = await Booking.create({
      userId: req.user.id,
      eventId: event._id,
      ...getBookingSeriesFields(event),
      attendeeName: "",
      attendeeEmail: "",
      ticketType: ticket.name,
      quantity: 1,
      totalAmount: pricing.subtotal,
      paymentMethod: "card",
      paymentStatus: "unpaid",
      status: "pending"
    });

    res.status(201).json(booking);
  } catch (err) {
    bookingServerError(res, "BOOK_EVENT_FAILED", "Failed to create booking");
  }
};

exports.registerTicket = async (req, res) => {
  try {
    const validated = validateTicketPayload(req.body);
    if (validated.error) {
      return res.status(400).json({ error: validated.error });
    }

    const {
      eventObjectId,
      cleanName,
      cleanEmail,
      cleanWhatsApp,
      ticketType,
      qty,
      paymentMethod,
      promoCode
    } = validated.value;

    const event = await findActiveEventById(eventObjectId);
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }

    const ticket = pickTicket(event, ticketType);
    const availabilityError = assertSeatAvailability(event, ticket, qty);
    if (availabilityError) {
      return res.status(400).json({ error: availabilityError });
    }

    applySeatBooking(event, ticket.name, qty);
    await event.save();

    const pricing = getTicketCharge(event, ticket, qty);
    const subtotal = pricing.subtotal;
    const promoResult = await validateAndComputePromo({
      eventId: event._id,
      codeRaw: promoCode,
      subtotal
    });
    if (promoResult.error) {
      return res.status(400).json({ error: promoResult.error });
    }
    const totalAmount = promoResult.finalAmount;

    const booking = await Booking.create({
      userId: req.user.id,
      eventId: event._id,
      ...getBookingSeriesFields(event),
      attendeeName: cleanName,
      attendeeEmail: cleanEmail,
      attendeeWhatsApp: cleanWhatsApp,
      ticketType: ticket.name,
      quantity: qty,
      totalAmount,
      promoCode: promoResult.promoCode || "",
      discountAmount: promoResult.discountAmount || 0,
      paymentMethod,
      paymentStatus: "paid",
      status: "confirmed"
    });

    if (promoResult.promo) {
      await PromoCode.updateOne(
        { _id: promoResult.promo._id },
        { $inc: { usedCount: 1 } }
      );
    }

    Promise.allSettled([
      notifyBookingConfirmed({
        toUserEmail: cleanEmail,
        eventTitle: event.title || "Event",
        quantity: qty,
        amount: totalAmount,
        bookingId: booking._id,
        attendeeName: booking.attendeeName,
        eventDate: event.date,
        location: event.location,
        ticketType: booking.ticketType
      }),
      notifyBookingConfirmedWhatsApp({
        toWhatsApp: cleanWhatsApp,
        eventTitle: event.title || "Event",
        quantity: qty,
        amount: totalAmount
      }),
      notifyAdminNewBooking({
        eventTitle: event.title || "Event",
        attendeeEmail: cleanEmail,
        quantity: qty,
        amount: totalAmount
      }),
      notifyAdminNewBookingWhatsApp({
        eventTitle: event.title || "Event",
        attendeeEmail: cleanEmail,
        quantity: qty,
        amount: totalAmount
      })
    ]);

    res.status(201).json(booking);
  } catch (err) {
    bookingServerError(res, "REGISTER_TICKET_FAILED", "Failed to register ticket");
  }
};

exports.joinWaitlist = async (req, res) => {
  try {
    const validated = validateTicketPayload(req.body);
    if (validated.error) {
      return res.status(400).json({ error: validated.error });
    }
    const { eventObjectId, cleanName, cleanEmail, cleanWhatsApp, ticketType, qty, promoCode } = validated.value;

    const event = await findActiveEventById(eventObjectId);
    if (!event) return res.status(404).json({ error: "Event not found" });
    if (event.waitlistEnabled === false) return res.status(400).json({ error: "Waitlist is disabled for this event" });

    const ticket = pickTicket(event, ticketType);
    const seatsError = assertSeatAvailability(event, ticket, qty);
    if (!seatsError) {
      return res.status(400).json({ error: "Seats are available. Please book directly." });
    }

    const duplicate = await WaitlistEntry.findOne({
      userId: req.user.id,
      eventId: event._id,
      ticketType: ticket?.name || ticketType,
      status: "waiting"
    });
    if (duplicate) {
      return res.status(409).json({ error: "You are already on the waitlist for this ticket type." });
    }

    const entry = await WaitlistEntry.create({
      userId: req.user.id,
      eventId: event._id,
      attendeeName: cleanName,
      attendeeEmail: cleanEmail,
      attendeeWhatsApp: cleanWhatsApp,
      ticketType: ticket?.name || ticketType,
      quantity: qty,
      status: "waiting"
    });
    res.status(201).json(entry);
  } catch (err) {
    bookingServerError(res, "WAITLIST_JOIN_FAILED", "Failed to join waitlist");
  }
};

exports.getMyWaitlist = async (req, res) => {
  try {
    const items = await WaitlistEntry.find({ userId: req.user.id, status: "waiting" })
      .sort({ createdAt: -1 })
      .populate("eventId", "title date location")
      .lean();
    res.json(items);
  } catch (err) {
    bookingServerError(res, "WAITLIST_LIST_FAILED", "Failed to load waitlist");
  }
};

exports.createStripeCheckoutSession = async (req, res) => {
  try {
    if (!stripe) {
      return res.status(400).json({ error: "Stripe is not configured. Set STRIPE_SECRET_KEY in .env" });
    }

    const validated = validateTicketPayload(req.body);
    if (validated.error) {
      return res.status(400).json({ error: validated.error });
    }

    const { eventObjectId, cleanName, cleanEmail, cleanWhatsApp, ticketType, qty, promoCode } = validated.value;
    const event = await findActiveEventById(eventObjectId);
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }

    const ticket = pickTicket(event, ticketType);
    const availabilityError = assertSeatAvailability(event, ticket, qty);
    if (availabilityError) {
      return res.status(400).json({ error: availabilityError });
    }

    const pricing = getTicketCharge(event, ticket, qty);
    const subtotal = pricing.subtotal;
    const promoResult = await validateAndComputePromo({
      eventId: event._id,
      codeRaw: promoCode,
      subtotal
    });
    if (promoResult.error) {
      return res.status(400).json({ error: promoResult.error });
    }

    const totalAmount = promoResult.finalAmount;
    const totalAmountCents = Math.max(50, Math.round(totalAmount * 100));

    const session = await stripeBreaker.execute(() =>
      withRetry(
        () => stripe.checkout.sessions.create({
          mode: "payment",
          payment_method_types: ["card"],
          success_url: `${clientBaseUrl}/book.html?stripe_success=1&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${clientBaseUrl}/book.html?stripe_cancel=1`,
          customer_email: cleanEmail,
          line_items: [
            {
              price_data: {
                currency: "usd",
                unit_amount: totalAmountCents,
                product_data: {
                  name: `${event.title} - ${ticket.name} x${qty}`
                }
              },
              quantity: 1
            }
          ],
          metadata: {
            userId: String(req.user.id),
            eventId: String(event._id),
            ticketType: ticket.name,
            quantity: String(qty),
            attendeeName: cleanName,
            attendeeEmail: cleanEmail,
            attendeeWhatsApp: cleanWhatsApp,
            promoCode: promoResult.promoCode || "",
            discountAmount: String(promoResult.discountAmount || 0),
            totalAmount: String(totalAmount),
            dynamicUnitPrice: String(pricing.dynamicPrice),
            pricingTier: pricing.pricingTier
          }
        }),
        { retries: 2, baseDelayMs: 250 }
      )
    );

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    bookingServerError(res, "STRIPE_SESSION_CREATE_FAILED", "Could not start Stripe checkout");
  }
};

exports.confirmStripeSession = async (req, res) => {
  try {
    if (!stripe) {
      return res.status(400).json({ error: "Stripe is not configured. Set STRIPE_SECRET_KEY in .env" });
    }

    const sessionId = String(req.body.sessionId || "").trim();
    if (!sessionId) {
      return res.status(400).json({ error: "sessionId is required" });
    }

    const session = await stripeBreaker.execute(() =>
      withRetry(() => stripe.checkout.sessions.retrieve(sessionId), { retries: 2, baseDelayMs: 250 })
    );
    const booking = await finalizePaidStripeSession(session, req.user.id);
    res.json(booking);
  } catch (err) {
    const status = Number(err.statusCode || 500);
    if (status >= 500) return bookingServerError(res, "STRIPE_SESSION_CONFIRM_FAILED", "Could not confirm payment session");
    return res.status(status).json({ error: err.message });
  }
};

exports.stripeWebhook = async (req, res) => {
  try {
    if (!stripe) {
      return res.status(400).json({ error: "Stripe is not configured. Set STRIPE_SECRET_KEY in .env" });
    }
    if (!process.env.STRIPE_WEBHOOK_SECRET) {
      return res.status(400).json({ error: "STRIPE_WEBHOOK_SECRET is not configured" });
    }

    const signature = req.headers["stripe-signature"];
    if (!signature) {
      return res.status(400).json({ error: "Missing stripe-signature header" });
    }

    let stripeEvent;
    try {
      stripeEvent = stripe.webhooks.constructEvent(
        req.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      return res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` });
    }

    try {
      await StripeWebhookEvent.create({
        eventId: stripeEvent.id,
        type: stripeEvent.type,
        processed: false
      });
    } catch (err) {
      // Duplicate event delivery: acknowledge to stop retries.
      if (err && err.code === 11000) {
        return res.json({ received: true, duplicate: true });
      }
      throw err;
    }

    const handledSubscriptionEvent = await handleStripeSubscriptionWebhook(stripeEvent);
    if (handledSubscriptionEvent) {
      // handled by billing controller
    } else if (stripeEvent.type === "checkout.session.completed") {
      const session = stripeEvent.data.object;
      await finalizePaidStripeSession(session);
    } else if (stripeEvent.type === "payment_intent.payment_failed") {
      const paymentIntentId = String(stripeEvent.data?.object?.id || "").trim();
      if (paymentIntentId) {
        const booking = await Booking.findOne({ stripePaymentIntentId: paymentIntentId });
        if (booking) {
          booking.paymentStatus = "failed";
          if (booking.status === "pending") booking.status = "cancelled";
          await booking.save();
        }
      }
    } else if (stripeEvent.type === "charge.refunded") {
      const paymentIntentId = String(stripeEvent.data?.object?.payment_intent || "").trim();
      if (paymentIntentId) {
        const booking = await Booking.findOne({ stripePaymentIntentId: paymentIntentId });
        if (booking) {
          await releaseSeatsForRefundIfNeeded(booking);
          booking.paymentStatus = "refunded";
          booking.status = "refunded";
          await booking.save();
        }
      }
    }

    await StripeWebhookEvent.updateOne(
      { eventId: stripeEvent.id },
      { $set: { processed: true, error: "" } }
    );

    res.json({ received: true });
  } catch (err) {
    try {
      const signature = req.headers["stripe-signature"];
      if (signature && process.env.STRIPE_WEBHOOK_SECRET) {
        const stripeEvent = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
        await StripeWebhookEvent.updateOne(
          { eventId: stripeEvent.id },
          { $set: { processed: false, error: String(err.message || "unknown error") } },
          { upsert: true }
        );
      }
    } catch (_) {
      // Ignore secondary logging failures.
    }
    bookingServerError(res, "STRIPE_WEBHOOK_FAILED", "Stripe webhook processing failed");
  }
};

// Get current user's bookings
exports.getBookings = async (req, res) => {
  try {
    const bookings = await Booking.find({ userId: req.user.id })
      .sort({ date: -1 })
      .populate("eventId", "title date location cancelWindowHoursBefore transferWindowHoursBefore");
    const reputationMap = await buildReputationMap([req.user.id]);
    const attendeeReputation = reputationMap.get(String(req.user.id)) || calculateAttendeeReputation([]);
    res.json(bookings.map((booking) => ({
      ...booking.toObject(),
      attendeeReputation
    })));
  } catch (err) {
    bookingServerError(res, "BOOKINGS_LIST_FAILED", "Failed to load bookings");
  }
};

exports.getBookingById = async (req, res) => {
  try {
    const booking = await Booking.findOne({ _id: req.params.id, userId: req.user.id })
      .populate("eventId", "title date location category organizer cancelWindowHoursBefore transferWindowHoursBefore");
    if (!booking) {
      return res.status(404).json({ error: "Booking not found" });
    }
    const reputationMap = await buildReputationMap([req.user.id]);
    res.json({
      ...booking.toObject(),
      attendeeReputation: reputationMap.get(String(req.user.id)) || calculateAttendeeReputation([])
    });
  } catch (err) {
    bookingServerError(res, "BOOKING_GET_FAILED", "Failed to load booking");
  }
};

exports.cancelMyBooking = async (req, res) => {
  try {
    const booking = await Booking.findOne({ _id: req.params.id, userId: req.user.id });
    if (!booking) {
      return res.status(404).json({ error: "Booking not found" });
    }

    if (!canTransition(booking.status, "cancelled")) {
      return res.status(400).json({ error: `Cannot cancel booking from status '${booking.status}'` });
    }

    const event = await Event.findById(booking.eventId);
    if (event && !isWindowOpen(event.date, event.cancelWindowHoursBefore)) {
      return res.status(400).json({
        error: `Cancellation window closed. Allowed until ${Number(event.cancelWindowHoursBefore || 0)} hour(s) before event start.`
      });
    }
    let promotedBooking = null;
    if (event) {
      releaseSeatBooking(event, booking.ticketType, booking.quantity);
      await event.save();
      promotedBooking = await tryPromoteWaitlist(event);
    }

    booking.status = "cancelled";
    if (booking.paymentStatus === "paid") booking.paymentStatus = "refunded";
    await booking.save();

    if (booking.attendeeEmail) {
      Promise.allSettled([
        notifyBookingCancelled({
          toUserEmail: booking.attendeeEmail,
          eventTitle: event?.title || "Event"
        }),
        notifyBookingCancelledWhatsApp({
          toWhatsApp: booking.attendeeWhatsApp,
          eventTitle: event?.title || "Event"
        })
      ]);
    }

    res.json({
      booking,
      promotedWaitlistBookingId: promotedBooking?._id || null
    });
  } catch (err) {
    bookingServerError(res, "BOOKING_CANCEL_FAILED", "Failed to cancel booking");
  }
};

exports.transferMyBooking = async (req, res) => {
  try {
    const booking = await Booking.findOne({ _id: req.params.id, userId: req.user.id });
    if (!booking) {
      return res.status(404).json({ error: "Booking not found" });
    }
    if (!["pending", "confirmed"].includes(booking.status)) {
      return res.status(400).json({ error: `Cannot transfer booking from status '${booking.status}'` });
    }

    const event = await Event.findById(booking.eventId);
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }
    if (!isWindowOpen(event.date, event.transferWindowHoursBefore)) {
      return res.status(400).json({
        error: `Transfer window closed. Allowed until ${Number(event.transferWindowHoursBefore || 0)} hour(s) before event start.`
      });
    }

    const cleanName = sanitizeText(req.body?.attendeeName, { min: 2, max: 120 });
    const cleanEmail = normalizeEmail(req.body?.attendeeEmail);
    const cleanWhatsApp = String(req.body?.attendeeWhatsApp || "").trim();

    if (!cleanName || !cleanEmail) {
      return res.status(400).json({ error: "attendeeName and attendeeEmail are required" });
    }
    if (!isValidEmail(cleanEmail)) {
      return res.status(400).json({ error: "attendeeEmail must be a valid email address" });
    }
    if (cleanWhatsApp && !/^\+\d{7,15}$/.test(cleanWhatsApp)) {
      return res.status(400).json({ error: "attendeeWhatsApp must be in E.164 format, e.g. +15551234567" });
    }

    booking.attendeeName = cleanName;
    booking.attendeeEmail = cleanEmail;
    booking.attendeeWhatsApp = cleanWhatsApp;
    await booking.save();

    res.json(booking);
  } catch (err) {
    bookingServerError(res, "BOOKING_TRANSFER_FAILED", "Failed to transfer booking");
  }
};

exports.updateBookingStatus = async (req, res) => {
  try {
    const nextStatus = String(req.body.status || "").trim();
    const validStatuses = ["pending", "confirmed", "cancelled", "checked_in", "refunded"];
    if (!validStatuses.includes(nextStatus)) {
      return res.status(400).json({ error: "Invalid booking status" });
    }

    const booking = await Booking.findById(req.params.id);
    if (!booking) {
      return res.status(404).json({ error: "Booking not found" });
    }

    if (!canTransition(booking.status, nextStatus)) {
      return res.status(400).json({ error: `Cannot move booking from '${booking.status}' to '${nextStatus}'` });
    }

    const shouldReleaseSeats =
      ["pending", "confirmed", "checked_in"].includes(booking.status) &&
      ["cancelled", "refunded"].includes(nextStatus);
    let promotedBooking = null;

    if (shouldReleaseSeats) {
      const event = await Event.findById(booking.eventId);
      if (event) {
        releaseSeatBooking(event, booking.ticketType, booking.quantity);
        await event.save();
        promotedBooking = await tryPromoteWaitlist(event, req);
      }
    }

    const previousStatus = booking.status;
    booking.status = nextStatus;
    if (nextStatus === "refunded") booking.paymentStatus = "refunded";
    await booking.save();
    await logAdminAction(req, {
      action: "booking_status_change",
      targetType: "booking",
      targetId: booking._id,
      details: {
        eventId: booking.eventId,
        previousStatus,
        nextStatus,
        paymentStatus: booking.paymentStatus
      }
    });

    if (nextStatus === "cancelled" || nextStatus === "refunded") {
      const event = await Event.findById(booking.eventId);
      Promise.allSettled([
        notifyBookingCancelled({
          toUserEmail: booking.attendeeEmail,
          eventTitle: event?.title || "Event"
        }),
        notifyBookingCancelledWhatsApp({
          toWhatsApp: booking.attendeeWhatsApp,
          eventTitle: event?.title || "Event"
        })
      ]);
    }

    res.json({
      booking,
      promotedWaitlistBookingId: promotedBooking?._id || null
    });
  } catch (err) {
    bookingServerError(res, "BOOKING_STATUS_UPDATE_FAILED", "Failed to update booking status");
  }
};
