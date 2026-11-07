/* X Feed Filter (content script)
 * Hides "For You" timeline posts whose text doesn't match any of your
 * keywords. Ships with an aviation keyword preset by default.
 * State (on/off, mode, keyword list) lives in chrome.storage.sync.
 * Depends on keywords.ts (injected first) for DEFAULT_KEYWORDS,
 * SETTINGS_KEYS and resolveKeywords.
 *
 * Why this is written the way it is (two bugs it must avoid):
 *
 *  1. "The page scrolls around on its own."
 *     - We NEVER write scrollTop. An extension that moves the scroll fights
 *       X's virtualized timeline and throws the viewport around.
 *     - We also set `overflow-anchor: none` on the timeline. Browser scroll
 *       anchoring tries to "helpfully" keep content in place when the height
 *       of elements above the viewport changes. When we hide a row, that
 *       compensation is itself a scroll jump. Turning it off stops it.
 *
 *  2. "Opening a tweet's comments and closing it scrolls me somewhere else."
 *     - Opening a tweet navigates away from /home; X remembers the feed scroll
 *       offset and restores it when you go back. That restore only lands
 *       correctly if the feed's total height is the SAME as when you left.
 *     - So the moment we leave the For You feed we reveal every row (feed
 *       geometry returns to exactly what X expects) and stop touching the DOM.
 *       We only re-apply the filter once we're settled back on the feed.
 *
 * Hiding is done with a single injected CSS class, not per-element inline
 * styles, so toggling is cheap and does not thrash layout.
 */
