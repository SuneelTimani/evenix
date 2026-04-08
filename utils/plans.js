"use strict";

const PLAN_TIERS = {
  FREE: "free",
  PRO: "pro"
};

const PLAN_FEATURES = {
  free: {
    recurring_events: false,
    advanced_ml_insights: false,
    promo_codes: false,
    weekly_digest: false,
    live_qna: false,
    active_events_limit: 3
  },
  pro: {
    recurring_events: true,
    advanced_ml_insights: true,
    promo_codes: true,
    weekly_digest: true,
    live_qna: true,
    active_events_limit: Number.POSITIVE_INFINITY
  }
};

function getPlanTier(user) {
  const tier = String(user?.plan?.tier || PLAN_TIERS.FREE).trim().toLowerCase();
  return tier === PLAN_TIERS.PRO ? PLAN_TIERS.PRO : PLAN_TIERS.FREE;
}

function getPlanStatus(user) {
  const status = String(user?.plan?.status || "active").trim().toLowerCase();
  return status === "inactive" ? "inactive" : "active";
}

function getPlanConfig(user) {
  return PLAN_FEATURES[getPlanTier(user)] || PLAN_FEATURES.free;
}

function hasPlanFeature(user, featureKey) {
  return Boolean(getPlanConfig(user)[featureKey]);
}

function getPlanLimit(user, limitKey) {
  return getPlanConfig(user)[limitKey];
}

function normalizePlan(user) {
  const tier = getPlanTier(user);
  const status = getPlanStatus(user);
  const config = getPlanConfig(user);
  return {
    tier,
    status,
    label: tier === PLAN_TIERS.PRO ? "Pro" : "Free",
    startedAt: user?.plan?.startedAt || null,
    renewsAt: user?.plan?.renewsAt || null,
    features: {
      recurringEvents: Boolean(config.recurring_events),
      advancedMlInsights: Boolean(config.advanced_ml_insights),
      promoCodes: Boolean(config.promo_codes),
      weeklyDigest: Boolean(config.weekly_digest),
      liveQna: Boolean(config.live_qna)
    },
    limits: {
      activeEvents: Number.isFinite(config.active_events_limit) ? config.active_events_limit : null
    }
  };
}

module.exports = {
  PLAN_TIERS,
  getPlanTier,
  getPlanStatus,
  getPlanConfig,
  hasPlanFeature,
  getPlanLimit,
  normalizePlan
};
