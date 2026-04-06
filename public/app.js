const container = document.getElementById("events");
const refreshBtn = document.getElementById("refreshBtn");
const eventSearch = document.getElementById("eventSearch");
const localeSelect = document.getElementById("localeSelect");
const timezoneSelect = document.getElementById("timezoneSelect");
const installAppBtn = document.getElementById("installAppBtn");
const heroCategoryPills = Array.from(document.querySelectorAll("#heroCategoryPills [data-category]"));
const filterCategory = document.getElementById("filterCategory");
const filterDate = document.getElementById("filterDate");
const filterPrice = document.getElementById("filterPrice");
const resultsMeta = document.getElementById("resultsMeta");
const searchAnnouncer = document.getElementById("searchAnnouncer");

let allEvents = [];
let currentSourceEvents = [];
let searchTimer = null;
let activeSearchRequest = 0;
const initialQuery = new URLSearchParams(window.location.search).get("q") || "";
if (eventSearch && initialQuery) eventSearch.value = initialQuery;

const HERO_CATEGORY_MAP = {
  all: ["all"],
  Music: ["concert", "festival"],
  Tech: ["conference", "meetup", "webinar"],
  Workshop: ["workshop"],
  Conference: ["conference"],
  Festival: ["festival"]
};

function syncNavOffsetVar() {
  const nav = document.querySelector("[data-role-nav]");
  const offset = nav ? nav.offsetHeight + 12 : 0;
  document.documentElement.style.setProperty("--nav-offset", `${offset}px`);
}

function formatDate(value) {
  if (!value) return window.AppI18nTime?.t("no_date") || "No date";
  if (window.AppI18nTime?.formatDateTimeWithZone) return window.AppI18nTime.formatDateTimeWithZone(value);
  if (window.AppI18nTime?.formatDateTime) return window.AppI18nTime.formatDateTime(value);
  return new Date(value).toLocaleString();
}

function formatPrice(value) {
  return Number(value || 0).toFixed(2).replace(/\.00$/, "");
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function categoryToken(event) {
  return String(event?.category || "").trim().toLowerCase();
}

function categoryMatches(event, selectedCategory) {
  if (!selectedCategory || selectedCategory === "all") return true;
  const token = categoryToken(event);
  const mapped = HERO_CATEGORY_MAP[selectedCategory] || [String(selectedCategory).toLowerCase()];
  return mapped.includes(token);
}

function eventPrice(event) {
  if (Number(event?.lowestTicketPrice || 0) > 0) return Number(event.lowestTicketPrice || 0);
  const tickets = Array.isArray(event?.ticketTypes) ? event.ticketTypes : [];
  if (!tickets.length) return 0;
  return Math.min(...tickets.map((ticket) => Number(ticket.price || 0)));
}

function normalizeDate(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function dateMatches(event, mode) {
  if (!mode || mode === "all") return true;
  const eventDate = new Date(event?.date || 0);
  if (Number.isNaN(eventDate.getTime())) return false;

  const now = new Date();
  const today = normalizeDate(now);
  const compare = normalizeDate(eventDate);
  const day = compare.getDay();
  const daysFromMonday = (day + 6) % 7;
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - daysFromMonday);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);

  if (mode === "today") return compare.getTime() === today.getTime();
  if (mode === "this_week") return compare >= weekStart && compare <= weekEnd;
  if (mode === "this_weekend") return compare >= weekStart && compare <= weekEnd && (day === 0 || day === 6);
  if (mode === "this_month") return compare >= monthStart && compare <= monthEnd;
  return true;
}

function priceMatches(event, mode) {
  if (!mode || mode === "all") return true;
  const price = eventPrice(event);
  if (mode === "free") return price <= 0;
  if (mode === "paid") return price > 0;
  return true;
}

function getSelectedHeroCategory() {
  const active = heroCategoryPills.find((btn) => btn.classList.contains("is-active"));
  return active ? active.dataset.category : "all";
}

function getEventDetailsUrl(event) {
  const url = new URL("/event-details.html", window.location.origin);
  if (event && event._id) url.searchParams.set("id", String(event._id));
  return url.toString();
}

