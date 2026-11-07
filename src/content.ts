/* X Feed Filter - extension-context script.
 *
 * Does NOT touch the timeline DOM. The filtering itself happens in
 * inject.ts (page context), which removes non-matching posts from X's
 * HomeTimeline response before X renders them. This script only:
 *   1. reads the settings from chrome.storage.sync and sends them to
 *      inject.ts (chrome.storage is not available in the page context),
 *   2. shows a small counter badge on /home that also toggles the filter.
 *
 * Depends on keywords.ts (injected first) for DEFAULT_KEYWORDS,
 * SETTINGS_KEYS and resolveKeywords.
 */
(function () {
  "use strict";

  const TO_PAGE = "xff-content";
  const FROM_PAGE = "xff-page";
  const BADGE_ID = "xff-badge";

  const state = {
    enabled: true,
    keywords: DEFAULT_KEYWORDS.slice() as string[],
    kept: 0,
    removed: 0
  };

  /* ---- extension-context lifecycle ---- */

  // After the extension is reloaded or updated, this old script loses its
  // connection to the extension. Detect that and stop quietly.
  function extensionAlive(): boolean {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  let tick: ReturnType<typeof setInterval> | null = null;
  function shutdown(): void {
    if (tick) { clearInterval(tick); tick = null; }
    const b = document.getElementById(BADGE_ID);
    if (b) b.remove();
  }

  /* ---- settings -> page ---- */

  function sendConfig(): void {
    window.postMessage(
      { source: TO_PAGE, type: "config", enabled: state.enabled, keywords: state.keywords },
      location.origin
    );
  }

  function applySettings(res: StoredSettings): void {
    if (typeof res.enabled === "boolean") state.enabled = res.enabled;
    else state.enabled = true;
    state.keywords = resolveKeywords(res);
    sendConfig();
    updateBadge();
  }

  function loadSettings(): void {
    if (!extensionAlive()) return;
    try {
      chrome.storage.sync.get(SETTINGS_KEYS, (items) => applySettings(items as StoredSettings));
    } catch (e) { shutdown(); }
  }

  loadSettings();

  try {
    chrome.storage.onChanged.addListener((_changes, area) => {
      if (area !== "sync") return;
      loadSettings();
    });
  } catch (e) { /* context already gone */ }

  /* ---- page -> script (stats, and a request for settings) ---- */

  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window) return;
    const d = event.data as { source?: string; type?: string; kept?: number; removed?: number } | null;
    if (!d || d.source !== FROM_PAGE) return;
    if (d.type === "need-config") {
      sendConfig();
    } else if (d.type === "stats") {
      state.kept = Number(d.kept) || 0;
      state.removed = Number(d.removed) || 0;
      updateBadge();
    }
  });

  /* ---- badge ---- */

  function onHome(): boolean {
    return location.pathname === "/home";
  }

  function ensureBadge(): HTMLElement | null {
    let el = document.getElementById(BADGE_ID);
    if (el || !document.body) return el;
    el = document.createElement("div");
    el.id = BADGE_ID;
    el.setAttribute("role", "button");
    el.style.cssText =
      "position:fixed;bottom:16px;right:14px;z-index:2147483647;" +
      "background:#0d1b2a;color:#4fa3ff;font:600 12px/1 system-ui,sans-serif;" +
      "padding:9px 13px;border-radius:20px;box-shadow:0 2px 12px rgba(0,0,0,.45);" +
      "cursor:pointer;user-select:none;opacity:.94";
    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!extensionAlive()) return;
      // The filter works on data as it loads, so reload to apply the change
      // to the feed that is already on screen.
      try {
        chrome.storage.sync.set({ enabled: !state.enabled }, () => location.reload());
      } catch (err) { shutdown(); }
    }, true);
    document.body.appendChild(el);
    return el;
  }

  function updateBadge(): void {
    const el = ensureBadge();
    if (!el) return;
    el.style.display = onHome() ? "" : "none";
    el.title = state.enabled
      ? "Click to turn the feed filter off (reloads the page)"
      : "Click to turn the feed filter on (reloads the page)";
    el.textContent = state.enabled
      ? `Feed filter \u00b7 ${state.kept} shown \u00b7 ${state.removed} removed`
      : "Feed filter off";
    el.style.background = state.enabled ? "#0d1b2a" : "#3a2a2a";
    el.style.color = state.enabled ? "#4fa3ff" : "#ffb74d";
  }

  // X is a single-page app: the badge only needs to appear once <body> exists
  // and follow the URL between /home and other pages. This reads only
  // location and one element id, so it costs nothing.
  tick = setInterval(() => {
    if (!extensionAlive()) { shutdown(); return; }
    updateBadge();
  }, 500);
})();
