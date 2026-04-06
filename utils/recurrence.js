const MAX_RECURRING_OCCURRENCES = 52;
const RECURRENCE_FREQUENCIES = ["daily", "weekly", "monthly"];

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function cloneDate(value) {
  return new Date(new Date(value).getTime());
}

function formatRecurrenceLabel(config = {}) {
  if (!config?.enabled || !config?.frequency) return "";
  const interval = Math.max(1, Number(config.interval || 1));
  const unit = config.frequency === "daily"
    ? (interval === 1 ? "day" : "days")
    : config.frequency === "weekly"
      ? (interval === 1 ? "week" : "weeks")
      : (interval === 1 ? "month" : "months");
  const byDays = Array.isArray(config.weekdays) && config.weekdays.length
    ? ` on ${config.weekdays.map((day) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day]).join(", ")}`
    : "";
  return `Repeats every ${interval} ${unit}${byDays}`;
}

function normalizeRecurrenceInput(raw = {}, startDateValue) {
  const startDate = new Date(startDateValue);
  if (Number.isNaN(startDate.getTime())) {
    return { enabled: false, error: "Event date must be valid before recurrence can be configured" };
  }

  const enabled = Boolean(raw?.enabled);
  if (!enabled) {
    return { enabled: false, label: "" };
  }

  const frequency = String(raw.frequency || "").trim().toLowerCase();
  if (!RECURRENCE_FREQUENCIES.includes(frequency)) {
    return { enabled: false, error: "Recurrence frequency must be daily, weekly, or monthly" };
  }

  const interval = Math.min(12, toPositiveInt(raw.interval, 1));
  const countRaw = Number(raw.count);
  const count = Number.isInteger(countRaw) && countRaw > 1
    ? Math.min(MAX_RECURRING_OCCURRENCES, countRaw)
    : null;

  let until = null;
  if (raw.until) {
    const parsedUntil = new Date(raw.until);
    if (Number.isNaN(parsedUntil.getTime())) {
      return { enabled: false, error: "Recurrence end date is invalid" };
    }
    if (parsedUntil.getTime() <= startDate.getTime()) {
      return { enabled: false, error: "Recurrence end date must be after the first event date" };
    }
    until = parsedUntil;
  }

  let weekdays = [];
  if (frequency === "weekly") {
    weekdays = Array.isArray(raw.weekdays)
      ? raw.weekdays
          .map((day) => Number(day))
          .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
      : [];
    if (!weekdays.length) weekdays = [startDate.getDay()];
    if (!weekdays.includes(startDate.getDay())) weekdays.push(startDate.getDay());
    weekdays = [...new Set(weekdays)].sort((a, b) => a - b);
  }

  if (!count && !until) {
    return { enabled: false, error: "Recurring events need an occurrence count or end date" };
  }

  const config = {
    enabled: true,
    frequency,
    interval,
    count,
    until,
    weekdays,
    label: ""
  };
  config.label = formatRecurrenceLabel(config);
  return config;
}

function generateRecurringDates(startDateValue, config = {}) {
  const startDate = cloneDate(startDateValue);
  if (!config?.enabled) return [startDate];

  const countLimit = Math.min(MAX_RECURRING_OCCURRENCES, Number(config.count || MAX_RECURRING_OCCURRENCES));
  const until = config.until ? cloneDate(config.until) : null;
  const dates = [startDate];

  if (config.frequency === "daily") {
    while (dates.length < countLimit) {
      const next = cloneDate(dates[dates.length - 1]);
      next.setDate(next.getDate() + Number(config.interval || 1));
      if (until && next.getTime() > until.getTime()) break;
      dates.push(next);
    }
    return dates;
  }

  if (config.frequency === "monthly") {
    while (dates.length < countLimit) {
      const next = cloneDate(dates[dates.length - 1]);
      next.setMonth(next.getMonth() + Number(config.interval || 1));
      if (until && next.getTime() > until.getTime()) break;
      dates.push(next);
    }
    return dates;
  }

  const weekdays = Array.isArray(config.weekdays) && config.weekdays.length
    ? config.weekdays
    : [startDate.getDay()];
  const anchorWeekStart = cloneDate(startDate);
  anchorWeekStart.setHours(0, 0, 0, 0);
  anchorWeekStart.setDate(anchorWeekStart.getDate() - anchorWeekStart.getDay());

  let cursor = cloneDate(startDate);
  cursor.setDate(cursor.getDate() + 1);
  while (dates.length < countLimit) {
    if (until && cursor.getTime() > until.getTime()) break;
    const weekStart = cloneDate(cursor);
    weekStart.setHours(0, 0, 0, 0);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    const weekDiff = Math.floor((weekStart.getTime() - anchorWeekStart.getTime()) / (7 * 24 * 60 * 60 * 1000));
    if (weekDiff >= 0 && weekDiff % Number(config.interval || 1) === 0 && weekdays.includes(cursor.getDay())) {
      const occurrence = cloneDate(cursor);
      occurrence.setHours(startDate.getHours(), startDate.getMinutes(), startDate.getSeconds(), startDate.getMilliseconds());
      dates.push(occurrence);
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

module.exports = {
  MAX_RECURRING_OCCURRENCES,
  RECURRENCE_FREQUENCIES,
  formatRecurrenceLabel,
  normalizeRecurrenceInput,
  generateRecurringDates
};
