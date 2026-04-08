const Event = require("../models/Event");
const Booking = require("../models/Booking");
const User = require("../models/User");
const EventComment = require("../models/EventComment");
const AuditLog = require("../models/AuditLog");
const StripeWebhookEvent = require("../models/StripeWebhookEvent");
const NotificationJob = require("../models/NotificationJob");
const PromoCode = require("../models/PromoCode");
const { notifyTestEmail, notifyOrganizerWeeklyDigest } = require("../utils/notifications");
const { processEventRemindersOnce } = require("../utils/reminderWorker");
const { getRuntimeMonitoringStats } = require("../utils/runtimeMetrics");
const { predictAttendance } = require("../utils/ml/attendancePrediction");
const { detectChurn } = require("../utils/ml/churnDetection");
const twilio = require("twilio");
const { withRetry, createCircuitBreaker } = require("../utils/resilience");
const { logAdminAction } = require("../utils/audit");
const { calculateAttendeeReputation } = require("../utils/reputation");
const { decorateEventLifecycle } = require("../utils/eventLifecycle");

const hasTwilioCreds =
  process.env.TWILIO_ACCOUNT_SID &&
  process.env.TWILIO_AUTH_TOKEN &&
  process.env.TWILIO_WHATSAPP_FROM;

const twilioClient = hasTwilioCreds
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;
const twilioBreaker = createCircuitBreaker("admin_twilio", { failureThreshold: 4, cooldownMs: 20000 });

function adminServerError(res, code, message = "Admin request failed") {
  return res.status(500).json({ error: message, code });
}

function parsePagination(query, { defaultPage = 1, defaultPageSize = 25, maxPageSize = 200 } = {}) {
  const rawPage = Number(query.page);
  const rawPageSize = Number(query.pageSize);
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : defaultPage;
  const pageSize = Number.isInteger(rawPageSize) && rawPageSize > 0
    ? Math.min(rawPageSize, maxPageSize)
    : defaultPageSize;
  const skip = (page - 1) * pageSize;
  return { page, pageSize, skip };
}

function buildPageMeta({ page, pageSize, total }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return {
    page,
    pageSize,
    total,
    totalPages,
    hasPrev: page > 1,
    hasNext: page < totalPages
  };
}

