# Routr

Runner route-planning web app (vanilla JS + Mapbox GL JS). Draw a route on a
map and get live distance/time/pace — not turn-by-turn A→B navigation.
Differentiator: route *design/sculpting*, plus using it to correct
GPS-corrupted run tracks after the fact. Live at
https://nathanielbierig.github.io/Routr/ (see README.md for user-facing
feature list — this file is architecture/internals).

## Repo
- GitHub: `NathanielBierig/Routr`. Default branch `main`; pushes to `main`
  auto-deploy to GitHub Pages via `.github/workflows/deploy.yml`, which
  injects `MAPBOX_TOKEN` from a repo secret at build time.
- Other branches exist (`mvp`, `stable-mvp`, `test`,
  `experimental-suggested-routes`) — check which one you're on before
  assuming `main`'s state.
- Local dev needs a gitignored `tokens.js` with `const MAPBOX_TOKEN = "pk...";`.

## Files
- `index.html` — loading screen, collapsible top HUD (stats + controls +
  "More" menu), suggest-route panel, elevation/reorder/directions/my-routes
  panels, help panel, map div. PWA metadata (manifest, icons) for "Add to
  Home Screen".
- `script.js` (~2700 lines) — all logic, single file, no build step.
- `style.css` — all styling, dark theme, mobile-first responsive (bottom
  sheets on phone, inline panels on desktop).
- `manifest.json`, `icon*.png/svg` — PWA install support.
- `.github/workflows/deploy.yml` — GitHub Pages deploy + token injection.

## Core state (script.js, top of file)
- `route[]` — ordered waypoints (source of truth).
- `legModes[]` — per-leg follow-roads vs. straight-line flag.
- `legs[]` — per-leg `{coordinates, distance, duration}`.
- `roadRoute[]` — flattened coordinates for the combined line.
- `totalDistance` / `totalDuration`, `useMiles`, pace from `#paceInput`.
- `isFollowRoads`, `isFreehandMode`, `isCapturingFreehand` — drawing-mode flags.
- `undoGroups[]` — undo history.
- `markers[]` — current Marker instances.
- `rebuildGeneration` — guards `rebuildRoute()` against stale async responses
  when it's called again before a previous call's Directions requests return.

## Major subsystems
- **Routing**: `rebuildRoute()` re-requests Mapbox Directions per leg (or
  skips it for straight-line legs) whenever `route[]` changes — add, delete,
  reorder, drag, undo, close-loop all funnel through it. `updateLayers()`
  redraws one source/layer per leg (neon colors from `legColors[]`) plus the
  combined line.
- **Point editing**: click/tap a point for an address popup + delete
  (`showPointInfoPopup`, `deletePoint`); drag a point to move it; press-and-hold
  (or click on desktop) near the line to insert a new point and sculpt a bend.
  Desktop uses `mousedown`/`mousemove`/`mouseup`; mobile has its own
  `touchstart`/`touchmove`/`touchend` handling with a hold timer
  (`HOLD_MS`, `holdTimer`, `showHoldRing`) so taps/scrolls/pinches don't drop
  stray points.
- **Freehand drawing**: `isFreehandMode` toggle; traces raw points
  (`addFreehandPoint`), simplifies on release (`commitFreehandPath`), merges
  into `route[]`.
- **Route suggestion**: `suggestRoutes()` generates candidate loop/out-and-back
  shapes (triangle/square/fewest-turns/out-back) at a target distance from a
  start point, using `destinationPoint()` bearing math + indirection factor
  (`SUGGEST_INDIRECTION`, calibrated ~1.4-1.5x straight-line for real roads),
  fetches Directions per candidate, scores by closeness to target + turn
  count, previews the best on the map (`showSuggestPreview`), commits via
  `useSuggestedRoute()`.
- **Elevation**: samples terrain tiles directly (`loadTerrainTile`,
  `getElevationAtPoint`, no separate elevation API call), builds a profile
  (`computeElevationProfile`) and renders a chart (`renderElevationChart`).
- **Export / persistence**: `buildGPX()`/`exportGPX()` for GPX download;
  `localStorage` (`routr_saved_routes` key) for named "My Routes" save/reload.
- **Location**: `locateUser()` on load with a loading screen that waits for
  both geolocation to resolve AND the map style to settle (Standard style has
  a fallback chain — see `MINIMAL_FALLBACK_STYLE`, `styleFallbackTier`) before
  revealing the map, to avoid a visible jump or a flash of a broken style.
  Falls back to Times Square if location is denied/unavailable.
- **Units/pace**: km/mi toggle (`useMiles`), typeable + steppable pace input
  driving walking-time/running-time/pace HUD fields.
- **Help**: first-run overlay + a persistent `?` panel
  (`routr_help_seen` localStorage key), with separate mouse/touch instructions
  via `.help-mouse`/`.help-touch` CSS classes.

## Notes / known constraints
- `rebuildRoute()` re-fetches Directions for every leg on every mutation —
  fine at normal route sizes, but watch for Mapbox rate limits or lag with
  many waypoints or during a fast drag.
- Mapbox telemetry `ERR_BLOCKED_BY_CLIENT` console error is harmless (ad
  blockers), ignore.
- No automated tests — changes have historically been verified by manual
  desktop + mobile (device-emulated) testing; several past commits are fixes
  from exactly that kind of sweep. Test both input modes before considering a
  UI change done.
- Keep diffs scoped to one feature/fix at a time; this file lags actual code,
  so skim recent `git log` and grep `script.js` for the relevant function
  before assuming behavior from this description alone.
