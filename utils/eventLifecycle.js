function getEventLifecycle(event, now = new Date()) {
  const current = now instanceof Date ? now : new Date(now);
  const eventDate = event?.date ? new Date(event.date) : null;
  const isPast = Boolean(eventDate && !Number.isNaN(eventDate.getTime()) && eventDate.getTime() < current.getTime());
  const isArchived = Boolean(event?.isDeleted === true);
  const isCancelled = String(event?.status || "").toLowerCase() === "cancelled";

  let bucket = "upcoming";
  let label = "Upcoming";

  if (isArchived) {
    bucket = "archived";
    label = "Archived";
  } else if (isPast) {
    bucket = "past";
    label = "Past";
  } else if (isCancelled) {
    bucket = "cancelled";
    label = "Cancelled";
  }

  return {
    bucket,
    label,
    isPast,
    isArchived,
    isCancelled
  };
}

function decorateEventLifecycle(event, now = new Date()) {
  return {
    ...event,
    lifecycle: getEventLifecycle(event, now)
  };
}

module.exports = {
  getEventLifecycle,
  decorateEventLifecycle
};