async function buildUserReputationMap(userIds) {
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

function formatWeekDelta(current, previous) {
  const diff = Number(current || 0) - Number(previous || 0);
  if (diff === 0) return "same as previous week";
  return diff > 0 ? `+${diff} vs previous week` : `${diff} vs previous week`;
}

async function buildOrganizerDigestSummary(organizerUserId) {
  const now = new Date();
  const weekStart = new Date(now.getTime() - (7 * 24 * 60 * 60 * 1000));
  const prevWeekStart = new Date(now.getTime() - (14 * 24 * 60 * 60 * 1000));

  const ownedEvents = await Event.find({
    createdBy: organizerUserId,
    isDeleted: { $ne: true }
  })
    .select("_id title date location category organizer status capacity seatsBooked")
    .sort({ date: 1 })
    .lean();

  const eventIds = ownedEvents.map((row) => row._id);
  if (!eventIds.length) {
    return {
      activeEvents: 0,
      upcomingEvents: 0,
      bookingsLast7: 0,
      bookingsPrev7: 0,
      bookingsTrendLabel: "same as previous week",
      revenueLast7: 0,
      confirmedLast7: 0,
      cancelledLast7: 0,
      topEvents: [],
      upcomingPredictions: [],
      atRiskUsers: []
    };
  }

  const [ownedBookingsRaw, upcomingBookingsRaw] = await Promise.all([
    Booking.find({ eventId: { $in: eventIds } })
      .populate("eventId", "title date location category organizer capacity seatsBooked status")
      .populate("userId", "name email")
      .lean(),
    Booking.find({
      eventId: {
        $in: ownedEvents
          .filter((event) => new Date(event.date).getTime() >= now.getTime())
          .map((event) => event._id)
      }
    })
      .populate("eventId", "title date location category organizer capacity seatsBooked status")
      .populate("userId", "name email")
      .lean()
  ]);

  const ownedBookings = ownedBookingsRaw.map((row) => ({
    ...row,
    createdAt: row.createdAt || row.date || null
  }));
  const upcomingBookings = upcomingBookingsRaw.map((row) => ({
    ...row,
    createdAt: row.createdAt || row.date || null
  }));

  const relatedUserIds = [...new Set(
    ownedBookings
      .map((row) => String(row.userId?._id || row.userId || ""))
      .filter(Boolean)
  )];

  const allUserBookingsRaw = relatedUserIds.length
    ? await Booking.find({ userId: { $in: relatedUserIds } })
      .populate("userId", "name email")
      .populate("eventId", "title date location category organizer capacity seatsBooked status")
      .lean()
    : [];
  const allUserBookings = allUserBookingsRaw.map((row) => ({
    ...row,
    createdAt: row.createdAt || row.date || null
  }));

  const bookingsLast7 = ownedBookings.filter((row) => {
    const at = new Date(row.date || row.createdAt || 0);
    return at >= weekStart && at <= now;
  });
  const bookingsPrev7 = ownedBookings.filter((row) => {
    const at = new Date(row.date || row.createdAt || 0);
    return at >= prevWeekStart && at < weekStart;
  });

  const topEventMap = new Map();
  bookingsLast7.forEach((row) => {
    const eventId = String(row.eventId?._id || row.eventId || "");
    const title = row.eventId?.title || "Unknown Event";
    if (!topEventMap.has(eventId)) {
      topEventMap.set(eventId, { eventId, title, bookings: 0, revenue: 0 });
    }
    const target = topEventMap.get(eventId);
    target.bookings += Number(row.quantity || 1);
    target.revenue += Number(row.totalAmount || 0);
  });

  const upcomingEvents = ownedEvents
    .filter((event) => new Date(event.date).getTime() >= now.getTime() && event.status !== "cancelled")
    .slice(0, 5);

  const upcomingPredictions = upcomingEvents.map((event) => predictAttendance(event, upcomingBookings));

  const atRiskUsers = upcomingEvents
    .flatMap((event) => {
      const eventBookings = upcomingBookings.filter(
        (row) => String(row.eventId?._id || row.eventId || "") === String(event._id)
      );
      return detectChurn(event, eventBookings, allUserBookings)
        .filter((row) => row.churnRisk === "high" || row.churnRisk === "medium")
        .slice(0, 5)
        .map((row) => ({
          ...row,
          eventId: String(event._id),
          eventTitle: event.title
        }));
    })
    .sort((a, b) => Number(b.churnScore || 0) - Number(a.churnScore || 0))
    .slice(0, 8);

  return {
    activeEvents: ownedEvents.length,
    upcomingEvents: upcomingEvents.length,
    bookingsLast7: bookingsLast7.length,
    bookingsPrev7: bookingsPrev7.length,
    bookingsTrendLabel: formatWeekDelta(bookingsLast7.length, bookingsPrev7.length),
    revenueLast7: bookingsLast7.reduce((sum, row) => sum + Number(row.totalAmount || 0), 0),
    confirmedLast7: bookingsLast7.filter((row) => row.status === "confirmed").length,
    cancelledLast7: bookingsLast7.filter((row) => row.status === "cancelled").length,
    topEvents: [...topEventMap.values()].sort((a, b) => b.bookings - a.bookings).slice(0, 5),
    upcomingPredictions,
    atRiskUsers
  };
}

async function resolveOrganizerBookingLookup(rawInput, organizerUserId) {
  const input = String(rawInput || "").trim();
  if (!input) return null;

  const ownedEventIds = await Event.find({ createdBy: organizerUserId }).distinct("_id");
  if (!ownedEventIds.length) return null;

  if (/^[a-f\d]{24}$/i.test(input)) {
    return Booking.findOne({ _id: input, eventId: { $in: ownedEventIds } })
      .populate("eventId", "title createdBy");
  }

  const suffixMatch = /^BK-([A-Z0-9]{8})$/i.exec(input);
  const suffix = String(suffixMatch ? suffixMatch[1] : input).toLowerCase();
  if (!/^[a-z0-9]{4,24}$/i.test(suffix)) return null;

  const bookingIds = await Booking.find({ eventId: { $in: ownedEventIds } })
    .sort({ date: -1 })
    .select("_id")
    .lean();

  const matched = bookingIds.find((row) => String(row._id || "").slice(-suffix.length).toLowerCase() === suffix);
  if (!matched?._id) return null;

  return Booking.findById(matched._id).populate("eventId", "title createdBy");
}

// Get all events
exports.getAllEvents = async (req, res) => {
  try {
    const { page, pageSize, skip } = parsePagination(req.query, { defaultPageSize: 12, maxPageSize: 100 });
    const includeDeleted = String(req.query.includeDeleted || "").toLowerCase() === "true";
    const bucket = String(req.query.bucket || "").trim().toLowerCase();
    const now = new Date();
    let query = includeDeleted
      ? { createdBy: req.user.id }
      : { createdBy: req.user.id, isDeleted: { $ne: true } };

    if (bucket === "active") {
      query = {
        createdBy: req.user.id,
        isDeleted: { $ne: true },
        date: { $gte: now }
      };
    } else if (bucket === "inactive") {
      query = {
        createdBy: req.user.id,
        $or: [
          { isDeleted: true },
          { isDeleted: { $ne: true }, date: { $lt: now } }
        ]
      };
    } else if (bucket === "past") {
      query = {
        createdBy: req.user.id,
        isDeleted: { $ne: true },
        date: { $lt: now }
      };
    } else if (bucket === "archived") {
      query = {
        createdBy: req.user.id,
        isDeleted: true
      };
    }

    const total = await Event.countDocuments(query);
    const events = await Event.find(query)
      .sort({ date: -1, createdAt: -1 })
      .skip(skip)
      .limit(pageSize)
      .lean();
    res.json({
      items: events.map((event) => decorateEventLifecycle(event, now)),
      pagination: buildPageMeta({ page, pageSize, total })
    });
  } catch (err) {
    adminServerError(res, "ADMIN_EVENTS_LIST_FAILED", "Failed to load admin events");
  }
};

// Soft-delete event
exports.deleteEvent = async (req, res) => {
  try {
    const event = await Event.findOne({
      _id: req.params.id,
      createdBy: req.user.id,
      isDeleted: { $ne: true }
    });
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }
    event.isDeleted = true;
    event.deletedAt = new Date();
    event.deletedBy = req.user?.id || null;
    event.status = "cancelled";
    await event.save();
    await logAdminAction(req, {
      action: "event_archive",
      targetType: "event",
      targetId: event._id,
      details: { title: event.title }
    });
    res.json({ msg: "Event archived (soft-deleted)" });
  } catch (err) {
    adminServerError(res, "ADMIN_EVENT_ARCHIVE_FAILED", "Failed to archive event");
  }
};

