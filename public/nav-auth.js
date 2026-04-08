
(() => {
  const STYLE_ID = "eventarc-nav-styles";
  const HOST_SELECTOR = "[data-role-nav]";
  const AUTH_PAGES = new Set(["/login.html", "/signup.html", "/verify-otp.html", "/verify-signup-otp.html"]);
  const NOTIFICATION_WINDOW_MS = 24 * 60 * 60 * 1000;
  const path = window.location.pathname || "/";

  const state = {
    host: null,
    user: null,
    token: null,
    notifications: [],
    notificationsUnread: false,
    renderKey: 0,
    outsideHandler: null,
    keyHandler: null,
    restoreFocus: null,
    overlayOpen: false,
    scrollTicking: false,
    retryScheduled: false,
    navEl: null
  };

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      :root {
        --nav-bg: rgba(8, 11, 20, 0.82);
        --nav-border: rgba(255, 255, 255, 0.07);
        --nav-blur: blur(24px);
        --nav-radius: 20px;
        --brand-primary: #7C6AF7;
        --brand-accent: #F59E0B;
        --font-body: 'DM Sans', sans-serif;
        --font-display: 'Instrument Serif', serif;
        --text-primary: #F0F2F8;
        --text-secondary: #8892A4;
        --rose: #FCA5A5;
        --focus-ring: 0 0 0 2px rgba(124, 106, 247, 0.95), 0 0 0 5px rgba(124, 106, 247, 0.2);
      }
      [data-role-nav] {
        position: sticky;
        top: 16px;
        z-index: 500;
        width: min(1200px, calc(100% - 32px));
        margin: 16px auto 0;
        display: block;
        min-height: 64px;
        font-family: var(--font-body);
        isolation: isolate;
      }
      .ea-nav {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 18px;
        min-height: 64px;
        padding: 11px 16px;
        border: 1px solid var(--nav-border);
        border-radius: var(--nav-radius);
        background: var(--nav-bg);
        backdrop-filter: var(--nav-blur);
        -webkit-backdrop-filter: var(--nav-blur);
        box-shadow: 0 4px 24px rgba(0,0,0,0.2);
        transition: border-color 180ms ease, box-shadow 180ms ease, background 180ms ease, opacity 180ms ease;
        color: var(--text-primary);
      }
      .ea-nav[data-scrolled="true"] {
        border-color: rgba(124, 106, 247, 0.25);
        box-shadow: 0 8px 32px rgba(0,0,0,0.4), 0 0 0 1px rgba(124,106,247,0.1);
      }
      .ea-nav *, .ea-nav-mobile *, .ea-nav-popover * { box-sizing: border-box; }
      .ea-nav a, .ea-nav button, .ea-nav-mobile a, .ea-nav-mobile button, .ea-nav-popover a, .ea-nav-popover button { font: inherit; }
      .ea-nav a { text-decoration: none; }
      .ea-nav-logo {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        min-width: 0;
        color: var(--text-primary);
      }
      .ea-nav-logo:focus-visible,
      .ea-nav-link:focus-visible,
      .ea-nav-btn:focus-visible,
      .ea-nav-icon-btn:focus-visible,
      .ea-nav-menu-item:focus-visible,
      .ea-nav-mobile-link:focus-visible,
      .ea-nav-close:focus-visible {
        outline: none;
        box-shadow: var(--focus-ring);
      }
      .ea-nav-logo-img { width: 40px; height: 40px; border-radius: 12px; object-fit: cover; flex: 0 0 auto; }
      .ea-nav-logo-text { display: flex; flex-direction: column; min-width: 0; }
      .ea-nav-brand-name { display: block; font-size: 0.9375rem; font-weight: 600; letter-spacing: -0.02em; color: var(--text-primary); }
      .ea-nav-brand-sub { display: block; font-size: 0.6875rem; color: var(--text-secondary); letter-spacing: 0.04em; text-transform: uppercase; }
      .ea-nav-left, .ea-nav-right, .ea-nav-links, .ea-nav-actions { display: flex; align-items: center; }
      .ea-nav-left { gap: 22px; min-width: 0; }
      .ea-nav-links { gap: 4px; }
      .ea-nav-right { gap: 12px; margin-left: auto; }
      .ea-nav-actions { gap: 10px; }
      .ea-nav-link {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 40px;
        padding: 0 12px;
        border-radius: 10px;
        color: var(--text-secondary);
        transition: color 150ms ease, background 150ms ease;
      }
      .ea-nav-link:hover { color: var(--text-primary); background: rgba(255,255,255,0.03); }
      .ea-nav-link[aria-current="page"] { color: var(--text-primary); }
      .ea-nav-link[aria-current="page"]::after,
      .ea-nav-mobile-link[aria-current="page"]::after {
        content: "";
        position: absolute;
        left: 50%;
        bottom: 6px;
        width: 6px;
        height: 6px;
        border-radius: 999px;
        transform: translateX(-50%);
        background: var(--brand-primary);
        opacity: 0;
        animation: eaDotIn 180ms ease forwards;
      }
      @keyframes eaDotIn {
        from { opacity: 0; transform: translateX(-50%) translateY(3px); }
        to { opacity: 1; transform: translateX(-50%) translateY(0); }
      }
      .ea-nav-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        min-height: 40px;
        padding: 0 16px;
        border-radius: 12px;
        border: 1px solid rgba(255,255,255,0.1);
        background: transparent;
        color: var(--text-primary);
        cursor: pointer;
        transition: transform 150ms ease, border-color 150ms ease, background 150ms ease, box-shadow 150ms ease, color 150ms ease;
      }
      .ea-nav-btn:hover { background: rgba(255,255,255,0.04); border-color: rgba(124,106,247,0.28); transform: translateY(-1px); }
      .ea-nav-btn-primary { background: var(--brand-primary); border-color: rgba(124,106,247,0.55); color: #fff; box-shadow: 0 0 20px rgba(124, 106, 247, 0.15); }
      .ea-nav-btn-primary:hover { background: #6f5cf3; border-color: rgba(124,106,247,0.8); }
      .ea-nav-badge { display: inline-flex; align-items: center; min-height: 26px; padding: 0 10px; border-radius: 999px; border: 1px solid rgba(124,106,247,0.28); background: rgba(124,106,247,0.14); color: #c4b5fd; font-size: 0.75rem; font-weight: 600; }
      .ea-nav-badge[data-plan="free"] { border-color: rgba(255,255,255,0.1); background: rgba(255,255,255,0.06); color: #d6deee; }
      .ea-nav-badge[data-plan="pro"] { border-color: rgba(245,158,11,0.32); background: rgba(245,158,11,0.14); color: #fcd34d; box-shadow: 0 0 0 1px rgba(245,158,11,0.08); }
      .ea-nav-icon-btn { position: relative; width: 40px; height: 40px; display: inline-flex; align-items: center; justify-content: center; border-radius: 12px; border: 1px solid rgba(255,255,255,0.08); background: transparent; color: var(--text-primary); cursor: pointer; transition: transform 150ms ease, border-color 150ms ease, background 150ms ease; }
      .ea-nav-icon-btn:hover { background: rgba(255,255,255,0.05); border-color: rgba(124,106,247,0.28); transform: translateY(-1px); }
      .ea-nav-dot { position: absolute; top: 8px; right: 8px; width: 9px; height: 9px; border-radius: 999px; background: var(--brand-accent); box-shadow: 0 0 0 3px rgba(245,158,11,0.12); }
      .ea-nav-dot[data-pulse="true"] { animation: eaPulse 1.8s ease-in-out infinite; }
      @keyframes eaPulse { 0%, 100% { transform: scale(1); opacity: 0.95; } 50% { transform: scale(1.18); opacity: 1; } }
      .ea-nav-avatar { width: 36px; height: 36px; border-radius: 999px; object-fit: cover; border: 2px solid rgba(124, 106, 247, 0.4); transition: border-color 0.2s; display: block; }
      .ea-nav-avatar:hover { border-color: rgba(124, 106, 247, 0.8); }
      .ea-nav-avatar-btn[data-pulse="true"] .ea-nav-avatar { animation: eaAvatarPulse 2s ease-out 1; }
      @keyframes eaAvatarPulse { 0% { box-shadow: 0 0 0 0 rgba(124,106,247,0.35); } 100% { box-shadow: 0 0 0 14px rgba(124,106,247,0); } }
      .ea-nav-popover { position: absolute; top: calc(100% + 10px); right: 0; width: 240px; padding: 8px; border-radius: 16px; background: rgba(13, 17, 23, 0.96); backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px); border: 1px solid rgba(255,255,255,0.08); box-shadow: 0 24px 48px rgba(0,0,0,0.45); opacity: 0; transform: scale(0.95) translateY(-4px); transform-origin: top right; pointer-events: none; transition: opacity 120ms cubic-bezier(0.2, 0.8, 0.2, 1), transform 120ms cubic-bezier(0.2, 0.8, 0.2, 1); z-index: 650; }
      .ea-nav-popover[data-width="220"] { width: 220px; }
      .ea-nav-popover.is-open { opacity: 1; transform: scale(1) translateY(0); pointer-events: auto; }
      .ea-nav-popover-header { display: flex; gap: 10px; align-items: center; padding: 10px 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.06); margin-bottom: 6px; }
      .ea-nav-popover-header-copy { min-width: 0; }
      .ea-nav-popover-title { color: var(--text-primary); font-size: 0.875rem; font-weight: 600; line-height: 1.2; }
      .ea-nav-popover-subtitle { color: var(--text-secondary); font-size: 0.75rem; line-height: 1.3; word-break: break-word; }
      .ea-nav-popover-section-title { color: var(--text-secondary); font-size: 0.75rem; font-weight: 600; padding: 8px 10px 6px; text-transform: uppercase; letter-spacing: 0.06em; }
      .ea-nav-menu-item { width: 100%; min-height: 44px; border: 0; background: transparent; display: flex; align-items: center; gap: 10px; border-radius: 12px; padding: 0 10px; color: var(--text-primary); cursor: pointer; text-align: left; }
      .ea-nav-menu-item:hover { background: rgba(255,255,255,0.05); }
      .ea-nav-menu-item[data-tone="danger"] { color: var(--rose); }
      .ea-nav-divider { height: 1px; margin: 6px 4px; background: rgba(255,255,255,0.06); }
      .ea-nav-menu-note { padding: 14px 10px; color: var(--text-secondary); font-size: 0.875rem; line-height: 1.4; }
      .ea-nav-notification-item { display: grid; grid-template-columns: 18px 1fr; gap: 10px; padding: 10px; border-radius: 12px; color: var(--text-primary); text-decoration: none; }
      .ea-nav-notification-item:hover { background: rgba(255,255,255,0.05); }
      .ea-nav-notification-title { display: block; font-size: 0.84rem; line-height: 1.3; }
      .ea-nav-notification-time { display: block; margin-top: 2px; font-size: 0.74rem; color: var(--text-secondary); }
      .ea-nav-popover-footer { display: flex; justify-content: flex-end; padding: 6px 10px 2px; }
      .ea-nav-inline-link { color: #c4b5fd; font-size: 0.8rem; text-decoration: none; }
      .ea-nav-inline-link:hover { color: #ddd6fe; }
      .ea-nav-mobile-trigger { display: none; }
      .ea-nav-mobile-overlay { position: fixed; inset: 0; z-index: 110; background: rgba(8, 11, 20, 0.72); backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px); opacity: 0; pointer-events: none; transition: opacity 160ms ease; }
      .ea-nav-mobile-overlay.is-open { opacity: 1; pointer-events: auto; }
      .ea-nav-mobile { position: absolute; inset: 0; display: flex; flex-direction: column; padding: 22px 16px 18px; color: var(--text-primary); }
      .ea-nav-mobile-top { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
      .ea-nav-close { width: 44px; height: 44px; border-radius: 14px; border: 1px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.03); color: var(--text-primary); cursor: pointer; }
      .ea-nav-mobile-links { display: grid; gap: 8px; margin-top: 28px; }
      .ea-nav-mobile-link { position: relative; min-height: 56px; display: flex; align-items: center; justify-content: space-between; padding: 0 16px; border-radius: 16px; color: var(--text-primary); background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); text-decoration: none; opacity: 0; transform: translateY(8px); animation: eaMobileLinkIn 220ms ease forwards; }
      .ea-nav-mobile-link:hover { background: rgba(255,255,255,0.06); }
      @keyframes eaMobileLinkIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
      .ea-nav-mobile-footer { margin-top: auto; display: grid; gap: 14px; }
      .ea-nav-mobile-user { display: flex; align-items: center; gap: 12px; padding: 14px; border-radius: 18px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06); }
      .ea-nav-mobile-user-copy { min-width: 0; }
      .ea-nav-mobile-user-name { font-weight: 600; color: var(--text-primary); }
      .ea-nav-mobile-user-email { color: var(--text-secondary); font-size: 0.84rem; word-break: break-word; }
      .ea-nav-mobile-actions { display: flex; gap: 10px; flex-wrap: wrap; }
      .ea-nav-mobile-logout { width: 100%; min-height: 52px; border-radius: 16px; border: 1px solid rgba(252,165,165,0.24); background: rgba(127,29,29,0.15); color: var(--rose); }
      .ea-nav-skeleton-wrap { display: flex; align-items: center; justify-content: space-between; gap: 16px; width: 100%; }
      .ea-nav-skeleton-stack, .ea-nav-skeleton-row { display: flex; align-items: center; gap: 10px; }
      @keyframes shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
      .ea-nav-skeleton { background: linear-gradient(90deg, rgba(255,255,255,0.03), rgba(255,255,255,0.08), rgba(255,255,255,0.03)); background-size: 200% 100%; animation: shimmer 1.4s linear infinite; border-radius: 8px; }
      .ea-nav-skeleton-logo { width: 40px; height: 40px; border-radius: 12px; }
      .ea-nav-skeleton-pill { height: 14px; width: 92px; border-radius: 999px; }
      .ea-nav-skeleton-btn { height: 40px; width: 108px; border-radius: 12px; }
      .ea-nav-skeleton-avatar { width: 36px; height: 36px; border-radius: 999px; }
      .ea-nav-fade { animation: eaFade 180ms ease; }
      @keyframes eaFade { from { opacity: 0; transform: translateY(-2px); } to { opacity: 1; transform: translateY(0); } }
      @media (max-width: 767.98px) {
        [data-role-nav] { min-height: 56px; }
        .ea-nav { min-height: 56px; padding: 8px 12px; }
        .ea-nav-links { display: none; }
        .ea-nav-mobile-trigger { display: inline-flex; }
        .ea-nav-right { gap: 8px; }
        .ea-nav-logo-img { width: 36px; height: 36px; border-radius: 10px; }
        .ea-nav-brand-sub { display: none; }
        .ea-nav-btn { min-height: 38px; padding: 0 14px; }
        .ea-nav-icon-btn { width: 38px; height: 38px; }
      }
      @media (max-width: 520px) {
        .ea-nav-logo { min-width: 0; }
        .ea-nav-brand-name { font-size: 0.88rem; }
      }
    `;
    document.head.appendChild(style);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function initialsAvatar(name) {
    return `https://ui-avatars.com/api/?name=${encodeURIComponent(name || "User")}&background=7C6AF7&color=fff&size=72`;
  }

  function authHeaders(token = state.token) {
    return token ? { Authorization: token } : {};
  }

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const nowTs = () => Date.now();
  const avatarSrc = (user) => user?.profileImage || initialsAvatar(user?.name || "User");

  function icon(name) {
    const icons = {
      menu: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
      close: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>',
      bell: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 20a1.94 1.94 0 0 0 3.4 0"/></svg>',
      dashboard: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="5" rx="2"/><rect x="13" y="10" width="8" height="11" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/></svg>',
      ticket: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 9a2 2 0 0 0 0 6v3a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-3a2 2 0 0 0 0-6V6a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1z"/><path d="M13 5v14"/></svg>',
      save: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/></svg>',
      settings: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 2v2.5M12 19.5V22M4.93 4.93l1.77 1.77M17.3 17.3l1.77 1.77M2 12h2.5M19.5 12H22M4.93 19.07l1.77-1.77M17.3 6.7l1.77-1.77"/><circle cx="12" cy="12" r="4"/></svg>',
      logout: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></svg>',
      create: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
      tools: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-3 3-3-3z"/></svg>',
      user: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M20 21a8 8 0 1 0-16 0"/><circle cx="12" cy="7" r="4"/></svg>',
      chevron: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
      reminder: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 8v4l3 2"/><circle cx="12" cy="12" r="9"/></svg>'
    };
    return icons[name] || "";
  }

  function isActive(href) {
    if (href === "/" && (path === "/" || path === "/index.html")) return true;
    const normalizedHref = href.replace(".html", "");
    const normalizedPath = path.replace(".html", "");
    if (href !== "/" && normalizedPath.startsWith(normalizedHref) && normalizedHref !== "") return true;
    return path === href || normalizedPath === normalizedHref;
  }

  function formatRelative(dateValue) {
    const target = new Date(dateValue).getTime();
    if (!Number.isFinite(target)) return "Soon";
    const diff = target - nowTs();
    const minutes = Math.round(diff / 60000);
    if (minutes <= 0) return "Starting soon";
    if (minutes < 60) return `In ${minutes}m`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `In ${hours}h`;
    const days = Math.round(hours / 24);
    return `In ${days}d`;
  }

  function renderSkeleton() {
    state.host.innerHTML = '<div class="ea-nav" aria-busy="true" aria-live="polite"><div class="ea-nav-skeleton-wrap"><div class="ea-nav-skeleton-stack"><div class="ea-nav-skeleton ea-nav-skeleton-logo"></div><div class="ea-nav-skeleton-row"><div class="ea-nav-skeleton ea-nav-skeleton-pill"></div><div class="ea-nav-skeleton ea-nav-skeleton-pill"></div><div class="ea-nav-skeleton ea-nav-skeleton-pill"></div></div></div><div class="ea-nav-skeleton-row"><div class="ea-nav-skeleton ea-nav-skeleton-btn"></div><div class="ea-nav-skeleton ea-nav-skeleton-avatar"></div></div></div></div>';
  }

  function baseLogo() {
    return '<a href="/" class="ea-nav-logo" aria-label="Evenix home"><img src="/assets/web-logo.png" alt="" class="ea-nav-logo-img" aria-hidden="true"><div class="ea-nav-logo-text"><span class="ea-nav-brand-name">Evenix</span><span class="ea-nav-brand-sub">Discover ? Book ? Attend</span></div></a>';
  }

  function resolveMinimalContext() {
    if (path === "/login.html") return { href: "/signup.html", label: "Sign Up" };
    if (path === "/signup.html") return { href: "/login.html", label: "Login" };
    return null;
  }
  function getDesktopLinks(role) {
    if (role === "admin") return [{ href: "/", label: "Home" }, { href: "/book.html", label: "Events" }, { href: "/admin.html", label: "Admin Dashboard" }, { href: "/create-event.html", label: "Create Event" }];
    if (role === "user") return [{ href: "/", label: "Home" }, { href: "/book.html", label: "Events" }, { href: "/user.html", label: "My Bookings" }, { href: "/user.html#saved", label: "Saved" }];
    return [{ href: "/", label: "Home" }, { href: "/book.html", label: "Events" }, { href: "/contact.html", label: "How it Works" }];
  }

  function getMobileLinks(role) {
    const base = getDesktopLinks(role);
    if (role === "guest") return base;
    if (role === "admin") return [...base, { href: "/admin-bookings.html", label: "All Bookings" }, { href: "/organizer-tools.html", label: "Organizer Tools" }];
    return [...base, { href: "/profile.html", label: "Profile" }];
  }

  function renderLinks(links, mobile = false) {
    return links.map((link, index) => {
      const current = isActive(link.href);
      const cls = mobile ? "ea-nav-mobile-link" : "ea-nav-link";
      const style = mobile ? ` style="animation-delay:${index * 50}ms"` : "";
      return `<a href="${link.href}" class="${cls}"${current ? ' aria-current="page"' : ""}${style}>${escapeHtml(link.label)}${mobile ? icon("chevron") : ""}</a>`;
    }).join("");
  }

  function renderMinimalNav() {
    const ctx = resolveMinimalContext();
    state.host.innerHTML = `<div class="ea-nav ea-nav-fade" data-scrolled="false"><div class="ea-nav-left">${baseLogo()}</div><div class="ea-nav-right">${ctx ? `<a href="${ctx.href}" class="ea-nav-btn">${escapeHtml(ctx.label)}</a>` : ""}</div></div>`;
    state.navEl = state.host.querySelector(".ea-nav");
    bindScrollState();
  }

  function renderNotificationItems() {
    if (!state.notifications.length) return '<div class="ea-nav-menu-note">You&apos;re all caught up ?</div>';
    return state.notifications.slice(0, 4).map((item) => `<a class="ea-nav-notification-item" href="/event-details.html?id=${encodeURIComponent(item.id)}" role="menuitem"><span>${icon("reminder")}</span><span><span class="ea-nav-notification-title">${escapeHtml(item.title)}</span><span class="ea-nav-notification-time">${escapeHtml(item.time)}</span></span></a>`).join("");
  }

  function renderUserMenu(user) {
    const admin = user?.role === "admin";
    const items = admin
      ? `<a class="ea-nav-menu-item" href="/admin.html" role="menuitem">${icon("dashboard")}<span>Admin Dashboard</span></a><a class="ea-nav-menu-item" href="/create-event.html" role="menuitem">${icon("create")}<span>Create Event</span></a><a class="ea-nav-menu-item" href="/admin-bookings.html" role="menuitem">${icon("ticket")}<span>All Bookings</span></a><a class="ea-nav-menu-item" href="/organizer-tools.html" role="menuitem">${icon("tools")}<span>Organizer Tools</span></a><a class="ea-nav-menu-item" href="/profile.html#settings" role="menuitem">${icon("settings")}<span>Settings</span></a><div class="ea-nav-divider"></div><a class="ea-nav-menu-item" href="/user.html" role="menuitem">${icon("user")}<span>View as User</span></a>`
      : `<a class="ea-nav-menu-item" href="/user.html" role="menuitem">${icon("dashboard")}<span>My Dashboard</span></a><a class="ea-nav-menu-item" href="/user.html#bookings" role="menuitem">${icon("ticket")}<span>My Bookings</span></a><a class="ea-nav-menu-item" href="/user.html#saved" role="menuitem">${icon("save")}<span>Saved Events</span></a><a class="ea-nav-menu-item" href="/profile.html#settings" role="menuitem">${icon("settings")}<span>Settings</span></a>`;
    return `<div class="ea-nav-popover" id="eaUserMenu" role="menu" aria-label="User menu"><div class="ea-nav-popover-header"><img class="ea-nav-avatar" src="${avatarSrc(user)}" alt="${escapeHtml(user.name || "User")} avatar"><div class="ea-nav-popover-header-copy"><div class="ea-nav-popover-title">${escapeHtml(user.name || "User")}</div><div class="ea-nav-popover-subtitle">${escapeHtml(user.email || "")}${admin ? "<br>Administrator" : ""}</div></div></div>${items}<div class="ea-nav-divider"></div><button class="ea-nav-menu-item" type="button" data-nav-logout role="menuitem" data-tone="danger">${icon("logout")}<span>Logout</span></button></div>`;
  }

  function renderNotificationMenu() {
    return `<div class="ea-nav-popover" id="eaBellMenu" data-width="220" role="menu" aria-label="Notifications"><div class="ea-nav-popover-section-title">Notifications</div>${renderNotificationItems()}<div class="ea-nav-popover-footer"><a class="ea-nav-inline-link" href="/user.html#saved">View all</a></div></div>`;
  }

  function renderDesktopActions(user) {
    if (!user) {
      return `<div class="ea-nav-actions"><a href="/login.html" class="ea-nav-btn">Login</a><a href="/signup.html" class="ea-nav-btn ea-nav-btn-primary">Sign Up Free</a><button type="button" class="ea-nav-icon-btn ea-nav-mobile-trigger" aria-label="Open navigation" aria-expanded="false" data-nav-mobile-toggle>${icon("menu")}</button></div>`;
    }
    const showHomePlanBadge = user.role === "admin" && (path === "/" || path === "/index.html");
    const planLabel = user?.plan?.label || (user?.plan?.tier ? String(user.plan.tier).charAt(0).toUpperCase() + String(user.plan.tier).slice(1) : "");
    const adminBadge = user.role === "admin" ? '<span class="ea-nav-badge">Admin</span>' : "";
    const planTier = String(user?.plan?.tier || "").toLowerCase();
    const planBadge = showHomePlanBadge && planLabel ? `<span class="ea-nav-badge" data-plan="${escapeHtml(planTier)}">${escapeHtml(planLabel)}</span>` : "";
    return `<div class="ea-nav-actions">${adminBadge}${planBadge}<div style="position:relative"><button type="button" class="ea-nav-icon-btn" aria-label="Open notifications" aria-expanded="false" data-nav-bell>${icon("bell")}${state.notificationsUnread ? '<span class="ea-nav-dot" data-pulse="true" aria-hidden="true"></span>' : ""}</button>${renderNotificationMenu()}</div><div style="position:relative"><button type="button" class="ea-nav-icon-btn ea-nav-avatar-btn" aria-label="Open user menu" aria-expanded="false" data-nav-avatar data-pulse="${sessionStorage.getItem("navPulseSeen") ? "false" : "true"}"><img class="ea-nav-avatar" src="${avatarSrc(user)}" alt="${escapeHtml(user.name || "User")} avatar"></button>${renderUserMenu(user)}</div><button type="button" class="ea-nav-icon-btn ea-nav-mobile-trigger" aria-label="Open navigation" aria-expanded="false" data-nav-mobile-toggle>${icon("menu")}</button></div>`;
  }

  function renderMobileOverlay(user) {
    const role = user?.role || "guest";
    const userCard = user
      ? `<div class="ea-nav-mobile-user"><img class="ea-nav-avatar" src="${avatarSrc(user)}" alt="${escapeHtml(user.name || "User")} avatar"><div class="ea-nav-mobile-user-copy"><div class="ea-nav-mobile-user-name">${escapeHtml(user.name || "User")}</div><div class="ea-nav-mobile-user-email">${escapeHtml(user.email || "")}</div></div></div><button type="button" class="ea-nav-btn ea-nav-mobile-logout" data-nav-logout>${icon("logout")}<span>Logout</span></button>`
      : '<div class="ea-nav-mobile-actions"><a href="/login.html" class="ea-nav-btn">Login</a><a href="/signup.html" class="ea-nav-btn ea-nav-btn-primary">Sign Up Free</a></div>';
    return `<div class="ea-nav-mobile-overlay" data-nav-overlay hidden><div class="ea-nav-mobile" role="dialog" aria-modal="true" aria-label="Navigation menu"><div class="ea-nav-mobile-top">${baseLogo()}<button type="button" class="ea-nav-close" data-nav-close aria-label="Close navigation">${icon("close")}</button></div><div class="ea-nav-mobile-links">${renderLinks(getMobileLinks(role), true)}</div><div class="ea-nav-mobile-footer">${userCard}</div></div></div>`;
  }

  function renderFullNav(user) {
    state.host.innerHTML = `<div class="ea-nav ea-nav-fade" data-scrolled="false"><div class="ea-nav-left">${baseLogo()}<div class="ea-nav-links">${renderLinks(getDesktopLinks(user?.role || "guest"))}</div></div><div class="ea-nav-right">${renderDesktopActions(user)}</div></div>${renderMobileOverlay(user)}`;
    sessionStorage.setItem("navPulseSeen", "1");
    state.navEl = state.host.querySelector(".ea-nav");
    bindScrollState();
    bindInteractions();
  }

  async function getValidToken() {
    const token = localStorage.getItem("token");
    if (!token) return null;
    try {
      const meRes = await fetch("/api/auth/me", { headers: { Authorization: token } });
      if (meRes.ok) return token;
      if (meRes.status === 401) {
        const refreshRes = await fetch("/api/auth/refresh", { method: "POST", credentials: "include" });
        if (refreshRes.ok) {
          const headerToken = refreshRes.headers.get("X-Access-Token");
          let nextToken = headerToken || "";
          if (!nextToken) {
            try {
              const payload = await refreshRes.clone().json();
              nextToken = payload?.token || "";
            } catch {}
          }
          if (nextToken) {
            localStorage.setItem("token", nextToken);
            return nextToken;
          }
        }
        localStorage.removeItem("token");
        return null;
      }
      return token;
    } catch (err) {
      console.error("[nav-auth] token validation failed", err);
      return token;
    }
  }

  async function resolveAuth() {
    const token = await getValidToken();
    state.token = token;
    if (!token) return null;
    const meRes = await fetch("/api/auth/me", { headers: authHeaders(token) });
    if (!meRes.ok) throw new Error(`Auth me failed with ${meRes.status}`);
    return meRes.json();
  }

  async function loadNotifications() {
    if (!state.user || !state.token) {
      state.notifications = [];
      state.notificationsUnread = false;
      return;
    }
    try {
      const res = await fetch("/api/events/saved", { headers: authHeaders() });
      if (!res.ok) throw new Error(`Saved events failed with ${res.status}`);
      const saved = await res.json();
      const now = nowTs();
      const nextDay = now + NOTIFICATION_WINDOW_MS;
      state.notifications = (Array.isArray(saved) ? saved : [])
        .map((row) => {
          const event = row?.event || {};
          return {
            id: String(event._id || ""),
            title: event.title || "Upcoming event reminder",
            eventTime: new Date(event.date || "").getTime(),
            time: formatRelative(event.date)
          };
        })
        .filter((row) => row.id && Number.isFinite(row.eventTime) && row.eventTime >= now && row.eventTime <= nextDay)
        .sort((a, b) => a.eventTime - b.eventTime)
        .slice(0, 4);
      state.notificationsUnread = state.notifications.length > 0;
    } catch (err) {
      console.error("[nav-auth] notifications failed", err);
      state.notifications = [];
      state.notificationsUnread = false;
    }
  }
  async function logout() {
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include", headers: authHeaders() });
    } catch (err) {
      console.error("[nav-auth] logout failed", err);
    }
    localStorage.removeItem("token");
    state.token = null;
    state.user = null;
    state.notifications = [];
    state.notificationsUnread = false;
    document.dispatchEvent(new CustomEvent("auth:changed", { detail: { loggedIn: false } }));
    await render();
  }

  function closePopover(popover, trigger) {
    if (!popover) return;
    popover.classList.remove("is-open");
    if (trigger) trigger.setAttribute("aria-expanded", "false");
  }

  function openPopover(popover, trigger) {
    if (!popover) return;
    popover.classList.add("is-open");
    if (trigger) trigger.setAttribute("aria-expanded", "true");
  }

  function closeMenus() {
    closePopover(state.host.querySelector("#eaUserMenu"), state.host.querySelector("[data-nav-avatar]"));
    closePopover(state.host.querySelector("#eaBellMenu"), state.host.querySelector("[data-nav-bell]"));
  }

  function getFocusable(container) {
    return Array.from(container.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'));
  }

  function closeOverlay(returnFocus = true) {
    const overlay = state.host.querySelector("[data-nav-overlay]");
    const trigger = state.host.querySelector("[data-nav-mobile-toggle]");
    if (!overlay) return;
    overlay.classList.remove("is-open");
    overlay.hidden = true;
    state.overlayOpen = false;
    if (trigger) trigger.setAttribute("aria-expanded", "false");
    document.body.style.overflow = "";
    if (returnFocus && state.restoreFocus) state.restoreFocus.focus();
  }

  function openOverlay() {
    const overlay = state.host.querySelector("[data-nav-overlay]");
    const trigger = state.host.querySelector("[data-nav-mobile-toggle]");
    if (!overlay) return;
    state.restoreFocus = trigger;
    overlay.hidden = false;
    requestAnimationFrame(() => overlay.classList.add("is-open"));
    state.overlayOpen = true;
    if (trigger) trigger.setAttribute("aria-expanded", "true");
    document.body.style.overflow = "hidden";
    const focusables = getFocusable(overlay);
    if (focusables[0]) focusables[0].focus();
  }

  function bindScrollState() {
    if (!state.navEl) return;
    const applyState = () => state.navEl.setAttribute("data-scrolled", window.scrollY > 80 ? "true" : "false");
    applyState();
    if (state.host.dataset.navScrollBound === "true") return;
    state.host.dataset.navScrollBound = "true";
    window.addEventListener("scroll", () => {
      if (state.scrollTicking) return;
      state.scrollTicking = true;
      requestAnimationFrame(() => {
        state.scrollTicking = false;
        if (state.navEl) state.navEl.setAttribute("data-scrolled", window.scrollY > 80 ? "true" : "false");
      });
    }, { passive: true });
  }

  function bindInteractions() {
    if (state.outsideHandler) document.removeEventListener("click", state.outsideHandler, true);
    if (state.keyHandler) document.removeEventListener("keydown", state.keyHandler, true);

    const avatarBtn = state.host.querySelector("[data-nav-avatar]");
    const bellBtn = state.host.querySelector("[data-nav-bell]");
    const menu = state.host.querySelector("#eaUserMenu");
    const bell = state.host.querySelector("#eaBellMenu");
    const overlay = state.host.querySelector("[data-nav-overlay]");
    const mobileToggle = state.host.querySelector("[data-nav-mobile-toggle]");
    const closeBtn = state.host.querySelector("[data-nav-close]");

    avatarBtn?.addEventListener("click", (event) => {
      event.stopPropagation();
      const nextOpen = !menu.classList.contains("is-open");
      closeMenus();
      if (nextOpen) openPopover(menu, avatarBtn);
    });

    bellBtn?.addEventListener("click", (event) => {
      event.stopPropagation();
      const nextOpen = !bell.classList.contains("is-open");
      closeMenus();
      if (nextOpen) openPopover(bell, bellBtn);
    });

    mobileToggle?.addEventListener("click", () => { if (state.overlayOpen) closeOverlay(); else openOverlay(); });
    closeBtn?.addEventListener("click", () => closeOverlay());
    overlay?.addEventListener("click", (event) => { if (event.target === overlay) closeOverlay(); });

    state.host.querySelectorAll("[data-nav-logout]").forEach((btn) => btn.addEventListener("click", async () => {
      closeMenus();
      closeOverlay(false);
      await logout();
    }));

    state.host.querySelectorAll(".ea-nav-menu-item[href], .ea-nav-notification-item, .ea-nav-inline-link, .ea-nav-mobile-link").forEach((el) => el.addEventListener("click", () => {
      closeMenus();
      if (state.overlayOpen) closeOverlay(false);
    }));

    state.outsideHandler = (event) => { if (!state.host.contains(event.target)) closeMenus(); };
    document.addEventListener("click", state.outsideHandler, true);

    state.keyHandler = (event) => {
      if (event.key === "Escape") {
        closeMenus();
        if (state.overlayOpen) closeOverlay();
      }
      if (event.key === "Tab" && state.overlayOpen && overlay) {
        const focusables = getFocusable(overlay);
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", state.keyHandler, true);
  }

  async function render() {
    const renderKey = ++state.renderKey;
    renderSkeleton();
    try {
      const userPromise = resolveAuth();
      await delay(300);
      const user = await userPromise;
      if (renderKey !== state.renderKey) return;
      state.user = user;
      await loadNotifications();
      if (AUTH_PAGES.has(path)) renderMinimalNav(); else renderFullNav(user);
    } catch (err) {
      console.error("[nav-auth] render failed", err);
      state.user = null;
      state.token = null;
      state.notifications = [];
      state.notificationsUnread = false;
      localStorage.removeItem("token");
      if (AUTH_PAGES.has(path)) renderMinimalNav(); else renderFullNav(null);
      if (!state.retryScheduled) {
        state.retryScheduled = true;
        setTimeout(async () => {
          state.retryScheduled = false;
          await render();
        }, 3000);
      }
    }
  }

  function ensureHost() {
    state.host = document.querySelector(HOST_SELECTOR);
    return !!state.host;
  }

  async function boot() {
    if (!ensureHost()) return;
    injectStyles();
    await render();
    window.addEventListener("storage", async (event) => { if (event.key === "token") await render(); });
    document.addEventListener("auth:changed", async () => { await render(); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
