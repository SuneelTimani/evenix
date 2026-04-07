require("dotenv").config();
const express = require("express");
const path = require("path");
const app = express();
const helmet = require("helmet");
const mongoose = require("mongoose");
const { validateEnv } = require("./config/env");
const { google } = validateEnv();
const { requestLogger } = require("./middleware/requestLogger");
const { notFoundHandler, errorHandler } = require("./middleware/errorHandler");
const { stripeWebhook } = require("./controllers/bookingController");
const { startNotificationWorker, stopNotificationWorker } = require("./utils/notifications");
const { startReminderWorker, stopReminderWorker } = require("./utils/reminderWorker");
const isVercel = Boolean(process.env.VERCEL);

const publicDir = path.join(__dirname, "public");

// Middleware
app.disable("x-powered-by");
if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

app.use(helmet({
  frameguard: { action: "deny" },
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      // Current frontend uses inline <script> blocks in many pages.
      // Keep unsafe-inline for compatibility until scripts are fully externalized.
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com", "https://cdn.jsdelivr.net"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https://ui-avatars.com", "https:"],
      connectSrc: ["'self'"],
      frameSrc: ["'self'", "https://www.google.com", "https://maps.google.com"],
      fontSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"]
    }
  },
  referrerPolicy: { policy: "strict-origin-when-cross-origin" }
}));

app.use(requestLogger);
app.post("/api/bookings/stripe/webhook", express.raw({ type: "application/json" }), stripeWebhook);
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(publicDir));
app.get("/", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});
app.get("/favicon.ico", (req, res) => {
  res.sendFile(path.join(publicDir, "assets", "web-logo.png"));
});


// Connect DB
const connectDB = require("./config/db");
connectDB();

const cors = require("cors");
const configuredOrigins = String(process.env.CORS_ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
const isProd = process.env.NODE_ENV === "production";
const vercelDeploymentOrigin = process.env.VERCEL_URL
  ? `https://${String(process.env.VERCEL_URL).trim()}`
  : "";
const clientBaseOrigin = (() => {
  try {
    const raw = String(process.env.CLIENT_BASE_URL || "").trim();
    if (!raw) return "";
    return new URL(raw).origin;
  } catch {
    return "";
  }
})();

function isLocalDevOrigin(origin) {
  try {
    const u = new URL(origin);
    const host = u.hostname;
    if (host === "localhost" || host === "127.0.0.1") return true;
    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    return false;
  } catch {
    return false;
  }
}

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);

    if (isProd) {
      const strictAllowed = [
        ...new Set([
          ...configuredOrigins,
          clientBaseOrigin,
          vercelDeploymentOrigin
        ].filter(Boolean))
      ];
      if (strictAllowed.includes(origin)) return cb(null, true);
      console.warn(`[CORS] Blocked origin in production: ${origin}`);
      return cb(null, false);
    }

    if (isLocalDevOrigin(origin)) return cb(null, true);
    if (configuredOrigins.includes(origin)) return cb(null, true);
    console.warn(`[CORS] Blocked origin: ${origin}`);
    return cb(null, false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
};

app.use(cors(corsOptions));
// Express 5 + path-to-regexp v6 does not accept "*" as a route pattern.
// app.options("/*", cors());
app.options(/.*/, cors(corsOptions));
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "smart-event-system",
    uptimeSec: Math.round(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

app.get("/health/db", async (req, res) => {
  const states = {
    0: "disconnected",
    1: "connected",
    2: "connecting",
    3: "disconnecting"
  };
  const readyState = mongoose.connection.readyState;
  const state = states[readyState] || "unknown";
  const isReady = readyState === 1;

  // Optional lightweight ping when connected.
  let pingOk = false;
  if (isReady) {
    try {
      await mongoose.connection.db.admin().command({ ping: 1 });
      pingOk = true;
    } catch {
      pingOk = false;
    }
  }

  const statusCode = isReady && pingOk ? 200 : 503;
  res.status(statusCode).json({
    status: statusCode === 200 ? "ok" : "degraded",
    db: {
      state,
      readyState,
      pingOk
    },
    timestamp: new Date().toISOString()
  });
});

// Routes
const eventRoutes = require("./routes/eventRoutes");
app.use("/api/events", eventRoutes);

const adminRoutes = require("./routes/adminRoutes");
app.use("/api/admin", adminRoutes);

const authRoutes = require("./routes/authRoutes");
app.use("/api/auth", authRoutes);

const bookingRoutes = require("./routes/bookingRoutes");
app.use("/api/bookings", bookingRoutes);

const notificationRoutes = require("./routes/notificationRoutes");
app.use("/api/notifications", notificationRoutes);

const chatbotRoutes = require("./routes/chatbotRoutes");
app.use("/api/chatbot", chatbotRoutes);

const mlRoutes = require("./routes/mlRoutes");
app.use("/api", mlRoutes);

const cronRoutes = require("./routes/cronRoutes");
app.use("/api/cron", cronRoutes);

app.get("/sitemap.xml", async (req, res) => {
  try {
    const Event = require("./models/Event");
    const baseUrl = String(process.env.CLIENT_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
    const now = new Date().toISOString();

    const staticUrls = [
      `${baseUrl}/`,
      `${baseUrl}/book.html`,
      `${baseUrl}/blog.html`,
      `${baseUrl}/contact.html`,
      `${baseUrl}/resources.html`
    ];

    const events = await Event.find({
      isDeleted: { $ne: true },
      $or: [{ status: "published" }, { status: { $exists: false } }]
    })
      .sort({ date: -1 })
      .select("_id updatedAt")
      .lean();

    function escXml(v) {
      return String(v || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
    }

    const urls = [
      ...staticUrls.map((url) => ({ loc: url, lastmod: now })),
      ...events.map((e) => ({
        loc: `${baseUrl}/event-details.html?id=${encodeURIComponent(String(e._id || ""))}`,
        lastmod: new Date(e.updatedAt || now).toISOString()
      }))
    ];

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (u) => `  <url>
    <loc>${escXml(u.loc)}</loc>
    <lastmod>${escXml(u.lastmod)}</lastmod>
  </url>`
  )
  .join("\n")}
</urlset>`;

    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.send(xml);
  } catch {
    res.status(500).type("text/plain").send("Failed to build sitemap");
  }
});

const passport = require("passport");
app.use(passport.initialize());
if (google.enabled) {
  require("./config/passport");
  app.use("/auth", require("./routes/googleAuth"));
  console.log(`Google OAuth enabled. Redirect URI: ${google.callbackUrl}`);
} else {
  console.log("Google OAuth disabled (no GOOGLE_* env vars found).");
}

app.use(notFoundHandler);
app.use(errorHandler);

process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] Unhandled rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("[FATAL] Uncaught exception:", error);
});

const PORT = Number(process.env.PORT) || 5000;
if (!isVercel && require.main === module) {
  app.listen(PORT, () => {
    console.log("Server running on port " + PORT);
    startNotificationWorker();
    startReminderWorker();
  });

  process.on("SIGINT", () => {
    stopNotificationWorker();
    stopReminderWorker();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    stopNotificationWorker();
    stopReminderWorker();
    process.exit(0);
  });
}

module.exports = app;
// console.log("Public folder path:", public/index.html);