// Restore soft-deleted event
exports.restoreEvent = async (req, res) => {
  try {
    const event = await Event.findOne({
      _id: req.params.id,
      createdBy: req.user.id,
      isDeleted: true
    });
    if (!event) {
      return res.status(404).json({ error: "Archived event not found" });
    }
    event.isDeleted = false;
    event.deletedAt = null;
    event.deletedBy = null;
    if (event.status === "cancelled") event.status = "draft";
    await event.save();
    await logAdminAction(req, {
      action: "event_restore",
      targetType: "event",
      targetId: event._id,
      details: { title: event.title, status: event.status }
    });
    res.json({ msg: "Event restored", event });
  } catch (err) {
    adminServerError(res, "ADMIN_EVENT_RESTORE_FAILED", "Failed to restore event");
  }
};

// Permanent delete archived event
exports.permanentDeleteEvent = async (req, res) => {
  try {
    const event = await Event.findOne({
      _id: req.params.id,
      createdBy: req.user.id,
      isDeleted: true
    });
    if (!event) {
      return res.status(404).json({ error: "Archived event not found" });
    }

    await Event.deleteOne({ _id: event._id });
    await logAdminAction(req, {
      action: "event_permanent_delete",
      targetType: "event",
      targetId: event._id,
      details: { title: event.title }
    });

    res.json({ msg: "Event permanently deleted" });
  } catch (err) {
    adminServerError(res, "ADMIN_EVENT_PERMANENT_DELETE_FAILED", "Failed to permanently delete event");
  }
};

// Get all bookings (admin)
exports.getAllBookings = async (req, res) => {
  try {
    const { page, pageSize, skip } = parsePagination(req.query, { defaultPageSize: 50, maxPageSize: 500 });
    const status = String(req.query.status || "").trim();
    const eventId = String(req.query.eventId || "").trim();
    const dateFrom = String(req.query.dateFrom || "").trim();
    const dateTo = String(req.query.dateTo || "").trim();

    const myEvents = await Event.find({ createdBy: req.user.id }).select("_id").lean();
    const eventIds = myEvents.map((e) => e._id);
    if (!eventIds.length) {
      return res.json({ items: [], pagination: buildPageMeta({ page, pageSize, total: 0 }) });
    }

    const query = { eventId: { $in: eventIds } };
    if (status) query.status = status;
    if (eventId) query.eventId = eventId;
    if (dateFrom || dateTo) {
      query.date = {};

      if (dateFrom) {
        const from = new Date(`${dateFrom}T00:00:00.000Z`);
        if (Number.isNaN(from.getTime())) {
          return res.status(400).json({ error: "dateFrom must be a valid date" });
        }
        query.date.$gte = from;
      }

      if (dateTo) {
        const to = new Date(`${dateTo}T23:59:59.999Z`);
        if (Number.isNaN(to.getTime())) {
          return res.status(400).json({ error: "dateTo must be a valid date" });
        }
        query.date.$lte = to;
      }
    }

    const total = await Booking.countDocuments(query);
    const bookings = await Booking.find(query)
      .sort({ date: -1 })
      .skip(skip)
      .limit(pageSize)
      .populate("userId", "name email role")
      .populate("eventId", "title date location category");
    const reputationMap = await buildUserReputationMap(bookings.map((row) => row.userId?._id || row.userId));
    const items = bookings.map((booking) => ({
      ...booking.toObject(),
      attendeeReputation: reputationMap.get(String(booking.userId?._id || booking.userId || "")) || calculateAttendeeReputation([])
    }));
    res.json({ items, pagination: buildPageMeta({ page, pageSize, total }) });
  } catch (err) {
    adminServerError(res, "ADMIN_BOOKINGS_LIST_FAILED", "Failed to load bookings");
  }
};

