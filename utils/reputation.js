"use strict";

function getEventDate(booking) {
  const raw = booking?.eventId?.date || booking?.eventDate || null;
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getBookingDate(booking) {
  const raw = booking?.date || booking?.createdAt || null;
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getUpdatedDate(booking) {
  const raw = booking?.updatedAt || booking?.date || booking?.createdAt || null;
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getTier(score, totalBookings) {
  if (totalBookings <= 0) {
    return {
      key: "new",
      label: "New Attendee",
      stars: "☆☆☆☆☆",
      starsFilled: 0,
      description: "No attendance history yet"
    };
  }
  if (score >= 95) {
    return {
      key: "super_attender",
      label: "Super Attender",
      stars: "★★★★★",
      starsFilled: 5,
      description: "Shows up 95% of the time"
    };
  }
  if (score >= 80) {
    return {
      key: "reliable",
      label: "Reliable",
      stars: "★★★★☆",
      starsFilled: 4,
      description: "Consistently attends and books responsibly"
    };
  }
  if (score >= 60) {
    return {
      key: "occasional",
      label: "Occasional",
      stars: "★★★☆☆",
      starsFilled: 3,
      description: "Cancels sometimes"
    };
  }
  if (score >= 40) {
    return {
      key: "risky",
      label: "Risky",
      stars: "★★☆☆☆",
      starsFilled: 2,
      description: "Attendance is inconsistent"
    };
  }
  return {
    key: "ghost",
    label: "Ghost",
    stars: "★☆☆☆☆",
    starsFilled: 1,
    description: "Books but rarely shows up"
  };
}

function calculateAttendeeReputation(bookings, options = {}) {
  const rows = Array.isArray(bookings) ? bookings : [];
  const now = options.now instanceof Date ? options.now : new Date();

  const totalBookings = rows.length;
  const checkedInCount = rows.filter((booking) => booking?.status === "checked_in").length;
  const cancelledCount = rows.filter((booking) => booking?.status === "cancelled").length;

  const pastResolved = rows.filter((booking) => {
    const eventDate = getEventDate(booking);
    return eventDate && eventDate.getTime() < now.getTime();
  });

  const noShowCount = pastResolved.filter((booking) =>
    ["pending", "confirmed"].includes(String(booking?.status || "").toLowerCase())
  ).length;

  const attendedOpportunities = checkedInCount + noShowCount;
  const showUpRate = attendedOpportunities > 0 ? checkedInCount / attendedOpportunities : 0;

  const leadTimeRows = rows.filter((booking) => getEventDate(booking) && getBookingDate(booking));
  const earlyBookingCount = leadTimeRows.filter((booking) => {
    const eventDate = getEventDate(booking);
    const bookingDate = getBookingDate(booking);
    const leadDays = (eventDate.getTime() - bookingDate.getTime()) / (1000 * 60 * 60 * 24);
    return leadDays >= 7;
  }).length;
  const earlyBookingRate = leadTimeRows.length ? earlyBookingCount / leadTimeRows.length : 0;

  const lateCancelCount = rows.filter((booking) => {
    if (String(booking?.status || "").toLowerCase() !== "cancelled") return false;
    const eventDate = getEventDate(booking);
    const updatedAt = getUpdatedDate(booking);
    if (!eventDate || !updatedAt) return false;
    const hoursBefore = (eventDate.getTime() - updatedAt.getTime()) / (1000 * 60 * 60);
    return hoursBefore >= 0 && hoursBefore <= 24;
  }).length;

  const cancelRate = totalBookings > 0 ? cancelledCount / totalBookings : 0;
  const lateCancelRate = cancelledCount > 0 ? lateCancelCount / cancelledCount : 0;
  const attendanceExperience = Math.min(1, checkedInCount / 10);

  const scoreRaw =
    showUpRate * 60 +
    earlyBookingRate * 15 +
    attendanceExperience * 10 +
    (1 - lateCancelRate) * 10 +
    (1 - cancelRate) * 5;

  const score = Math.max(0, Math.min(100, Math.round(scoreRaw)));
  const tier = getTier(score, totalBookings);

  return {
    score,
    label: tier.label,
    key: tier.key,
    stars: tier.stars,
    starsFilled: tier.starsFilled,
    description: tier.description,
    showUpRate: Math.round(showUpRate * 100),
    earlyBookingRate: Math.round(earlyBookingRate * 100),
    totalBookings,
    checkedInCount,
    cancelledCount,
    noShowCount,
    lateCancelCount,
    eligibleForRewards: score >= 80 && checkedInCount >= 3
  };
}

module.exports = {
  calculateAttendeeReputation
};
