"use strict";

const User = require("../models/User");
const { normalizePlan } = require("../utils/plans");

let Stripe = null;
try {
  Stripe = require("stripe");
} catch {
  Stripe = null;
}

const stripe = Stripe && process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const clientBaseUrl = String(process.env.CLIENT_BASE_URL || "http://localhost:5000").replace(/\/+$/, "");

function billingError(res, code, message) {
  return res.status(500).json({ error: message, code });
}

async function getOrCreateStripeCustomer(user) {
  if (!stripe) throw new Error("Stripe is not configured");
  if (user.stripeCustomerId) {
    try {
      const customer = await stripe.customers.retrieve(user.stripeCustomerId);
      if (customer && !customer.deleted) return customer;
    } catch {
      // fall through and create a fresh customer
    }
  }

  const customer = await stripe.customers.create({
    email: user.email || undefined,
    name: user.name || undefined,
    metadata: {
      userId: String(user._id || ""),
      role: String(user.role || "user")
    }
  });
  user.stripeCustomerId = String(customer.id || "");
  await user.save();
  return customer;
}

function applySubscriptionToUser(user, subscription, customerId = "") {
  const status = String(subscription?.status || "").toLowerCase();
  const isActive = ["trialing", "active", "past_due"].includes(status);
  user.stripeCustomerId = customerId || user.stripeCustomerId || "";
  user.stripeSubscriptionId = String(subscription?.id || user.stripeSubscriptionId || "");
  user.plan = {
    tier: isActive ? "pro" : "free",
    status: isActive ? "active" : "inactive",
    startedAt: user.plan?.startedAt || new Date(),
    renewsAt: subscription?.current_period_end
      ? new Date(Number(subscription.current_period_end) * 1000)
      : null
  };
}

exports.createProCheckoutSession = async (req, res) => {
  try {
    if (!stripe) {
      return res.status(400).json({ error: "Stripe is not configured", code: "STRIPE_NOT_CONFIGURED" });
    }
    if (!process.env.STRIPE_PRO_PRICE_ID) {
      return res.status(400).json({ error: "STRIPE_PRO_PRICE_ID is not configured", code: "MISSING_PRO_PRICE" });
    }

    const user = await User.findById(req.user?.id).select("_id email name role plan stripeCustomerId stripeSubscriptionId");
    if (!user) return res.status(404).json({ error: "User not found", code: "USER_NOT_FOUND" });
    if (user.role !== "admin") {
      return res.status(403).json({ error: "Pro billing is available to organizers/admins only", code: "ADMIN_ONLY" });
    }
    if (String(user.plan?.tier || "free") === "pro" && String(user.plan?.status || "active") === "active") {
      return res.status(409).json({ error: "Your account is already on Pro", code: "ALREADY_PRO" });
    }

    const customer = await getOrCreateStripeCustomer(user);
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customer.id,
      payment_method_types: ["card"],
      line_items: [{ price: process.env.STRIPE_PRO_PRICE_ID, quantity: 1 }],
      success_url: `${clientBaseUrl}/pricing.html?upgraded=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${clientBaseUrl}/pricing.html?canceled=1`,
      metadata: {
        purpose: "pro_subscription",
        userId: String(user._id || ""),
        planTier: "pro"
      },
      subscription_data: {
        metadata: {
          purpose: "pro_subscription",
          userId: String(user._id || ""),
          planTier: "pro"
        }
      },
      allow_promotion_codes: true
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    billingError(res, "PRO_CHECKOUT_FAILED", err.message || "Failed to start Pro checkout");
  }
};

exports.createBillingPortalSession = async (req, res) => {
  try {
    if (!stripe) {
      return res.status(400).json({ error: "Stripe is not configured", code: "STRIPE_NOT_CONFIGURED" });
    }
    const user = await User.findById(req.user?.id).select("_id role stripeCustomerId plan");
    if (!user) return res.status(404).json({ error: "User not found", code: "USER_NOT_FOUND" });
    if (!user.stripeCustomerId) {
      return res.status(400).json({ error: "No Stripe customer found for this account", code: "NO_BILLING_ACCOUNT" });
    }
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${clientBaseUrl}/pricing.html`
    });
    res.json({ url: session.url });
  } catch (err) {
    billingError(res, "BILLING_PORTAL_FAILED", err.message || "Failed to open billing portal");
  }
};

exports.handleStripeSubscriptionWebhook = async (stripeEvent) => {
  if (!stripeEvent || !stripeEvent.type) return false;

  if (stripeEvent.type === "checkout.session.completed") {
    const session = stripeEvent.data?.object || {};
    if (session.mode !== "subscription" || String(session.metadata?.purpose || "") !== "pro_subscription") {
      return false;
    }
    const userId = String(session.metadata?.userId || "").trim();
    if (!userId) return true;
    const user = await User.findById(userId);
    if (!user) return true;

    let subscription = null;
    if (session.subscription) {
      subscription = await stripe.subscriptions.retrieve(String(session.subscription));
    }
    if (subscription) {
      applySubscriptionToUser(user, subscription, String(session.customer || ""));
      await user.save();
    }
    return true;
  }

  if (stripeEvent.type === "customer.subscription.updated" || stripeEvent.type === "customer.subscription.deleted") {
    const subscription = stripeEvent.data?.object || {};
    const subscriptionId = String(subscription.id || "").trim();
    const customerId = String(subscription.customer || "").trim();
    if (!subscriptionId && !customerId) return true;

    const user = await User.findOne({
      $or: [
        ...(subscriptionId ? [{ stripeSubscriptionId: subscriptionId }] : []),
        ...(customerId ? [{ stripeCustomerId: customerId }] : [])
      ]
    });
    if (!user) return true;

    applySubscriptionToUser(user, subscription, customerId);
    if (stripeEvent.type === "customer.subscription.deleted") {
      user.stripeSubscriptionId = "";
      user.plan.tier = "free";
      user.plan.status = "inactive";
      user.plan.renewsAt = null;
    }
    await user.save();
    return true;
  }

  return false;
};

exports.getMyPlan = async (req, res) => {
  try {
    const user = await User.findById(req.user?.id).select("_id role plan stripeCustomerId stripeSubscriptionId");
    if (!user) return res.status(404).json({ error: "User not found", code: "USER_NOT_FOUND" });
    res.json({
      plan: normalizePlan(user),
      canManageBilling: Boolean(user.stripeCustomerId),
      role: user.role
    });
  } catch (err) {
    billingError(res, "PLAN_FETCH_FAILED", "Failed to load current plan");
  }
};