// Event-wise booking/registration summary (admin)
exports.getEventBookingSummary = async (req, res) => {
  try {
    const [events, bookingAgg] = await Promise.all([
      Event.find({ isDeleted: { $ne: true }, createdBy: req.user.id }).select("title date location category").lean(),
      Booking.aggregate([
        {
          $group: {
            _id: "$eventId",
            totalRegistrations: { $sum: 1 },
            totalTickets: { $sum: { $ifNull: ["$quantity", 1] } },
            uniqueUsers: { $addToSet: "$userId" },
            confirmedCount: {
              $sum: {
                $cond: [{ $eq: ["$status", "confirmed"] }, 1, 0]
              }
            },
            cancelledCount: {
              $sum: {
                $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0]
              }
            }
          }
        },
        {
          $project: {
            _id: 1,
            totalRegistrations: 1,
            totalTickets: 1,
            confirmedCount: 1,
            cancelledCount: 1,
            uniqueUserCount: { $size: "$uniqueUsers" }
          }
        }
      ])
    ]);

    const statsByEventId = new Map(
      bookingAgg.map((item) => [String(item._id), item])
    );

    const summary = events.map((event) => {
      const stats = statsByEventId.get(String(event._id));
      return {
        eventId: event._id,
        title: event.title,
        date: event.date,
        location: event.location,
        category: event.category,
        totalRegistrations: stats ? stats.totalRegistrations : 0,
        totalTickets: stats ? stats.totalTickets : 0,
        uniqueUsers: stats ? stats.uniqueUserCount : 0,
        confirmedCount: stats ? stats.confirmedCount : 0,
        cancelledCount: stats ? stats.cancelledCount : 0
      };
    });

    summary.sort((a, b) => b.totalRegistrations - a.totalRegistrations);
    res.json(summary);
  } catch (err) {
    adminServerError(res, "ADMIN_SUMMARY_FAILED", "Failed to load event summary");
  }
};

exports.sendTestEmail = async (req, res) => {
  try {
    const to = req.body && req.body.to ? String(req.body.to).trim() : "";
    await notifyTestEmail(to);
    res.json({ message: `Test email triggered${to ? ` to ${to}` : ""}. Check server logs for send status.` });
  } catch (err) {
    adminServerError(res, "ADMIN_TEST_EMAIL_FAILED", "Failed to trigger test email");
  }
};

exports.sendTestWhatsApp = async (req, res) => {
  try {
    if (!twilioClient) {
      return res.status(400).json({ error: "Twilio is not configured in .env" });
    }

    const to = req.body && req.body.to ? String(req.body.to).trim() : "";
    if (!to || !/^\+\d{7,15}$/.test(to)) {
      return res.status(400).json({ error: "to is required in E.164 format, e.g. +15551234567" });
    }

    const msg = await twilioBreaker.execute(() =>
      withRetry(
        () => twilioClient.messages.create({
          body: "Test WhatsApp message from Evenix.",
          from: process.env.TWILIO_WHATSAPP_FROM,
          to: `whatsapp:${to}`,
          ...(process.env.TWILIO_STATUS_CALLBACK_URL
            ? { statusCallback: process.env.TWILIO_STATUS_CALLBACK_URL }
            : process.env.CLIENT_BASE_URL
              ? { statusCallback: `${process.env.CLIENT_BASE_URL.replace(/\/+$/, "")}/api/notifications/whatsapp-status` }
              : {})
        }),
        { retries: 2, baseDelayMs: 250 }
      )
    );

    res.json({ message: "Test WhatsApp triggered.", sid: msg.sid });
  } catch (err) {
    adminServerError(res, "ADMIN_TEST_WHATSAPP_FAILED", "Failed to trigger test WhatsApp");
  }
};

exports.runReminderCycle = async (req, res) => {
  try {
    await processEventRemindersOnce();
    res.json({ message: "Reminder cycle executed. Check server logs for sent count." });
  } catch (err) {
    adminServerError(res, "ADMIN_REMINDER_RUN_FAILED", "Failed to execute reminder cycle");
  }
};

exports.sendWeeklyOrganizerDigest = async (req, res) => {
  try {
    const organizer = await User.findById(req.user.id).select("name email").lean();
    if (!organizer?.email) {
      return res.status(400).json({ error: "Organizer email not found" });
    }

    const summary = await buildOrganizerDigestSummary(req.user.id);
    await notifyOrganizerWeeklyDigest({
      toUserEmail: organizer.email,
      organizerName: organizer.name || "Organizer",
      summary,
      dashboardUrl: process.env.CLIENT_BASE_URL
        ? `${process.env.CLIENT_BASE_URL.replace(/\/+$/, "")}/admin.html`
        : ""
    });

    res.json({
      message: `Weekly digest sent to ${organizer.email}.`,
      summary
    });
  } catch (err) {
    adminServerError(res, "ADMIN_WEEKLY_DIGEST_FAILED", "Failed to send weekly organizer digest");
  }
};

