# X Feed Filter

A browser extension by Vishal Raghav that removes posts from your X (Twitter) "For You" feed unless they match your own keywords. It comes with an aviation keyword list by default, and you can replace it with any topic.

Live URL: none. You install it from this repo's [Releases](https://github.com/vishalraghav0290/x-feed-filter/releases) page.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4)

## Features

- Removes "For You" posts whose text doesn't contain any of your keywords. X never draws them, so there are no blank gaps and no hidden rows.
- Ships with an aviation keyword preset (airlines, aircraft types, airports, regulators, Indian Air Force and more).
- Edit the keyword list in the popup. Separate keywords with commas; multi-word phrases work.
- Whole-word, case-insensitive matching, so `atc` does not match "watch".
- Matches the full text of long posts, and also the original of a repost and the quoted post.
- Only the "For You" feed is filtered. The Following tab, a post's replies, profiles and search are left alone.
- A small badge on `x.com/home` shows how many posts were shown and removed. Click it to turn the filter off or on (the page reloads).
- "Reset to aviation preset" button restores the default list.
- Settings are saved with `chrome.storage.sync`.

## Tech stack

| Part | Details |
|---|---|
| Language | TypeScript 7.0.2 (compiled with `tsc` in strict mode, target ES2020) |
| Extension platform | Chrome Extension Manifest V3 (needs Chromium 111 or newer) |
| Type definitions | @types/chrome 0.3.4 |
| Build tooling | npm scripts + a small Node script (`scripts/build.mjs`) |
| Runtime dependencies | none |

## Getting started

### Install the ready-made build (no tools needed)

1. Download the `x-feed-filter-v*.zip` file from the [latest release](https://github.com/vishalraghav0290/x-feed-filter/releases/latest).
2. Unzip it to a folder you will keep.
3. Open `chrome://extensions` (Brave: `brave://extensions`, Edge: `edge://extensions`).
4. Turn on **Developer mode**.
5. Click **Load unpacked** and pick the unzipped folder (the one containing `manifest.json`).
6. Open [x.com/home](https://x.com/home), select **For You**, and reload the page.

### Build from source

Prerequisites: Node.js 16.20.0 or newer (required by TypeScript 7.0.2) and npm.

```bash
git clone https://github.com/vishalraghav0290/x-feed-filter.git
cd x-feed-filter
npm install
npm run build
```

Then load the generated `dist/` folder with **Load unpacked** as shown above.

Type-check without building:

```bash
npm run typecheck
```

There is no dev server or watch mode. After editing code, run `npm run build` again, click the reload icon on the extension card in `chrome://extensions`, and reload the X tab.

## Environment variables

None. The project has no `.env` file and needs no configuration.

## Using it

1. Open [x.com/home](https://x.com/home) and select **For You**.
2. Posts that don't match your keywords are removed as the feed loads. The badge in the bottom-right corner shows `Feed filter · N shown · N removed`.
3. To change the topic, click the extension icon, edit **Filter keywords**, and click **Save**.

Changes apply to posts that load next. Reload the X tab to re-filter the feed already on screen.

Example keyword lists:

| Topic | Keywords |
|---|---|
| Football | `football, soccer, premier league, champions league, la liga, goal, transfer, var` |
| Cricket | `cricket, ipl, test match, odi, t20, wicket, bcci, icc` |
| Formula 1 | `f1, formula 1, grand prix, pole position, pit stop, fia, verstappen` |
| Tech | `ai, javascript, python, open source, github, startup, llm` |

## Limitations

- The filter reads post text only. A post that is just an image or video, with no matching words, is removed.
- On a narrow topic, only a few posts per batch match, so the feed can look sparse. X loads the next batch as you scroll.
- Promoted posts are judged by the same keyword rules as any other post.
- It relies on the format of X's internal `HomeTimeline` response. If X changes that format, the extension stops filtering and passes posts through unchanged until it is updated.
- Chromium-based browsers only (Chrome, Brave, Edge and similar). Firefox and Safari are not supported.

## Project structure

```text
src/
  inject.ts      runs in the page: removes non-matching posts from X's feed data
  content.ts     reads settings, sends them to inject.ts, shows the badge
  keywords.ts    default aviation keyword list, settings type, keyword resolution
  popup.ts       logic for the settings popup
public/
  manifest.json  Manifest V3 config (permissions, content scripts, popup, icons)
  popup.html     popup markup and styles
  icon48.png, icon128.png
scripts/
  build.mjs      cleans dist/ and copies public/ into it around the tsc compile
dist/            build output (not committed); load this folder in the browser
```

## How it works

X draws the "For You" feed from the JSON returned by a request called `HomeTimeline`, one row per entry. The manifest runs `inject.js` in the page's own JavaScript context at `document_start`, so it is installed before X's code. It wraps `XMLHttpRequest` (which X's API client uses) and `fetch`, and when the response to a `HomeTimeline` request arrives, it deletes the entries whose text doesn't match your keywords before X reads the response. Pagination cursors are kept so infinite scroll still works. If anything looks unexpected, the original response is returned untouched. `content.js` runs in the extension's own context, reads your settings from `chrome.storage.sync`, and sends them to `inject.js` with `window.postMessage`. It also draws the badge. Other requests, such as a post's replies (`TweetDetail`) or the Following tab (`HomeLatestTimeline`), are never modified.

## Permissions

- `storage`: to save your on/off state and keyword list.
- Host access to `https://x.com/*` and `https://twitter.com/*`: to run on those sites and read the feed response.

The extension makes no network requests of its own.

## Troubleshooting

- **Nothing is filtered:** reload the X tab after installing, updating or reloading the extension. Make sure you are on `x.com/home` with **For You** selected and the filter is on.
- **The feed looks empty or sparse:** your keywords match few posts. Keep scrolling, or add more keywords.
- **"Manifest file is missing or unreadable":** you selected the wrong folder. Pick the folder that directly contains `manifest.json`.
- **"Unrecognized manifest key" or a version error:** your browser is older than Chromium 111. Update it.

## Deployment

There is no store listing or CI pipeline. Releases are published manually as a zip of `dist/` on [GitHub Releases](https://github.com/vishalraghav0290/x-feed-filter/releases).

## Credits

- Built with [TypeScript](https://www.typescriptlang.org/) (Apache-2.0) and [@types/chrome](https://www.npmjs.com/package/@types/chrome) (MIT). Both are development tools only and are not bundled into the extension.
- Not affiliated with or endorsed by X Corp.

## Author

Vishal Raghav, Software Engineer (Frontend, Backend, DevOps)
GitHub: [@vishalraghav0290](https://github.com/vishalraghav0290)
Live site: none

## License

[MIT](LICENSE)
