(() => {
  const STYLE_ID = "evenix-footer-styles";
  const FOOTER_ID = "evenix-shared-footer";
  const CONSENT_ID = "evenix-cookie-consent";
  const CONSENT_KEY = "evenix_cookie_consent_v1";
  const OPTIONAL_LOCAL_KEYS = ["viewer_id", "ticketDraft", "app_locale", "app_timezone"];
  const OPTIONAL_SESSION_KEYS = ["navPulseSeen"];

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .ex-footer-wrap {
        width: min(1180px, calc(100% - 32px));
        margin: 32px auto 24px;
        font-family: "DM Sans", sans-serif;
      }
      .ex-footer {
        border: 1px solid rgba(255,255,255,0.07);
        border-radius: 24px;
        background: linear-gradient(180deg, rgba(13,17,23,0.96), rgba(13,17,23,0.9));
        box-shadow: 0 22px 48px rgba(0,0,0,0.22);
        padding: 24px;
        color: #f0f2f8;
      }
      .ex-footer-grid {
        display: grid;
        grid-template-columns: 1.2fr 1fr 1fr 1fr;
        gap: 18px;
      }
      .ex-footer-brand {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 12px;
      }
      .ex-footer-brand img {
        width: 42px;
        height: 42px;
        border-radius: 12px;
        object-fit: cover;
      }
      .ex-footer-name {
        display: block;
        font-size: 0.98rem;
        font-weight: 700;
        letter-spacing: -0.02em;
      }
      .ex-footer-tag {
        display: block;
        font-size: 0.74rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: #8892a4;
      }
      .ex-footer-copy,
      .ex-footer-list a,
      .ex-footer-list span {
        color: #94a3b8;
        font-size: 0.92rem;
        line-height: 1.65;
      }
      .ex-footer-title {
        margin: 0 0 10px;
        font-size: 0.76rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: #8892a4;
      }
      .ex-footer-list {
        display: grid;
        gap: 8px;
      }
      .ex-footer a {
        text-decoration: none;
        transition: color 0.15s ease;
      }
      .ex-footer a:hover {
        color: #f0f2f8;
      }
      .ex-footer-bottom {
        margin-top: 18px;
        padding-top: 14px;
        border-top: 1px solid rgba(255,255,255,0.06);
        display: flex;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
        color: #64748b;
        font-size: 0.84rem;
      }
      .ex-footer-link-btn {
        border: 0;
        padding: 0;
        background: transparent;
        color: #94a3b8;
        cursor: pointer;
        font: inherit;
      }
      .ex-footer-link-btn:hover {
        color: #f0f2f8;
      }
      .ex-consent {
        position: fixed;
        left: 16px;
        right: 16px;
        bottom: 16px;
        z-index: 720;
        display: grid;
        gap: 14px;
        padding: 18px;
        border-radius: 22px;
        border: 1px solid rgba(255,255,255,0.08);
        background: rgba(13,17,23,0.96);
        box-shadow: 0 26px 56px rgba(0,0,0,0.38);
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        color: #f0f2f8;
      }
      .ex-consent[hidden] {
        display: none;
      }
      .ex-consent-title {
        margin: 0;
        font-size: 1rem;
        font-weight: 700;
      }
      .ex-consent-copy {
        margin: 8px 0 0;
        color: #94a3b8;
        font-size: 0.92rem;
        line-height: 1.65;
        max-width: 70ch;
      }
      .ex-consent-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      .ex-consent-btn {
        min-height: 42px;
        border-radius: 12px;
        border: 1px solid rgba(255,255,255,0.08);
        background: rgba(255,255,255,0.03);
        color: #f0f2f8;
        padding: 0 16px;
        font: inherit;
        font-weight: 500;
        cursor: pointer;
        transition: transform 0.15s ease, border-color 0.15s ease, background 0.15s ease;
      }
      .ex-consent-btn:hover {
        transform: translateY(-1px);
        border-color: rgba(124,106,247,0.3);
        background: rgba(255,255,255,0.05);
      }
      .ex-consent-btn-primary {
        background: #7c6af7;
        border-color: rgba(124,106,247,0.55);
        box-shadow: 0 0 20px rgba(124,106,247,0.16);
      }
      .ex-consent-meta {
        color: #64748b;
        font-size: 0.8rem;
        line-height: 1.6;
      }
      @media (max-width: 900px) {
        .ex-footer-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
      @media (max-width: 640px) {
        .ex-footer-wrap {
          width: min(100%, calc(100% - 20px));
        }
        .ex-footer {
          padding: 20px;
          border-radius: 20px;
        }
        .ex-footer-grid {
          grid-template-columns: 1fr;
        }
        .ex-consent {
          left: 10px;
          right: 10px;
          bottom: 10px;
          padding: 16px;
          border-radius: 18px;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function readConsent() {
    try {
      return JSON.parse(localStorage.getItem(CONSENT_KEY) || "null");
    } catch {
      return null;
    }
  }

  function hasConsentDecision() {
    const value = readConsent();
    return Boolean(value && (value.choice === "accepted" || value.choice === "rejected"));
  }

  function clearOptionalStorage() {
    try {
      OPTIONAL_LOCAL_KEYS.forEach((key) => localStorage.removeItem(key));
    } catch {}
    try {
      OPTIONAL_SESSION_KEYS.forEach((key) => sessionStorage.removeItem(key));
    } catch {}
  }

  function openConsentBanner() {
    const banner = document.getElementById(CONSENT_ID);
    if (banner) banner.hidden = false;
  }

  function updateConsentApi() {
    window.EvenixConsent = {
      get: () => readConsent(),
      hasOptional: () => readConsent()?.choice === "accepted",
      open: openConsentBanner
    };
  }

  function saveConsent(choice) {
    const payload = {
      choice,
      analytics: choice === "accepted",
      personalization: choice === "accepted",
      updatedAt: new Date().toISOString()
    };
    localStorage.setItem(CONSENT_KEY, JSON.stringify(payload));
    if (choice === "rejected") clearOptionalStorage();
    updateConsentApi();
    window.dispatchEvent(new CustomEvent("evenix-consent-changed", { detail: payload }));
  }

  function createFooter() {
    if (document.getElementById(FOOTER_ID)) return;
    const wrap = document.createElement("div");
    wrap.className = "ex-footer-wrap";
    wrap.id = FOOTER_ID;
    wrap.innerHTML = `
      <footer class="ex-footer">
        <div class="ex-footer-grid">
          <section>
            <div class="ex-footer-brand">
              <img src="/assets/web-logo.png" alt="Evenix">
              <div>
                <span class="ex-footer-name">Evenix</span>
                <span class="ex-footer-tag">Discover · Book · Attend</span>
              </div>
            </div>
            <p class="ex-footer-copy">A modern event platform for discovery, booking, organizer operations, attendee passes, notifications, and analytics.</p>
          </section>
          <section>
            <h2 class="ex-footer-title">Explore</h2>
            <div class="ex-footer-list">
              <a href="/">Home</a>
              <a href="/book.html">Book Events</a>
              <a href="/ticketing.html">Ticketing</a>
              <a href="/blog.html">Blog</a>
            </div>
          </section>
          <section>
            <h2 class="ex-footer-title">Platform</h2>
            <div class="ex-footer-list">
              <a href="/contact.html">Contact & FAQ</a>
              <a href="/profile.html">Profile</a>
              <a href="/admin.html">Admin Dashboard</a>
              <a href="/organizer-tools.html">Organizer Tools</a>
            </div>
          </section>
          <section>
            <h2 class="ex-footer-title">Contact</h2>
            <div class="ex-footer-list">
              <a href="mailto:suneeltimani@gmail.com">suneeltimani@gmail.com</a>
              <span>Evenix workflows, reminders, and attendee operations.</span>
            </div>
          </section>
        </div>
        <div class="ex-footer-bottom">
          <span>© <span id="exFooterYear"></span> Evenix. All rights reserved.</span>
          <span>Built for event discovery, booking, and operations. <button type="button" id="exConsentOpen" class="ex-footer-link-btn">Cookie settings</button></span>
        </div>
      </footer>
    `;
    document.body.appendChild(wrap);
    const yearEl = wrap.querySelector("#exFooterYear");
    if (yearEl) yearEl.textContent = String(new Date().getFullYear());
    const consentBtn = wrap.querySelector("#exConsentOpen");
    if (consentBtn) consentBtn.addEventListener("click", openConsentBanner);
  }

  function createConsentBanner() {
    if (document.getElementById(CONSENT_ID)) return;
    const banner = document.createElement("div");
    banner.id = CONSENT_ID;
    banner.className = "ex-consent";
    banner.hidden = hasConsentDecision();
    banner.innerHTML = `
      <div>
        <p class="ex-consent-title">We use cookies and local storage to keep Evenix working well.</p>
        <p class="ex-consent-copy">Essential cookies keep sign-in and security working. Optional storage helps with things like saved preferences and event reminders on this device. You can accept or reject optional storage.</p>
      </div>
      <div class="ex-consent-actions">
        <button type="button" class="ex-consent-btn ex-consent-btn-primary" data-consent-choice="accepted">Accept</button>
        <button type="button" class="ex-consent-btn" data-consent-choice="rejected">Reject optional</button>
      </div>
      <div class="ex-consent-meta">Essential authentication and security cookies stay enabled either way.</div>
    `;
    banner.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-consent-choice]");
      if (!btn) return;
      saveConsent(btn.getAttribute("data-consent-choice"));
      banner.hidden = true;
    });
    document.body.appendChild(banner);
  }

  function init() {
    injectStyles();
    updateConsentApi();
    createFooter();
    createConsentBanner();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