exports.getMonitoringStats = async (req, res) => {
  try {
    const windowMinutesRaw = Number(req.query.windowMinutes || 15);
    const windowMinutes = Number.isInteger(windowMinutesRaw) && windowMinutesRaw > 0
      ? Math.min(windowMinutesRaw, 180)
      : 15;
    const runtime = getRuntimeMonitoringStats({ windowMs: windowMinutes * 60 * 1000 });
    const deadLetterCount = await NotificationJob.countDocuments({ status: "dead_letter" });

    res.json({
      runtime,
      notifications: {
        deadLetterCount
      },
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    adminServerError(res, "ADMIN_MONITORING_FAILED", "Failed to load monitoring stats");
  }
};

exports.getAuditLogs = async (req, res) => {
  try {
    const { page, pageSize, skip } = parsePagination(req.query, { defaultPageSize: 50, maxPageSize: 200 });
    const query = { actorUserId: req.user.id };
    const action = String(req.query.action || "").trim();
    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();

    if (action) query.action = action;
    if (from || to) {
      query.createdAt = {};
      if (from) query.createdAt.$gte = new Date(from);
      if (to) query.createdAt.$lte = new Date(to);
    }

    const total = await AuditLog.countDocuments(query);
    const logs = await AuditLog.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(pageSize)
      .lean();
    res.json({ items: logs, pagination: buildPageMeta({ page, pageSize, total }) });
  } catch (err) {
    adminServerError(res, "ADMIN_AUDIT_LOGS_FAILED", "Failed to load audit logs");
  }
};

exports.getWebhookEvents = async (req, res) => {
  try {
    const limitRaw = Number(req.query.limit || 30);
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 30;
    const items = await StripeWebhookEvent.find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    res.json(items);
  } catch (err) {
    adminServerError(res, "ADMIN_WEBHOOK_EVENTS_FAILED", "Failed to load webhook events");
  }
};

exports.getNotificationJobs = async (req, res) => {
  try {
    const { page, pageSize, skip } = parsePagination(req.query, { defaultPageSize: 50, maxPageSize: 200 });
    const status = String(req.query.status || "").trim().toLowerCase();
    const channel = String(req.query.channel || "").trim().toLowerCase();

    const query = {};
    if (["pending", "processing", "sent", "failed", "dead_letter"].includes(status)) query.status = status;
    if (["email", "whatsapp", "push"].includes(channel)) query.channel = channel;

    const total = await NotificationJob.countDocuments(query);
    const items = await NotificationJob.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(pageSize)
      .lean();

    res.json({ items, pagination: buildPageMeta({ page, pageSize, total }) });
  } catch (err) {
    adminServerError(res, "ADMIN_NOTIFICATION_JOBS_FAILED", "Failed to load notification jobs");
  }
};

exports.getPushSubscribers = async (req, res) => {
  try {
    const users = await User.find({
      pushSubscriptions: { $exists: true, $ne: [] }
    })
      .select("name email pushSubscriptions role")
      .sort({ updatedAt: -1 })
      .lean();

    const items = users.map((user) => {
      const subs = Array.isArray(user.pushSubscriptions) ? user.pushSubscriptions : [];
      const latest = subs
        .map((row) => row.updatedAt || row.createdAt || null)
        .filter(Boolean)
        .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] || null;

      return {
        userId: user._id,
        name: user.name || "User",
        email: user.email || "",
        role: user.role || "user",
        subscriptionCount: subs.length,
        latestSubscriptionAt: latest,
        subscriptions: subs.map((row) => ({
          endpoint: row.endpoint || "",
          userAgent: row.userAgent || "",
          updatedAt: row.updatedAt || row.createdAt || null
        }))
      };
    });

    res.json({
      totalUsers: items.length,
      totalSubscriptions: items.reduce((sum, row) => sum + Number(row.subscriptionCount || 0), 0),
      items
    });
  } catch {
    adminServerError(res, "ADMIN_PUSH_SUBSCRIBERS_FAILED", "Failed to load push subscribers");
  }
};

exports.getComments = async (req, res) => {
  try {
    const { page, pageSize, skip } = parsePagination(req.query, { defaultPageSize: 50, maxPageSize: 200 });
    const status = String(req.query.status || "all").trim().toLowerCase();
    const eventId = String(req.query.eventId || "").trim();
    const q = String(req.query.q || "").trim().toLowerCase();

    const myEvents = await Event.find({ createdBy: req.user.id }).select("_id").lean();
    const myEventIds = myEvents.map((e) => e._id);
    if (!myEventIds.length) {
      return res.json({ items: [], pagination: buildPageMeta({ page, pageSize, total: 0 }) });
    }

    const query = { eventId: { $in: myEventIds } };
    if (eventId) query.eventId = eventId;
    if (status === "hidden") query.isHidden = true;
    if (status === "visible") query.isHidden = { $ne: true };
    if (status === "reported") query["reports.0"] = { $exists: true };

    const total = await EventComment.countDocuments(query);
    let comments = await EventComment.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(pageSize)
      .populate("eventId", "title")
      .lean();

    if (q) {
      comments = comments.filter((c) =>
        String(c.text || "").toLowerCase().includes(q) ||
        String(c.userName || "").toLowerCase().includes(q) ||
        String(c.eventId?.title || "").toLowerCase().includes(q)
      );
    }

    const items = comments.map((c) => ({
      _id: c._id,
      eventId: c.eventId?._id || c.eventId,
      eventTitle: c.eventId?.title || "Unknown Event",
      parentId: c.parentId || null,
      userName: c.userName,
      text: c.text,
      isHidden: Boolean(c.isHidden),
      hiddenReason: c.hiddenReason || "",
      helpfulCount: Array.isArray(c.helpfulVotes) ? c.helpfulVotes.length : 0,
      reportCount: Array.isArray(c.reports) ? c.reports.length : 0,
      createdAt: c.createdAt
    }));
    res.json({ items, pagination: buildPageMeta({ page, pageSize, total }) });
  } catch (err) {
    adminServerError(res, "ADMIN_COMMENTS_LIST_FAILED", "Failed to load comments");
  }
};

exports.hideComment = async (req, res) => {
  try {
    const reason = String(req.body?.reason || "").trim().slice(0, 200);
    const comment = await EventComment.findById(req.params.id);
    if (!comment) return res.status(404).json({ error: "Comment not found" });

    const event = await Event.findOne({ _id: comment.eventId, createdBy: req.user.id }).select("_id");
    if (!event) return res.status(403).json({ error: "Not allowed to moderate this comment" });

    comment.isHidden = true;
    comment.hiddenAt = new Date();
    comment.hiddenBy = req.user.id;
    comment.hiddenReason = reason;
    await comment.save();

    await logAdminAction(req, {
      action: "comment_hide",
      targetType: "comment",
      targetId: comment._id,
      details: { eventId: String(comment.eventId), reason }
    });

    res.json({ message: "Comment hidden." });
  } catch (err) {
    adminServerError(res, "ADMIN_COMMENT_HIDE_FAILED", "Failed to hide comment");
  }
};

exports.unhideComment = async (req, res) => {
  try {
    const comment = await EventComment.findById(req.params.id);
    if (!comment) return res.status(404).json({ error: "Comment not found" });

    const event = await Event.findOne({ _id: comment.eventId, createdBy: req.user.id }).select("_id");
    if (!event) return res.status(403).json({ error: "Not allowed to moderate this comment" });

    comment.isHidden = false;
    comment.hiddenAt = null;
    comment.hiddenBy = null;
    comment.hiddenReason = "";
    await comment.save();

    await logAdminAction(req, {
      action: "comment_unhide",
      targetType: "comment",
      targetId: comment._id,
      details: { eventId: String(comment.eventId) }
    });

    res.json({ message: "Comment visible again." });
  } catch (err) {
    adminServerError(res, "ADMIN_COMMENT_UNHIDE_FAILED", "Failed to unhide comment");
  }
};

exports.deleteComment = async (req, res) => {
  try {
    const comment = await EventComment.findById(req.params.id);
    if (!comment) return res.status(404).json({ error: "Comment not found" });

    const event = await Event.findOne({ _id: comment.eventId, createdBy: req.user.id }).select("_id");
    if (!event) return res.status(403).json({ error: "Not allowed to moderate this comment" });

    await EventComment.deleteOne({ _id: comment._id });

    await logAdminAction(req, {
      action: "comment_delete",
      targetType: "comment",
      targetId: comment._id,
      details: { eventId: String(comment.eventId), userName: comment.userName }
    });

    res.json({ message: "Comment deleted." });
  } catch (err) {
    adminServerError(res, "ADMIN_COMMENT_DELETE_FAILED", "Failed to delete comment");
  }
};

exports.getUsers = async (req, res) => {
  try {
    const { page, pageSize, skip } = parsePagination(req.query, { defaultPageSize: 50, maxPageSize: 200 });
    const q = String(req.query.q || "").trim().toLowerCase();
    const verified = String(req.query.verified || "").trim().toLowerCase();
    const locked = String(req.query.locked || "").trim().toLowerCase();

    const and = [];
    if (verified === "true") and.push({ isEmailVerified: true });
    if (verified === "false") and.push({ $or: [{ isEmailVerified: false }, { isEmailVerified: { $exists: false } }] });
    if (locked === "true") and.push({ isAccountLocked: true });
    if (locked === "false") and.push({ $or: [{ isAccountLocked: false }, { isAccountLocked: { $exists: false } }] });
    const query = and.length ? { $and: and } : {};

    const total = await User.countDocuments(query);
    let users = await User.find(query)
      .select("name email role isEmailVerified isAccountLocked accountLockedAt createdAt")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(pageSize)
      .lean();

    if (q) {
      users = users.filter((u) =>
        String(u.name || "").toLowerCase().includes(q) ||
        String(u.email || "").toLowerCase().includes(q)
      );
    }

    res.json({ items: users, pagination: buildPageMeta({ page, pageSize, total }) });
  } catch (err) {
    adminServerError(res, "ADMIN_USERS_LIST_FAILED", "Failed to load users");
  }
};

exports.forceVerifyUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    user.isEmailVerified = true;
    user.signupOtpHash = "";
    user.signupOtpExpires = null;
    user.signupOtpResendAvailableAt = null;
    user.signupOtpAttempts = 0;
    user.signupOtpLockedUntil = null;
    await user.save();

    await logAdminAction(req, {
      action: "user_force_verify",
      targetType: "user",
      targetId: user._id,
      details: { email: user.email }
    });

    res.json({ message: "User verified successfully." });
  } catch (err) {
    adminServerError(res, "ADMIN_FORCE_VERIFY_FAILED", "Failed to verify user");
  }
};

