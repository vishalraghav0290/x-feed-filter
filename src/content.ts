/* X Feed Filter (content script)
 * Hides "For You" timeline posts whose text doesn't match any of your
 * keywords. Ships with an aviation keyword preset by default.
 * State (on/off, mode, keyword list) lives in chrome.storage.sync.
 * Depends on keywords.ts (injected first) for DEFAULT_KEYWORDS,
 * SETTINGS_KEYS and resolveKeywords.
 *
 * Design notes:
 *  - We NEVER touch the scroll position. X runs its own virtualized scroller;
 *    the moment an extension writes scrollTop it fights the page and you get
 *    the "jumps around / infinite scroll" behaviour. So we only ever toggle
 *    `display` on timeline rows and let X manage layout and heights.
 *  - We only act on the Home "For You" timeline, scoped to the primary column.
 *    On a tweet's detail/replies page, a profile, search, etc. we do nothing,
 *    so opening a tweet's comments is completely unaffected.
 *  - A post is matched on its real tweet text ([data-testid="tweetText"]),
 *    not the whole article's innerText (which includes names, handles,
 *    timestamps and quoted tweets).
 */
(function () {
  "use strict";

  interface FilterState {
    enabled: boolean;
    fullyRemove: boolean; // false = dim+shrink, true = fully hidden
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

  // Decision marker. Placed on the timeline cell wrapper, not the <article>,
  // so the whole row collapses with no leftover gap.
  const ATTR = "data-xff";

  /* ---------------------------------------------------------------- *
   * Extension-context lifecycle                                       *
   * ---------------------------------------------------------------- */

  // When the extension is reloaded/updated, this old content script loses its
  // connection ("Extension context invalidated"). Detect that and shut down
  // quietly instead of throwing on every chrome.* call.
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
    timers.forEach(clearInterval);
    try { allMarkedCells().forEach(reveal); } catch (e) { /* ignore */ }
    const b = document.getElementById("xff-badge");
    if (b) b.remove();
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
    // once tabs render will see sawSelected and bail.
    return !sawSelected;
  }

  function onFilterablePage(): boolean {
    return onForYou();
  }

  // The scrollable timeline container for the primary column. We only ever
  // query cells inside this, so replies, the right sidebar, modals, etc. are
  // never touched.
  function timeline(): HTMLElement | null {
    const primary = document.querySelector<HTMLElement>('[data-testid="primaryColumn"]');
    if (!primary) return null;
    return primary.querySelector<HTMLElement>('section [aria-label] [role="region"]')
      || primary.querySelector<HTMLElement>('div[aria-label][role="region"]')
      || primary;
  }

  // Timeline post rows. Each real feed post sits in a cellInnerDiv wrapper.
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

  // Whole-word, case-insensitive matchers. Stops "atc" matching inside
  // "watch". Phrases ("air india"), hyphenated ("su-30") and numeric ("737")
  // keywords all work.
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

  // Pull the human-readable text of a post: its tweet body plus the body of a
  // quoted tweet, if any. Returns "" when the post hasn't rendered text yet.
  function postText(cell: HTMLElement): string {
    const parts = cell.querySelectorAll<HTMLElement>('[data-testid="tweetText"]');
    if (!parts.length) return "";
    let text = "";
    parts.forEach(p => { text += " " + (p.textContent || ""); });
    return text;
  }

  // Does this cell actually contain a tweet we can judge? (Skips "who to
  // follow", trends, promoted modules and not-yet-rendered placeholders.)
  function isJudgeableTweet(cell: HTMLElement): boolean {
    if (!cell.querySelector('article')) return false;
    return !!cell.querySelector('[data-testid="tweetText"]');
  }

  /* ---------------------------------------------------------------- *
   * Hide / reveal (display only; never geometry or scroll)            *
   * ---------------------------------------------------------------- */

  function hide(cell: HTMLElement): void {
    if (state.fullyRemove) {
      cell.style.display = "none";
    } else {
      cell.style.opacity = "0.12";
      cell.style.filter = "grayscale(1)";
    }
    cell.setAttribute(ATTR, "hidden");
  }

  function reveal(cell: HTMLElement): void {
    cell.style.display = "";
    cell.style.opacity = "";
    cell.style.filter = "";
    cell.removeAttribute(ATTR);
  }

  /* ---------------------------------------------------------------- *
   * Observer + scan. We pause the observer around our own writes so   *
   * our mutations don't trigger an endless re-scan loop.              *
   * ---------------------------------------------------------------- */

  let observer: MutationObserver | null = null;
  let scanScheduled = false;

  function pauseObserver(): void {
    if (observer) observer.disconnect();
  }
  function resumeObserver(): void {
    const root = timeline() || document.body;
    if (observer && root) {
      observer.observe(root, { childList: true, subtree: true });
    }
  }

  function clearAllMarks(): void {
    pauseObserver();
    try { allMarkedCells().forEach(reveal); } finally { resumeObserver(); }
  }

  function recount(): void {
    state.kept = document.querySelectorAll('[' + ATTR + '="kept"]').length;
    state.hidden = document.querySelectorAll('[' + ATTR + '="hidden"]').length;
  }

  function scan(): void {
    if (!extensionAlive()) { shutdown(); return; }
    if (!state.enabled) return;
    if (!onFilterablePage()) { unfilterAll(); return; }

    pauseObserver();
    try {
      const cells = timelineCells();
      cells.forEach(cell => {
        const existing = cell.getAttribute(ATTR);
        if (!isJudgeableTweet(cell)) {
          // Not a tweet (module/placeholder). Leave it fully alone; if we had
          // marked it earlier (e.g. before it rendered), clear that.
          if (existing) reveal(cell);
          return;
        }
        if (existing === "kept") return; // keep decisions are final
        if (matchesKeywords(postText(cell))) {
          if (existing) reveal(cell); // was hidden before text loaded
          cell.setAttribute(ATTR, "kept");
        } else {
          hide(cell);
        }
      });
      recount();
      updateBadge();
    } finally {
      resumeObserver();
    }
  }

  // Coalesce bursts of DOM mutations into one scan per frame.
  function scheduleScan(): void {
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      scan();
    });
  }

  function unfilterAll(): void {
    pauseObserver();
    try {
      allMarkedCells().forEach(reveal);
      recount();
      updateBadge();
    } finally {
      resumeObserver();
    }
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

    observer = new MutationObserver(scheduleScan);
    scheduleScan();
    resumeObserver();

    // Light safety-net scan. No scroll pinning, no geometry: just catches
    // posts that streamed in without tripping the observer.
    timers.push(setInterval(() => {
      if (!extensionAlive()) { shutdown(); return; }
      scheduleScan();
    }, 1500));

    // Detect entering/leaving the filterable page. Covers SPA navigation
    // (path change) and the For You / Following tab switch (same /home path).
    // Leaving For You reveals everything so nothing is left interfered with,
    // and re-attaches the observer to the new timeline container.
    let wasFilterable = onFilterablePage();
    timers.push(setInterval(() => {
      if (!extensionAlive()) { shutdown(); return; }
      const isFilterable = onFilterablePage();
      if (isFilterable !== wasFilterable) {
        wasFilterable = isFilterable;
        clearAllMarks();      // reveal anything from the previous view
        pauseObserver();
        resumeObserver();     // re-bind to the current timeline root
        if (isFilterable) scheduleScan();
        else { recount(); }
        updateBadge();
      }
    }, 400));
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
          rescan();
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
