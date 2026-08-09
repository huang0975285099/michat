# Task 7 report: Sugar Pop game-center integration and acceptance QA

Status: **PASS**

## Delivered

- Replaced the disabled Game Center placeholder with a clickable Sugar Pop card.
- Preserved the Iron Fist card unchanged.
- Added the required `Match-3` and `Offline` chips and routed the card to `/games/sugar-pop`.
- Confirmed `frontend/package.json` already has the exact required script:
  `node --test src/games/sugar-pop/game/*.test.mjs`; no package edit was needed.
- Fixed two browser-only integration defects found during final QA:
  - Scene classes were created from a separately bundled deep Phaser `Scene`, so the browser registered five `default` scenes and rendered a black canvas. Runtime scene factories now inherit from the same injected Phaser runtime as `Phaser.Game`.
  - SVG `HTMLImageElement` sources could not be uploaded directly by Chromium WebGL. Original local SVG sources are now valid Base64 and rasterized to 100×100 in-memory canvas textures before the map starts.
- Added permanent regression tests for runtime-owned Phaser scenes and browser-decodable SVG texture sources.

## Commits

- `246f549 fix: make Sugar Pop browser-playable`
- `70b09cb feat: add Sugar Pop to game center`

## Automated verification

Run from `frontend/`:

- `npm run test:sugar-pop` — 65 passed, 0 failed.
- `npm run test:ironfist` — 2 passed, 0 failed.
- `npm run test:version` — 4 passed, 0 failed.
- `npm run lint` — exit 0, 0 errors, 7 pre-existing unrelated warnings.
- `npm run build` — exit 0; Quasar/Vite production SPA build succeeded.
- `git diff --check` — exit 0.

## Browser acceptance evidence

Environment:

- Quasar dev server at `http://127.0.0.1:9001`.
- Global Playwright CLI `1.62.1` from
  `C:\Users\Administrator\AppData\Roaming\npm\playwright.cmd`.
- Headed Chromium acceptance command ran two tests serially and completed in 29.8 seconds: **2 passed, 0 failed**.
- Required viewports: desktop `1600×900`; mobile `390×844` with touch enabled.

Verified behavior:

- Game Center shows Sugar Pop, `Match-3`, and `Offline`; clicking the card opens `/games/sugar-pop` and a visible Phaser canvas.
- New-save map shows Level 1 unlocked and Levels 2–10 locked.
- Level 1 starts on desktop and mobile with target, moves, score, pause, full 8×8 board, and all three boosters visible.
- Canvas bounds exactly match both viewports; document scroll bounds do not exceed either viewport.
- No visible `.q-dialog`, Quasar backdrop/menu/notification, or lock overlay appears above the game canvas.
- No `<audio>` element, media request, or audio asset request occurred.
- An adjacent invalid swap completed its rebound and returned to a byte-identical settled canvas frame.
- Forced Shuffle succeeded and persisted inventory from `1` to `0`.
- A deterministic legal-move browser flow completed Level 1 in 13 turns, rendered the Phaser win overlay, awarded 3 stars at score 1060, unlocked Level 2, and awarded its booster rewards.
- Refresh preserved stars, high score, unlock, and booster inventory in `localStorage`; the refreshed map rendered saved stars.
- Visual captures confirmed jelly at Level 4, frosting at Level 6, and combined jelly/frosting mechanics at Levels 8, 9, and 10.
- Mobile touch taps selected adjacent cells and left the complete HUD/board/booster layout fitted within `390×844`.
- Two additional unscripted inputs were covered by the invalid swap and forced shuffle flows.

## Concerns / non-blocking output

- Node emits existing `MODULE_TYPELESS_PACKAGE_JSON` warnings during ESM tests.
- ESLint reports seven existing unrelated warnings outside Sugar Pop; there are no lint errors.
- Production build reports the existing large-chunk advisory; the lazy Sugar Pop chunk is about 1.23 MB before gzip (about 327 KB gzip).
- The local QA backend was not running, so the host app logged expected WebSocket reconnect messages; API calls needed to reach Game Center were locally stubbed. Sugar Pop itself made no network or media requests.
- No confirmed design correction was needed, so the design spec was not changed.
- Existing unrelated untracked `task-5-finalreview.md` and `task-6-rereview.md` were preserved and not staged.