exports.lockUser = async (req, res) => {
  try {
    const userId = String(req.params.id || "");
    if (userId === String(req.user.id)) {
      return res.status(400).json({ error: "You cannot lock your own account." });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    user.isAccountLocked = true;
    user.accountLockedAt = new Date();
    user.tokenVersion = Number(user.tokenVersion || 0) + 1;
    await user.save();

    await logAdminAction(req, {
      action: "user_lock",
      targetType: "user",
      targetId: user._id,
      details: { email: user.email }
    });

    res.json({ message: "User locked successfully." });
  } catch (err) {
    adminServerError(res, "ADMIN_USER_LOCK_FAILED", "Failed to lock user");
  }
};

exports.unlockUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    const unlockReasonRaw = typeof req.body?.reason === "string" ? req.body.reason : "";
    const unlockReason = unlockReasonRaw.trim().slice(0, 300);

    user.isAccountLocked = false;
    user.accountLockedAt = null;
    await user.save();

    await logAdminAction(req, {
      action: "user_unlock",
      targetType: "user",
      targetId: user._id,
      details: {
        email: user.email,
        ...(unlockReason ? { reason: unlockReason } : {})
      }
    });

    res.json({ message: "User unlocked successfully." });
  } catch (err) {
    adminServerError(res, "ADMIN_USER_UNLOCK_FAILED", "Failed to unlock user");
  }
};