(function () {
  "use strict";

  interface FilterState {
    enabled: boolean;
    fullyRemove: boolean; // false = dim, true = collapse to nothing
    keywords: string[];
    kept: number;
    hidden: number;
  }

  const state: FilterState = {
    enabled: true,
    fullyRemove: false,
    keywords: DEFAULT_KEYWORDS.slice(),
    kept: 0,
    hidden: 0
  };

  // Decision marker, placed on the timeline cell wrapper (not the <article>).
  const ATTR = "data-xff";
  const STYLE_ID = "xff-style";

  /* ---------------------------------------------------------------- *
   * Injected stylesheet                                               *
   * ---------------------------------------------------------------- */

  // All visual hiding lives here. `.xff-dim` fades a non-matching post but
  // leaves its box in place; `.xff-gone` collapses it. `overflow-anchor:none`
  // on the timeline stops the browser from auto-compensating the scroll when
  // our hiding changes heights.
  function ensureStyle(): void {
    const existing = document.getElementById(STYLE_ID);
    // `.xff-dim` blacks the post out completely while keeping its box in the
    // layout (so the scroll position stays stable). The inner content is made
    // invisible and a solid black fill is painted over the row. `.xff-gone`
    // collapses the row entirely ("Fully remove posts" mode).
    const css =
      '[data-testid="primaryColumn"] [aria-label] { overflow-anchor: none; }' +
      // Black the row out but keep its ORIGINAL height. Changing a row's
      // height as you scroll makes the feed jump/glitch, so we leave the box
      // exactly as big as it was, hide its content and paint it solid black.
      '.xff-dim { position: relative !important; }' +
      '.xff-dim > * { visibility: hidden !important; }' +
      '.xff-dim::after { content: "" !important; position: absolute !important;' +
      ' inset: 0 !important; background: #000 !important; pointer-events: none !important; }' +
      '.xff-gone { display: none !important; }';
    if (existing) {
      if (existing.textContent !== css) existing.textContent = css;
      return;
    }
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  /* ---------------------------------------------------------------- *
   * Extension-context lifecycle                                       *
   * ---------------------------------------------------------------- */

  function extensionAlive(): boolean {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  const timers: ReturnType<typeof setInterval>[] = [];
  let shuttingDown = false;
  function shutdown(): void {
    if (shuttingDown) return;
    shuttingDown = true;
    try { if (observer) observer.disconnect(); } catch (e) { /* ignore */ }
    try { window.removeEventListener("scroll", onScroll, true); } catch (e) { /* ignore */ }
    if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
    if (scrollIdleTimer) { clearTimeout(scrollIdleTimer); scrollIdleTimer = null; }
    timers.forEach(clearInterval);
    try { allMarkedCells().forEach(reveal); } catch (e) { /* ignore */ }
    const b = document.getElementById("xff-badge");
    if (b) b.remove();
    const s = document.getElementById(STYLE_ID);
    if (s) s.remove();
  }

  function safeStorageGet(keys: string[], cb: (res: StoredSettings) => void): void {
    if (!extensionAlive()) return;
    try { chrome.storage.sync.get(keys, (items) => cb(items as StoredSettings)); } catch (e) { shutdown(); }
  }
  function safeStorageSet(obj: StoredSettings): void {
    if (!extensionAlive()) return;
    try { chrome.storage.sync.set(obj); } catch (e) { shutdown(); }
  }

  /* ---------------------------------------------------------------- *
   * Where are we? Only the Home "For You" timeline is filterable.     *
   * ---------------------------------------------------------------- */

  function onHome(): boolean {
    return location.pathname === "/home";
  }

  // Home has two tabs ("For You" / "Following"), both at /home. Only filter
  // when "For You" is the selected tab.
  function onForYou(): boolean {
    if (!onHome()) return false;
    const tabs = document.querySelectorAll<HTMLElement>('[role="tablist"] [role="tab"]');
    let sawSelected = false;
    for (const tab of Array.from(tabs)) {
      if (tab.getAttribute("aria-selected") === "true") {
        sawSelected = true;
        const label = (tab.textContent || "").trim().toLowerCase();
        if (label.includes("for you")) return true;
      }
    }
    // Tabs not readable yet: assume For You (X defaults to it) so a fresh load
    // filters immediately. If Following is actually selected, the next scan
    // once tabs render sees sawSelected and bails.
    return !sawSelected;
  }

  function onFilterablePage(): boolean {
    return onForYou();
  }

  // The primary-column timeline region. We only query cells inside this, so
  // replies, the right sidebar, modals, etc. are never touched.
  function timeline(): HTMLElement | null {
    const primary = document.querySelector<HTMLElement>('[data-testid="primaryColumn"]');
    if (!primary) return null;
    return primary.querySelector<HTMLElement>('section [aria-label] [role="region"]')
      || primary.querySelector<HTMLElement>('div[aria-label][role="region"]')
      || primary;
  }

  function timelineCells(): HTMLElement[] {
    const root = timeline();
    if (!root) return [];
    return Array.from(root.querySelectorAll<HTMLElement>('[data-testid="cellInnerDiv"]'));
  }

  function allMarkedCells(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>("[" + ATTR + "]"));
  }

  /* ---------------------------------------------------------------- *
   * Keyword matching                                                  *
   * ---------------------------------------------------------------- */

  function normalizedKeywords(): string[] {
    return state.keywords.map(k => String(k).toLowerCase().trim()).filter(Boolean);
  }

  function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  function buildMatchers(list: string[]): RegExp[] {
    return list.map(k => new RegExp("(?<![a-z0-9])" + escapeRegExp(k) + "(?![a-z0-9])", "i"));
  }
  let MATCHERS: RegExp[] = buildMatchers(normalizedKeywords());

  function setKeywords(list: string[]): void {
    state.keywords = list;
    MATCHERS = buildMatchers(normalizedKeywords());
  }

  function matchesKeywords(text: string): boolean {
    if (!text) return false;
    return MATCHERS.some(re => re.test(text));
  }

  // Tweet body text (plus a quoted tweet's body, if present). Empty string
  // until the post has actually rendered its text.
  function postText(cell: HTMLElement): string {
    const parts = cell.querySelectorAll<HTMLElement>('[data-testid="tweetText"]');
    if (!parts.length) return "";
    let text = "";
    parts.forEach(p => { text += " " + (p.textContent || ""); });
    return text;
  }

  // A cell we can actually judge: a real tweet with rendered text. Skips
  // "who to follow", trends, promoted modules and not-yet-rendered rows.
  function isJudgeableTweet(cell: HTMLElement): boolean {
    if (!cell.querySelector('article')) return false;
    return !!cell.querySelector('[data-testid="tweetText"]');
  }

  /* ---------------------------------------------------------------- *
   * Hide / reveal via CSS classes (no geometry writes, no scroll)     *
   * ---------------------------------------------------------------- */

  function hide(cell: HTMLElement): void {
    cell.classList.remove(state.fullyRemove ? "xff-dim" : "xff-gone");
    cell.classList.add(state.fullyRemove ? "xff-gone" : "xff-dim");
    cell.setAttribute(ATTR, "hidden");
  }

  function reveal(cell: HTMLElement): void {
    cell.classList.remove("xff-dim", "xff-gone");
    cell.removeAttribute(ATTR);
  }

  /* ---------------------------------------------------------------- *
   * Observer + scan                                                   *
   *                                                                   *
   * Smoothness rules:                                                 *
   *  - One observer, attached once. We NEVER disconnect/reattach it   *
   *    per scan (doing that on a huge subtree every frame is what     *
   *    made scrolling janky).                                         *
   *  - We react to added nodes only, and ignore our own class/attr    *
   *    writes, so hiding a post never feeds back into the observer.   *
   *  - Scans are throttled to a fixed cadence and are skipped while   *
   *    the user is actively scrolling; one scan runs once scrolling   *
   *    settles. So nothing heavy happens during a scroll gesture.     *
   *  - Each scan only looks at cells not yet decided.                 *
   * ---------------------------------------------------------------- */

  let observer: MutationObserver | null = null;
  const SCAN_INTERVAL_MS = 250;
  const SCROLL_IDLE_MS = 120;
  let lastScan = 0;
  let scanTimer: ReturnType<typeof setTimeout> | null = null;
  let scrolling = false;
  let scrollIdleTimer: ReturnType<typeof setTimeout> | null = null;

  function recount(): void {
    state.kept = document.querySelectorAll('[' + ATTR + '="kept"]').length;
    state.hidden = document.querySelectorAll('[' + ATTR + '="hidden"]').length;
  }

  // The actual work. Cheap: only touches cells with no decision yet. Does NOT
  // pause the observer; our writes are class/attribute changes which the
  // observer is configured to ignore.
  function scan(): void {
    if (!extensionAlive()) { shutdown(); return; }
    lastScan = Date.now();
    if (!state.enabled) return;
    // Off the feed (e.g. a tweet's comments are open): keep the feed exactly
    // as X left it so its scroll restore on close is correct.
    if (!onFilterablePage()) { unfilterAll(); return; }

    const cells = timelineCells();
    for (const cell of cells) {
      const existing = cell.getAttribute(ATTR);
      if (existing === "kept") continue; // final
      if (!isJudgeableTweet(cell)) {
        if (existing) reveal(cell); // was marked before it rendered
        continue;
      }
      if (matchesKeywords(postText(cell))) {
        if (existing) reveal(cell);
        cell.setAttribute(ATTR, "kept");
      } else if (existing !== "hidden") {
        hide(cell);
      }
    }
    recount();
    updateBadge();
  }

  // Throttled + scroll-aware scheduler. Never runs mid-scroll.
  function scheduleScan(): void {
    if (scanTimer) return;
    const since = Date.now() - lastScan;
    const wait = scrolling ? SCROLL_IDLE_MS : Math.max(0, SCAN_INTERVAL_MS - since);
    scanTimer = setTimeout(() => {
      scanTimer = null;
      if (scrolling) { scheduleScan(); return; } // defer until scroll settles
      scan();
    }, wait);
  }

  function onScroll(): void {
    scrolling = true;
    if (scrollIdleTimer) clearTimeout(scrollIdleTimer);
    scrollIdleTimer = setTimeout(() => {
      scrolling = false;
      scheduleScan(); // one scan after the gesture ends
    }, SCROLL_IDLE_MS);
  }

  function clearAllMarks(): void {
    allMarkedCells().forEach(reveal);
  }

  function unfilterAll(): void {
    allMarkedCells().forEach(reveal);
    recount();
    updateBadge();
  }

  function rescan(): void {
    clearAllMarks();
    scheduleScan();
  }

  /* ---------------------------------------------------------------- *
   * Floating badge / toggle                                           *
   * ---------------------------------------------------------------- */

  let badge: HTMLDivElement | undefined;
  function badgeEl(): HTMLDivElement | undefined {
    if (shuttingDown) return undefined;
    if (!badge && document.body) {
      const el = document.createElement("div");
      el.id = "xff-badge";
      el.style.cssText =
        "position:fixed;bottom:16px;right:14px;z-index:2147483647;" +
        "background:#0d1b2a;color:#4fa3ff;font:600 12px/1 system-ui,sans-serif;" +
        "padding:9px 13px;border-radius:20px;box-shadow:0 2px 12px rgba(0,0,0,.45);" +
        "cursor:pointer;user-select:none;opacity:.94";
      el.title = "Click to toggle the feed filter";
      el.setAttribute("role", "button");
      el.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        state.enabled = !state.enabled;
        safeStorageSet({ enabled: state.enabled });
        if (state.enabled) rescan();
        else unfilterAll();
        updateBadge();
      }, true);
      document.body.appendChild(el);
      badge = el;
    }
    return badge;
  }
  function updateBadge(): void {
    const b = badgeEl();
    if (!b) return;
    if (!onFilterablePage()) { b.style.display = "none"; return; }
    b.style.display = "";
    b.textContent = state.enabled
      ? `Feed filter \u00b7 ${state.kept} kept \u00b7 ${state.hidden} hidden`
      : "Feed filter off";
    b.style.background = state.enabled ? "#0d1b2a" : "#3a2a2a";
    b.style.color = state.enabled ? "#4fa3ff" : "#ffb74d";
  }

  /* ---------------------------------------------------------------- *
   * Startup                                                           *
   * ---------------------------------------------------------------- */

  safeStorageGet(SETTINGS_KEYS, (res) => {
    if (typeof res.enabled === "boolean") state.enabled = res.enabled;
    if (typeof res.fullyRemove === "boolean") state.fullyRemove = res.fullyRemove;
    setKeywords(resolveKeywords(res));

    ensureStyle();

    // One observer, attached once to the whole document. We only care that
    // *something* was added; the throttled, scroll-aware scheduler decides
    // when to actually scan. We ignore attribute mutations so our own class
    // writes never trigger a rescan loop.
    observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.addedNodes && m.addedNodes.length) { scheduleScan(); return; }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Passive scroll listener: marks "scrolling" so no scan runs mid-gesture.
    window.addEventListener("scroll", onScroll, { passive: true, capture: true });

    scheduleScan();

    // Light safety-net: catches posts that streamed in without adding nodes we
    // noticed. Cheap because scan() skips already-decided cells and is itself
    // throttled + scroll-aware.
    timers.push(setInterval(() => {
      if (!extensionAlive()) { shutdown(); return; }
      ensureStyle();
      scheduleScan();
    }, 2000));

    // Detect entering/leaving the filterable page. Covers SPA navigation
    // (opening a tweet, profiles, search) and the For You / Following tab
    // switch. Leaving reveals everything so X's scroll restore on return is
    // correct.
    let wasFilterable = onFilterablePage();
    timers.push(setInterval(() => {
      if (!extensionAlive()) { shutdown(); return; }
      const isFilterable = onFilterablePage();
      if (isFilterable !== wasFilterable) {
        wasFilterable = isFilterable;
        clearAllMarks();
        if (isFilterable) scheduleScan();
        else recount();
        updateBadge();
      }
    }, 300));
  });

  /* ---------------------------------------------------------------- *
   * React to popup changes live                                       *
   * ---------------------------------------------------------------- */

  if (extensionAlive()) {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (!extensionAlive()) { shutdown(); return; }
        if (area !== "sync") return;
        if (changes.enabled) {
          state.enabled = changes.enabled.newValue as boolean;
          if (state.enabled) rescan();
          else unfilterAll();
        }
        if (changes.fullyRemove) {
          state.fullyRemove = changes.fullyRemove.newValue as boolean;
          // Re-apply hide class to already-hidden cells under the new mode.
          allMarkedCells().forEach(cell => {
            if (cell.getAttribute(ATTR) === "hidden") hide(cell);
          });
        }
        if (changes.keywordList || changes.customKeywords) {
          safeStorageGet(["keywordList", "customKeywords"], (res) => {
            setKeywords(resolveKeywords(res));
            rescan();
          });
        }
      });
    } catch (e) { /* context already gone */ }
  }
})();
