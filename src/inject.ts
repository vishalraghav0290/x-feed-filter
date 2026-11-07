/* X Feed Filter - page-context script.
 *
 * Runs in the page's own JavaScript world (manifest "world": "MAIN") at
 * document_start, so it is installed before X's code runs.
 *
 * How it works: X loads the "For You" feed from a GraphQL call named
 * HomeTimeline and renders one row per entry in the JSON it gets back. We
 * intercept that response (XMLHttpRequest, which X's API client uses, and
 * fetch, which it falls back to) and delete the posts that don't match the
 * user's keywords BEFORE X reads it. X never creates rows for them, so there
 * is nothing to hide, no gaps, and no layout or scroll changes.
 *
 * Only the For You call (HomeTimeline) is touched. The Following tab
 * (HomeLatestTimeline), a tweet's replies (TweetDetail), profiles and search
 * use other calls and are never modified.
 *
 * Safety: if anything goes wrong (not JSON, unexpected shape, no settings
 * yet) the original response is passed through unchanged.
 *
 * Settings come from the extension's isolated content script (content.ts)
 * over window.postMessage, because chrome.storage is not available here.
 */
(function () {
  "use strict";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type AnyObj = { [key: string]: any };

  interface Config {
    enabled: boolean;
    matchers: RegExp[];
  }

  interface Counts {
    kept: number;
    removed: number;
  }

  const FROM_CONTENT = "xff-content";
  const FROM_PAGE = "xff-page";

  let config: Config | null = null;
  let totalKept = 0;
  let totalRemoved = 0;

  /* ---------------------------------------------------------------- *
   * Settings from the content script                                  *
   * ---------------------------------------------------------------- */

  function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // Whole-word, case-insensitive matchers, so "atc" does not match "watch".
  // A keyword matches only when it is not glued to other letters or digits.
  function buildMatchers(keywords: unknown[]): RegExp[] {
    return keywords
      .map(k => String(k).trim())
      .filter(Boolean)
      .map(k => new RegExp("(?<![\\p{L}\\p{N}])" + escapeRegExp(k) + "(?![\\p{L}\\p{N}])", "iu"));
  }

  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window) return;
    const d = event.data as AnyObj | null;
    if (!d || d.source !== FROM_CONTENT || d.type !== "config") return;
    config = {
      enabled: d.enabled !== false,
      matchers: buildMatchers(Array.isArray(d.keywords) ? d.keywords : [])
    };
  });

  function postToContent(msg: AnyObj): void {
    try {
      window.postMessage(Object.assign({ source: FROM_PAGE }, msg), location.origin);
    } catch (e) { /* ignore */ }
  }

  // Ask for settings in case the content script started first.
  postToContent({ type: "need-config" });

  /* ---------------------------------------------------------------- *
   * Reading post text out of the API JSON                             *
   * ---------------------------------------------------------------- */

  // Results can be wrapped (TweetWithVisibilityResults has the post in .tweet).
  function unwrap(result: AnyObj | undefined): AnyObj | undefined {
    if (!result || typeof result !== "object") return undefined;
    return result.tweet && typeof result.tweet === "object" ? (result.tweet as AnyObj) : result;
  }

  // The post's own text. Long posts keep the full text in note_tweet.
  function ownText(t: AnyObj): string {
    const note = t.note_tweet && t.note_tweet.note_tweet_results && t.note_tweet.note_tweet_results.result;
    if (note && typeof note.text === "string") return note.text;
    return t.legacy && typeof t.legacy.full_text === "string" ? t.legacy.full_text : "";
  }

  // Own text plus the original of a repost and the quoted post, so a repost or
  // quote of an on-topic post is judged on-topic. Depth is capped defensively.
  function fullText(result: AnyObj | undefined, depth: number): string {
    const t = unwrap(result);
    if (!t || depth > 3) return "";
    let text = ownText(t);
    const reposted = t.legacy && t.legacy.retweeted_status_result && t.legacy.retweeted_status_result.result;
    if (reposted) text += "\n" + fullText(reposted as AnyObj, depth + 1);
    const quoted = t.quoted_status_result && t.quoted_status_result.result;
    if (quoted) text += "\n" + fullText(quoted as AnyObj, depth + 1);
    return text;
  }

  function matches(text: string, cfg: Config): boolean {
    if (!text) return false;
    return cfg.matchers.some(re => re.test(text));
  }

  /* ---------------------------------------------------------------- *
   * Filtering the HomeTimeline JSON                                   *
   * ---------------------------------------------------------------- */

  function isPostContent(itemContent: AnyObj | undefined): boolean {
    return !!(itemContent && itemContent.tweet_results);
  }

  // true = keep the entry. Cursors (pagination) and anything that is not a
  // post are always kept, so infinite scroll keeps working.
  function keepEntry(entry: AnyObj, cfg: Config, counts: Counts): boolean {
    const content = entry && entry.content;
    if (!content) return true;

    if (isPostContent(content.itemContent)) {
      const ok = matches(fullText(content.itemContent.tweet_results.result as AnyObj, 0), cfg);
      if (ok) counts.kept++; else counts.removed++;
      return ok;
    }

    // Modules (e.g. a conversation thread) hold several items.
    if (Array.isArray(content.items)) {
      let posts = 0;
      let keptPosts = 0;
      const items = (content.items as AnyObj[]).filter(it => {
        const ic = it && it.item && it.item.itemContent;
        if (!isPostContent(ic)) return true;
        posts++;
        const ok = matches(fullText(ic.tweet_results.result as AnyObj, 0), cfg);
        if (ok) { keptPosts++; counts.kept++; } else counts.removed++;
        return ok;
      });
      if (posts > 0 && keptPosts === 0) return false; // nothing left in the module
      content.items = items;
    }
    return true;
  }

  // Mutates the parsed response in place. Returns null if it is not a home
  // timeline payload.
  function filterTimeline(data: AnyObj, cfg: Config): Counts | null {
    const instructions = data && data.data && data.data.home && data.data.home.home_timeline_urt
      && data.data.home.home_timeline_urt.instructions;
    if (!Array.isArray(instructions)) return null;

    const counts: Counts = { kept: 0, removed: 0 };
    for (const ins of instructions as AnyObj[]) {
      if (!ins || !Array.isArray(ins.entries)) continue;
      ins.entries = (ins.entries as AnyObj[]).filter(entry => keepEntry(entry, cfg, counts));
    }
    totalKept += counts.kept;
    totalRemoved += counts.removed;
    postToContent({ type: "stats", kept: totalKept, removed: totalRemoved });
    return counts;
  }

  function activeConfig(): Config | null {
    const cfg = config;
    return cfg && cfg.enabled && cfg.matchers.length > 0 ? cfg : null;
  }

  // Text in, text out. Returns the input untouched on any problem.
  function processText(raw: string): string {
    const cfg = activeConfig();
    if (!cfg) return raw;
    try {
      const data = JSON.parse(raw) as AnyObj;
      const counts = filterTimeline(data, cfg);
      if (!counts || counts.removed === 0) return raw;
      return JSON.stringify(data);
    } catch (e) {
      return raw;
    }
  }

  function isHomeTimelineUrl(url: string): boolean {
    // .../i/api/graphql/<hash>/HomeTimeline?variables=...  (For You only;
    // the Following tab is HomeLatestTimeline and does not match.)
    return /\/i\/api\/graphql\/[^/?#]+\/HomeTimeline(?:[?#]|$)/.test(url);
  }

  /* ---------------------------------------------------------------- *
   * XMLHttpRequest hook (what X's API client actually uses)           *
   * ---------------------------------------------------------------- */

  try {
    const proto = XMLHttpRequest.prototype;
    const textDesc = Object.getOwnPropertyDescriptor(proto, "responseText");
    const respDesc = Object.getOwnPropertyDescriptor(proto, "response");
    const nativeOpen = proto.open as unknown as (...args: unknown[]) => void;

    if (textDesc && textDesc.get && respDesc && respDesc.get) {
      const getText = textDesc.get;
      const getResponse = respDesc.get;
      const doneObjects = new WeakSet<object>();

      // Override the response getters on this one request object only, so the
      // filtered body is what X reads whenever it reads it.
      const install = (xhr: XMLHttpRequest): void => {
        let cacheSrc: string | null = null;
        let cacheOut = "";
        const filteredText = (raw: string): string => {
          if (raw !== cacheSrc) { cacheSrc = raw; cacheOut = processText(raw); }
          return cacheOut;
        };

        Object.defineProperty(xhr, "responseText", {
          configurable: true,
          get(this: XMLHttpRequest) {
            const raw = getText.call(this) as string;
            if (this.readyState !== 4 || typeof raw !== "string") return raw;
            return filteredText(raw);
          }
        });

        Object.defineProperty(xhr, "response", {
          configurable: true,
          get(this: XMLHttpRequest) {
            const raw = getResponse.call(this) as unknown;
            if (this.readyState !== 4) return raw;
            if (typeof raw === "string") return filteredText(raw);
            if (this.responseType === "json" && raw && typeof raw === "object" && !doneObjects.has(raw)) {
              doneObjects.add(raw);
              const cfg = activeConfig();
              if (cfg) { try { filterTimeline(raw as AnyObj, cfg); } catch (e) { /* ignore */ } }
            }
            return raw;
          }
        });
      };

      const uninstall = (xhr: XMLHttpRequest): void => {
        if (Object.prototype.hasOwnProperty.call(xhr, "responseText")) delete (xhr as AnyObj).responseText;
        if (Object.prototype.hasOwnProperty.call(xhr, "response")) delete (xhr as AnyObj).response;
      };

      proto.open = function (this: XMLHttpRequest, ...args: unknown[]): void {
        try {
          if (args[1] != null && isHomeTimelineUrl(String(args[1]))) install(this);
          else uninstall(this); // request object reused for another URL
        } catch (e) { /* ignore */ }
        nativeOpen.apply(this, args);
      } as unknown as typeof proto.open;
    }
  } catch (e) { /* hooking failed: leave XHR alone */ }

  /* ---------------------------------------------------------------- *
   * fetch hook (fallback path in X's client)                          *
   * ---------------------------------------------------------------- */

  try {
    const nativeFetch = window.fetch;
    window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const pending = nativeFetch.call(window, input, init);
      let url = "";
      try {
        url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      } catch (e) { /* ignore */ }
      if (!isHomeTimelineUrl(url)) return pending;

      return pending.then(async (res: Response) => {
        try {
          if (!res.ok || !activeConfig()) return res;
          const raw = await res.clone().text();
          const out = processText(raw);
          if (out === raw) return res;
          const headers = new Headers(res.headers);
          headers.delete("content-length");
          headers.delete("content-encoding");
          return new Response(out, { status: res.status, statusText: res.statusText, headers });
        } catch (e) {
          return res;
        }
      });
    };
  } catch (e) { /* hooking failed: leave fetch alone */ }
})();