exports.getUserActionHistory = async (req, res) => {
  try {
    const userId = String(req.params.id || "").trim();
    if (!userId) return res.status(400).json({ error: "User id is required" });

    const user = await User.findById(userId).select("_id name email").lean();
    if (!user) return res.status(404).json({ error: "User not found" });

    const limitRaw = Number(req.query.limit || 20);
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 20;

    const items = await AuditLog.find({
      targetType: "user",
      targetId: String(user._id),
      action: { $in: ["user_force_verify", "user_lock", "user_unlock"] }
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate("actorUserId", "name email")
      .lean();

    res.json({
      user,
      items: items.map((row) => ({
        _id: row._id,
        createdAt: row.createdAt,
        action: row.action,
        actor: row.actorUserId
          ? {
              id: row.actorUserId._id,
              name: row.actorUserId.name || null,
              email: row.actorUserId.email || null
            }
          : null,
        details: row.details || {}
      }))
    });
  } catch (err) {
    adminServerError(res, "ADMIN_USER_HISTORY_FAILED", "Failed to load user action history");
  }
};

exports.listPromoCodes = async (req, res) => {
  try {
    const eventId = String(req.query.eventId || "").trim();
    const query = { createdBy: req.user.id };
    if (eventId) query.eventId = eventId;
    const items = await PromoCode.find(query).sort({ createdAt: -1 }).lean();
    res.json(items);
  } catch (err) {
    adminServerError(res, "ADMIN_PROMO_LIST_FAILED", "Failed to load promo codes");
  }
};

exports.createPromoCode = async (req, res) => {
  try {
    const eventId = String(req.body?.eventId || "").trim();
    const code = String(req.body?.code || "").trim().toUpperCase();
    const discountType = String(req.body?.discountType || "").trim().toLowerCase();
    const discountValue = Number(req.body?.discountValue || 0);
    const maxUses = Number(req.body?.maxUses || 0);
    const expiresAtRaw = String(req.body?.expiresAt || "").trim();

    if (!eventId || !code || !["percent", "fixed"].includes(discountType) || Number.isNaN(discountValue) || discountValue <= 0) {
      return res.status(400).json({ error: "eventId, code, discountType(percent|fixed), discountValue are required" });
    }
    if (!/^[A-Z0-9_-]{3,40}$/.test(code)) {
      return res.status(400).json({ error: "code must be 3-40 chars: A-Z, 0-9, _ or -" });
    }
    if (discountType === "percent" && discountValue > 100) {
      return res.status(400).json({ error: "percent discount cannot exceed 100" });
    }
    if (!Number.isInteger(maxUses) || maxUses < 0) {
      return res.status(400).json({ error: "maxUses must be integer >= 0" });
    }

    const event = await Event.findOne({ _id: eventId, createdBy: req.user.id, isDeleted: { $ne: true } }).select("_id title");
    if (!event) return res.status(404).json({ error: "Event not found" });

    const expiresAt = expiresAtRaw ? new Date(expiresAtRaw) : null;
    if (expiresAtRaw && Number.isNaN(expiresAt.getTime())) {
      return res.status(400).json({ error: "expiresAt must be a valid date" });
    }

    const promo = await PromoCode.create({
      eventId: event._id,
      createdBy: req.user.id,
      code,
      discountType,
      discountValue,
      maxUses,
      expiresAt
    });

    await logAdminAction(req, {
      action: "promo_create",
      targetType: "promo",
      targetId: promo._id,
      details: { eventId: event._id, code: promo.code, discountType, discountValue, maxUses }
    });

    res.status(201).json(promo);
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ error: "Promo code already exists for this event" });
    }
    adminServerError(res, "ADMIN_PROMO_CREATE_FAILED", "Failed to create promo code");
  }
};

