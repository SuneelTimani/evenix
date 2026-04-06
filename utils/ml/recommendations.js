/**
 * recommendations.js
 * Content-based + collaborative filtering event recommendations.
 * No external ML libraries — pure JS cosine similarity.
 */

"use strict";

// ─── Cosine Similarity ────────────────────────────────────────────────────────

function dotProduct(a, b) {
  let sum = 0;
  for (const key of Object.keys(a)) {
    if (b[key]) sum += a[key] * b[key];
  }
  return sum;
}

function magnitude(vec) {
  return Math.sqrt(Object.values(vec).reduce((s, v) => s + v * v, 0));
}

function cosineSimilarity(a, b) {
  const mag = magnitude(a) * magnitude(b);
  if (!mag) return 0;
  return dotProduct(a, b) / mag;
}

// ─── TF-IDF term vector from text ─────────────────────────────────────────────

const STOP_WORDS = new Set([
  "a","an","the","and","or","but","in","on","at","to","for","of","with",
  "is","are","was","were","be","been","has","have","had","will","would",
  "this","that","these","those","it","its","we","our","you","your","i",
  "my","me","he","she","they","them","their","what","which","who","how"
]);

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

function buildTermVector(tokens) {
  const tf = {};
  for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
  const total = tokens.length || 1;
  for (const t of Object.keys(tf)) tf[t] /= total;
  return tf;
}

function eventToVector(event) {
  const tokens = [
    ...tokenize(event.title),
    ...tokenize(event.description),
    ...tokenize(event.category),
    ...tokenize(event.location),
    ...tokenize(event.organizer),
  ];
  // Boost category weight (repeat 3x)
  for (let i = 0; i < 2; i++) tokens.push(...tokenize(event.category));
  return buildTermVector(tokens);
}

function eventIdentity(event) {
  return String(event?.recurrenceSeriesId || event?._id || "");
}

// ─── Content-based filtering ──────────────────────────────────────────────────

function contentBasedScores(userEvents, candidateEvents) {
  if (!userEvents.length) return {};

  // Build user profile vector = average of all events user attended
  const profileTokens = [];
  for (const e of userEvents) profileTokens.push(...tokenize(e.title), ...tokenize(e.category), ...tokenize(e.description));
  const profileVector = buildTermVector(profileTokens);

  const scores = {};
  for (const event of candidateEvents) {
    const vec = eventToVector(event);
    scores[String(event._id)] = cosineSimilarity(profileVector, vec);
  }
  return scores;
}

// ─── Collaborative filtering (item-item) ─────────────────────────────────────

function collaborativeScores(userId, allBookings, candidateEvents) {
  // Build user→events map
  const userEventsMap = {};
  for (const b of allBookings) {
    const uid = String(b.userId?._id || b.userId || "");
    const eid = String(b.recurrenceSeriesId || b.eventId?.recurrenceSeriesId || b.eventId?._id || b.eventId || "");
    if (!uid || !eid) continue;
    if (!userEventsMap[uid]) userEventsMap[uid] = new Set();
    userEventsMap[uid].add(eid);
  }

  const targetEvents = userEventsMap[String(userId)] || new Set();
  if (!targetEvents.size) return {};

  // Find similar users (Jaccard similarity)
  const similarUsers = [];
  for (const [uid, events] of Object.entries(userEventsMap)) {
    if (uid === String(userId)) continue;
    const intersection = [...targetEvents].filter((e) => events.has(e)).length;
    const union = new Set([...targetEvents, ...events]).size;
    if (union > 0 && intersection > 0) {
      similarUsers.push({ uid, similarity: intersection / union, events });
    }
  }

  similarUsers.sort((a, b) => b.similarity - a.similarity);
  const topNeighbors = similarUsers.slice(0, 10);

  // Score candidates by neighbor weighted votes
  const scores = {};
  for (const event of candidateEvents) {
    const eid = eventIdentity(event);
    let score = 0;
    for (const neighbor of topNeighbors) {
      if (neighbor.events.has(eid)) score += neighbor.similarity;
    }
    scores[eid] = score;
  }
  return scores;
}

// ─── Recency & popularity boost ───────────────────────────────────────────────

function popularityBoost(event) {
  const booked = Number(event.seatsBooked || 0);
  const capacity = Number(event.capacity || 1);
  return Math.min(booked / capacity, 1) * 0.3; // max 0.3 bonus
}

function recencyBoost(event) {
  const eventDate = new Date(event.date);
  const now = new Date();
  const daysUntil = (eventDate - now) / (1000 * 60 * 60 * 24);
  if (daysUntil < 0) return 0; // past event
  if (daysUntil <= 7) return 0.25;
  if (daysUntil <= 30) return 0.15;
  if (daysUntil <= 90) return 0.05;
  return 0;
}

// ─── Main recommendation function ─────────────────────────────────────────────

/**
 * @param {string} userId
 * @param {Array} userBookings - bookings for this user (populated eventId)
 * @param {Array} allBookings  - all bookings in system (for collaborative)
 * @param {Array} allEvents    - all published events
 * @param {number} limit
 * @returns {Array} sorted recommended events with reasons
 */
function getRecommendations({ userId, userBookings, allBookings, allEvents, limit = 6 }) {
  const attendedIds = new Set(
    userBookings.map((b) => String(b.recurrenceSeriesId || b.eventId?.recurrenceSeriesId || b.eventId?._id || b.eventId || ""))
  );

  const candidates = allEvents.filter(
    (e) =>
      !attendedIds.has(eventIdentity(e)) &&
      e.status === "published" &&
      new Date(e.date) > new Date()
  );

  if (!candidates.length) return [];

  const userEvents = userBookings
    .map((b) => b.eventId)
    .filter((e) => e && typeof e === "object");

  const cbScores  = contentBasedScores(userEvents, candidates);
  const cfScores  = collaborativeScores(userId, allBookings, candidates);

  // Normalise CF scores to [0,1]
  const maxCf = Math.max(...Object.values(cfScores), 1);

  const scored = candidates.map((event) => {
    const eid = String(event._id);
    const cb  = cbScores[eid]  || 0;
    const cf  = (cfScores[eid] || 0) / maxCf;
    const pop = popularityBoost(event);
    const rec = recencyBoost(event);

    // Weighted blend
    const finalScore = cb * 0.45 + cf * 0.30 + pop * 0.15 + rec * 0.10;

    // Build human-readable reasons
    const reasons = [];
    if (cb > 0.15) reasons.push("similar_category");
    if (cf > 0.1)  reasons.push("popular_with_similar_users");
    if (pop > 0.2) reasons.push("trending");
    if (rec > 0.1) reasons.push("happening_soon");
    if (!reasons.length) reasons.push("recommended_for_you");

    return { event, score: finalScore, reasons };
  });

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map(({ event, score, reasons }) => ({
    ...event.toObject ? event.toObject() : event,
    recommendationScore: Math.round(score * 100) / 100,
    recommendationReasons: reasons,
  }));
}

module.exports = { getRecommendations };