function getEventImageUrl(event) {
  const src = String(event?.coverImage || "").trim();
  if (/^data:image\//i.test(src)) return src;
  if (/^https?:\/\//i.test(src)) return src;
  return "";
}

function getCategoryGradient(event) {
  const token = categoryToken(event);
  if (token === "conference") return "linear-gradient(135deg, rgba(124,106,247,0.45), rgba(26,33,63,0.9))";
  if (token === "workshop") return "linear-gradient(135deg, rgba(16,185,129,0.35), rgba(21,37,47,0.95))";
  if (token === "festival" || token === "concert") return "linear-gradient(135deg, rgba(245,158,11,0.35), rgba(53,23,44,0.92))";
  if (token === "meetup") return "linear-gradient(135deg, rgba(56,189,248,0.3), rgba(16,24,38,0.94))";
  return "linear-gradient(135deg, rgba(124,106,247,0.28), rgba(30,37,54,0.95))";
}

function getOrganizerInitials(name) {
  return String(name || "Event")
    .split(" ")
    .map((part) => part[0] || "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function getUrgencyBadge(event) {
  const capacity = Number(event?.capacity || 0);
  const seatsLeft = Math.max(0, capacity - Number(event?.seatsBooked || 0));
  if (!capacity || seatsLeft <= 0) return "Sold out";
  if (seatsLeft / capacity < 0.2) return `${seatsLeft} spots left`;
  return "";
}

function renderEmptyState(message, hint) {
  container.innerHTML = `
    <div class="empty-state">
      <div class="empty-illustration">
        <svg viewBox="0 0 24 24" class="h-10 w-10 text-violet-200" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
          <path d="M10.5 5a5.5 5.5 0 1 0 3.6 9.66l4.62 4.62 1.28-1.28-4.62-4.62A5.5 5.5 0 0 0 10.5 5Z"></path>
        </svg>
      </div>
      <h3 class="m-0 text-xl font-semibold">No events match your search</h3>
      <p class="max-w-md text-sm text-slate-400">${escapeHtml(message || "Try different keywords or remove some filters.")}</p>
      <button type="button" class="btn-primary" onclick="window.resetDiscoveryFilters()">Reset filters</button>
      <p class="text-xs text-slate-500">${escapeHtml(hint || "Search by organizer, city, event type, or explore a broader date range.")}</p>
    </div>
  `;
}

function renderLoadingState(message = "Loading events...") {
  const cards = Array.from({ length: 6 }).map(() => `
    <article class="skeleton-card">
      <div class="shimmer h-[220px] w-full"></div>
      <div class="space-y-3 p-6">
        <div class="shimmer h-4 w-24 rounded-full"></div>
        <div class="shimmer h-8 w-4/5 rounded-xl"></div>
        <div class="shimmer h-4 w-full rounded"></div>
        <div class="shimmer h-4 w-3/4 rounded"></div>
        <div class="shimmer h-10 w-full rounded-xl"></div>
      </div>
    </article>
  `).join("");
  container.innerHTML = cards;
  if (searchAnnouncer) searchAnnouncer.textContent = message;
}

function renderHeroStats(events) {
  const upcomingCount = events.filter((event) => {
    const when = new Date(event?.date || 0).getTime();
    if (!when) return false;
    const diff = when - Date.now();
    return diff >= 0 && diff <= (7 * 24 * 60 * 60 * 1000);
  }).length;
  const freeCount = events.filter((event) => eventPrice(event) <= 0).length;
  const fillAvg = events.length
    ? Math.round(events.reduce((sum, event) => {
      const capacity = Math.max(0, Number(event?.capacity || 0));
      const ratio = capacity > 0 ? Math.min(1, Number(event?.seatsBooked || 0) / capacity) : 0;
      return sum + ratio;
    }, 0) / events.length * 100)
    : 0;

  const upcomingEl = document.getElementById("heroUpcomingCount");
  const freeEl = document.getElementById("heroFreeCount");
  const fillEl = document.getElementById("heroFillRate");
  if (upcomingEl) upcomingEl.textContent = String(upcomingCount);
  if (freeEl) freeEl.textContent = String(freeCount);
  if (fillEl) fillEl.textContent = `${fillAvg}%`;
}

function renderEvents(events) {
  if (!Array.isArray(events) || !events.length) {
    renderEmptyState("Try different keywords or filters to uncover a better match.");
    if (resultsMeta) resultsMeta.textContent = "No events matched the current view.";
    if (searchAnnouncer) searchAnnouncer.textContent = "No events matched the current filters.";
    return;
  }

  container.innerHTML = "";
  events.forEach((event) => {
    const imageUrl = getEventImageUrl(event);
    const urgency = getUrgencyBadge(event);
    const detailsUrl = getEventDetailsUrl(event);
    const recurrenceLabel = String(event?.recurringSeries?.label || "");
    const card = document.createElement("article");
    card.className = "event-card";
    card.innerHTML = `
      <div class="event-media" style="${imageUrl ? "" : `background:${escapeHtml(getCategoryGradient(event))};`}">
        ${imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(event.title || "Event")}">` : `<div class="grid h-full place-items-center"><img src="/assets/web-logo.png" alt="Evenix" class="h-16 w-16 rounded-3xl object-cover opacity-80"></div>`}
        <span class="category-badge">${escapeHtml(event.category || "Event")}</span>
        ${urgency ? `<span class="urgency-badge">${escapeHtml(urgency)}</span>` : ""}
        <span class="price-badge">${eventPrice(event) <= 0 ? "FREE" : `$${escapeHtml(formatPrice(eventPrice(event)))}`}</span>
      </div>
      <div class="event-content">
        <h3 class="event-title">${escapeHtml(event.title || "Untitled event")}</h3>
        <div class="organizer-row">
          <span class="avatar-dot" aria-hidden="true">${escapeHtml(getOrganizerInitials(event.organizer || "Event"))}</span>
          <span>${escapeHtml(event.organizer || "Evenix")}</span>
        </div>
        <p class="event-description">${escapeHtml(event.description || "No description available.")}</p>
        <div class="meta-stack">
          ${recurrenceLabel ? `
            <div class="meta-row">
              <svg viewBox="0 0 24 24" class="h-4 w-4 text-emerald-300" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
                <path d="M3 12a9 9 0 1 0 3-6.7"></path>
                <path d="M3 4v5h5"></path>
              </svg>
              <span>${escapeHtml(recurrenceLabel)}</span>
            </div>
          ` : ""}
          <div class="meta-row">
            <svg viewBox="0 0 24 24" class="h-4 w-4 text-violet-300" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
              <path d="M8 2v4M16 2v4M3 10h18"></path>
              <rect x="3" y="5" width="18" height="16" rx="2"></rect>
            </svg>
            <span>${escapeHtml(formatDate(event.date))}</span>
          </div>
          <div class="meta-row">
            <svg viewBox="0 0 24 24" class="h-4 w-4 text-amber-300" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
              <path d="M12 22s7-4.35 7-11a7 7 0 1 0-14 0c0 6.65 7 11 7 11Z"></path>
              <circle cx="12" cy="11" r="2.5"></circle>
            </svg>
            <span>${escapeHtml(event.location || "Location TBA")}</span>
          </div>
        </div>
        <a href="${detailsUrl}" class="btn-primary book-cta" aria-label="Book ${escapeHtml(event.title || "event")}">Book now</a>
      </div>
    `;

    card.addEventListener("click", () => {
      window.location.href = detailsUrl;
    });

    const cta = card.querySelector(".book-cta");
    if (cta) {
      cta.addEventListener("click", (eventClick) => {
        eventClick.stopPropagation();
      });
    }

    container.appendChild(card);
  });

  if (resultsMeta) {
    resultsMeta.textContent = `${events.length} event${events.length === 1 ? "" : "s"} ready to explore. Click any card for full details.`;
  }
  if (searchAnnouncer) {
    searchAnnouncer.textContent = `${events.length} events loaded`;
  }
}

function applyVisualCategorySelection(selectedCategory) {
  heroCategoryPills.forEach((button) => {
    const active = button.dataset.category === selectedCategory;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
}

function applyFilters(sourceEvents = currentSourceEvents) {
  const selectedHeroCategory = getSelectedHeroCategory() || "all";
  const exactCategory = filterCategory?.value || "all";
  const selectedDate = filterDate?.value || "all";
  const selectedPrice = filterPrice?.value || "all";

  const filtered = (Array.isArray(sourceEvents) ? sourceEvents : []).filter((event) => (
    categoryMatches(event, selectedHeroCategory)
    && (exactCategory === "all" || String(event?.category || "") === exactCategory)
    && dateMatches(event, selectedDate)
    && priceMatches(event, selectedPrice)
  ));

  renderHeroStats(Array.isArray(sourceEvents) ? sourceEvents : []);
  renderEvents(filtered);
}

function syncCategoryControls(category) {
  const mapped = HERO_CATEGORY_MAP[category] ? category : "all";
  applyVisualCategorySelection(mapped);
}

function scheduleMlSearch(query) {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runMlSearch(query), 300);
}

async function loadEvents() {
  renderLoadingState("Loading events...");
  try {
    const res = await fetch("/api/events");
    if (!res.ok) throw new Error("Failed to fetch events");
    const data = await res.json();
    allEvents = Array.isArray(data) ? data : [];
    currentSourceEvents = [...allEvents];
    if (eventSearch && eventSearch.value.trim()) {
      await runMlSearch(eventSearch.value.trim());
      return;
    }
    applyFilters(currentSourceEvents);
  } catch (err) {
    renderEmptyState(`Could not load events. ${err.message}`, "Refresh the page or check the server connection.");
  }
}

async function runMlSearch(query) {
  const q = String(query || "").trim();
  const requestId = ++activeSearchRequest;

  if (!q) {
    currentSourceEvents = [...allEvents];
    applyFilters(currentSourceEvents);
    return;
  }

  renderLoadingState(`Searching for "${q}"...`);
  if (resultsMeta) resultsMeta.textContent = `Finding the best matches for “${q}”.`;

  try {
    const res = await fetch(`/api/ml/search?q=${encodeURIComponent(q)}&limit=20`);
    if (!res.ok) throw new Error("ML search failed");
    const payload = await res.json();
    if (requestId !== activeSearchRequest) return;
    currentSourceEvents = Array.isArray(payload?.results) ? payload.results : [];
    applyFilters(currentSourceEvents);
  } catch (err) {
    if (requestId !== activeSearchRequest) return;
    renderEmptyState(`Could not search events. ${err.message}`, "Try a simpler query or refresh events.");
  }
}

async function syncInstallPromptButton() {
  if (!installAppBtn || !window.PWAClient) return;
  const status = await window.PWAClient.getStatus().catch(() => ({ supported: false }));
  const shouldShow = status?.supported
    && !window.matchMedia("(display-mode: standalone)").matches
    && window.PWAClient.canInstall();
  installAppBtn.classList.toggle("hidden", !shouldShow);
}

function resetDiscoveryFilters() {
  if (eventSearch) eventSearch.value = "";
  if (filterDate) filterDate.value = "all";
  if (filterPrice) filterPrice.value = "all";
  syncCategoryControls("all");
  currentSourceEvents = [...allEvents];
  window.history.replaceState({}, "", "/");
  applyFilters(currentSourceEvents);
}
window.resetDiscoveryFilters = resetDiscoveryFilters;

if (refreshBtn) refreshBtn.addEventListener("click", loadEvents);

if (eventSearch) {
  eventSearch.addEventListener("input", () => {
    const q = eventSearch.value.trim();
    const url = q ? `/?q=${encodeURIComponent(q)}` : "/";
    window.history.replaceState({}, "", url);
    scheduleMlSearch(q);
  });

  window.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      eventSearch.focus();
      eventSearch.select();
    }
  });
}

heroCategoryPills.forEach((button) => {
  button.addEventListener("click", () => {
    const category = button.dataset.category || "all";
    syncCategoryControls(category);
    applyFilters(currentSourceEvents);
  });
});

if (filterCategory) {
  filterCategory.addEventListener("change", () => {
    applyFilters(currentSourceEvents);
  });
}

if (filterDate) filterDate.addEventListener("change", () => applyFilters(currentSourceEvents));
if (filterPrice) filterPrice.addEventListener("change", () => applyFilters(currentSourceEvents));

if (installAppBtn) {
  installAppBtn.addEventListener("click", async () => {
    if (!window.PWAClient?.canInstall()) return;
    installAppBtn.disabled = true;
    try {
      const result = await window.PWAClient.promptInstall();
      if (result?.installed) {
        installAppBtn.classList.add("hidden");
      } else {
        await syncInstallPromptButton();
      }
    } finally {
      installAppBtn.disabled = false;
    }
  });

  window.addEventListener("pwa:install-available", syncInstallPromptButton);
  window.addEventListener("pwa:installed", syncInstallPromptButton);
  window.addEventListener("load", () => setTimeout(syncInstallPromptButton, 300));
}

if (window.AppI18nTime) {
  if (localeSelect) {
    localeSelect.value = window.AppI18nTime.getLocale();
    localeSelect.addEventListener("change", () => {
      window.AppI18nTime.setLocale(localeSelect.value);
      applyFilters(currentSourceEvents);
    });
  }

  if (timezoneSelect) {
    timezoneSelect.value = window.AppI18nTime.getTimeZone();
    timezoneSelect.addEventListener("change", () => {
      window.AppI18nTime.setTimeZone(timezoneSelect.value);
      applyFilters(currentSourceEvents);
    });
  }
}

window.addEventListener("load", syncNavOffsetVar);
window.addEventListener("resize", syncNavOffsetVar);
setTimeout(syncNavOffsetVar, 450);

syncCategoryControls("all");
loadEvents();