exports.togglePromoCode = async (req, res) => {
  try {
    const promo = await PromoCode.findOne({ _id: req.params.id, createdBy: req.user.id });
    if (!promo) return res.status(404).json({ error: "Promo code not found" });
    promo.active = !promo.active;
    await promo.save();
    await logAdminAction(req, {
      action: "promo_toggle",
      targetType: "promo",
      targetId: promo._id,
      details: { code: promo.code, active: promo.active }
    });
    res.json(promo);
  } catch (err) {
    adminServerError(res, "ADMIN_PROMO_TOGGLE_FAILED", "Failed to update promo code");
  }
};

exports.checkInBooking = async (req, res) => {
  try {
    const booking = await resolveOrganizerBookingLookup(req.params.id, req.user.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (!booking.eventId || String(booking.eventId.createdBy) !== String(req.user.id)) {
      return res.status(403).json({ error: "Not allowed to check in this booking" });
    }
    if (booking.status === "cancelled" || booking.status === "refunded") {
      return res.status(400).json({ error: `Cannot check in booking with status '${booking.status}'` });
    }
    booking.status = "checked_in";
    await booking.save();

    await logAdminAction(req, {
      action: "booking_check_in",
      targetType: "booking",
      targetId: booking._id,
      details: { eventId: booking.eventId._id, attendeeEmail: booking.attendeeEmail || "" }
    });

    res.json(booking);
  } catch (err) {
    adminServerError(res, "ADMIN_BOOKING_CHECKIN_FAILED", "Failed to check in booking");
  }
};

exports.exportEventPasses = async (req, res) => {
  try {
    const event = await Event.findOne({ _id: req.params.id, createdBy: req.user.id }).select("_id title");
    if (!event) return res.status(404).json({ error: "Event not found" });

    const rows = await Booking.find({ eventId: event._id }).sort({ date: -1 }).lean();
    const header = [
      "bookingId",
      "attendeeName",
      "attendeeEmail",
      "ticketType",
      "quantity",
      "status",
      "paymentStatus",
      "totalAmount",
      "passUrl"
    ];
    const baseUrl = String(process.env.CLIENT_BASE_URL || "http://localhost:5000").replace(/\/+$/, "");
    const csvRows = rows.map((b) => [
      b._id,
      b.attendeeName || "",
      b.attendeeEmail || "",
      b.ticketType || "",
      b.quantity || 1,
      b.status || "",
      b.paymentStatus || "",
      Number(b.totalAmount || 0).toFixed(2),
      `${baseUrl}/ticket-confirmation.html?bookingId=${encodeURIComponent(String(b._id || ""))}`
    ]);
    const csv = [header, ...csvRows]
      .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
      .join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=\"passes-${String(event._id)}.csv\"`);
    res.send(csv);
  } catch (err) {
    adminServerError(res, "ADMIN_PASSES_EXPORT_FAILED", "Failed to export passes");
  }
};
