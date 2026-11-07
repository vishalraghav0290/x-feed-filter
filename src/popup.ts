// Popup UI: on/off toggle and the editable keyword list.
// Depends on keywords.ts (loaded first by popup.html) for DEFAULT_KEYWORDS,
// SETTINGS_KEYS and resolveKeywords.
(function () {
  "use strict";

  function byId<T extends HTMLElement>(id: string): T {
    const el = document.getElementById(id);
    if (!el) throw new Error("Missing element #" + id);
    return el as T;
  }

  const enabledEl = byId<HTMLInputElement>("enabled");
  const keywordListEl = byId<HTMLTextAreaElement>("keywordList");
  const countEl = byId<HTMLDivElement>("count");
  const savedMsg = byId<HTMLDivElement>("savedMsg");

  // Parse a comma/newline separated string into a clean keyword array.
  function parseKeywords(text: string): string[] {
    return text
      .split(/[,\n]/)
      .map(s => s.trim().toLowerCase())
      .filter(Boolean)
      // de-dupe while preserving order
      .filter((v, i, arr) => arr.indexOf(v) === i);
  }

  function renderList(list: readonly string[]): void {
    keywordListEl.value = list.join(", ");
    updateCount();
  }

  function updateCount(): void {
    const n = parseKeywords(keywordListEl.value).length;
    countEl.textContent = n + " keyword" + (n === 1 ? "" : "s");
  }

  function flash(msg: string): void {
    savedMsg.textContent = msg;
    setTimeout(() => (savedMsg.textContent = ""), 1500);
  }

  // Load current state.
  chrome.storage.sync.get(SETTINGS_KEYS, (items) => {
    const res = items as StoredSettings;
    enabledEl.checked = res.enabled !== false; // default on
    renderList(resolveKeywords(res));
  });

  keywordListEl.addEventListener("input", updateCount);

  enabledEl.addEventListener("change", () => {
    chrome.storage.sync.set({ enabled: enabledEl.checked });
  });

  byId<HTMLButtonElement>("save").addEventListener("click", () => {
    const list = parseKeywords(keywordListEl.value);
    // Store as the full override list. Clear the legacy key so it can't shadow it.
    chrome.storage.sync.set({ keywordList: list, customKeywords: [] }, () => {
      renderList(list);
      flash("Saved \u2713");
    });
  });

  byId<HTMLButtonElement>("reset").addEventListener("click", () => {
    const list = DEFAULT_KEYWORDS.slice();
    chrome.storage.sync.set({ keywordList: list, customKeywords: [] }, () => {
      renderList(list);
      flash("Reset to defaults \u2713");
    });
  });
})();
