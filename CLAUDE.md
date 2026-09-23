# Routr

Runner route-drawing web app (vanilla JS + Mapbox GL JS). Design a route on a
map, see distance/time instantly — not turn-by-turn A→B navigation.
Differentiator: route *design/sculpting*, not navigation.

## Files
- `index.html` — HUD (stats + controls), reorder panel, map div. Loads Mapbox
  GL JS, `tokens.js` (gitignored, holds `MAPBOX_TOKEN`), `script.js`.
- `script.js` — all logic.
- `style.css` — layout + HUD/panel styling.
- `.claude/settings.json` — project Claude Code permissions: `Bash(*)` allowed,
  `defaultMode: acceptEdits`. Any session opening this repo auto-runs shell
  commands and auto-accepts edits without prompting. Intentional but worth
  knowing before touching this repo from a new machine/session.

## State (script.js)
- `route[]` — every waypoint, in order (source of truth; reorder/undo/sculpt
  all mutate this then call `rebuildRoute()`).
- `legs[]` — one entry per routed leg: `{coordinates, distance, duration}`.
- `roadRoute[]` — flattened coordinates of all legs, for the single accumulated
  line.
- `totalDistance`, `totalDuration` — running totals (meters, seconds).
- `markers[]` — current Marker instances (start=green, newest=red, else gray).
- `isDrawingMode`, `isFollowRoads`, `isDrawingFreehand`, `isDraggingLine`,
  `draggedPointIndex`, `freehandPath` — interaction-mode flags.

## How routing works
`addPoint()`/click pushes into `route[]`, then `rebuildRoute()` re-requests
Directions (`walking` or `driving`, depending on `isFollowRoads`) for every
consecutive pair in `route[]`, rebuilds `legs[]` and `roadRoute[]` from
scratch, and redraws: one source/layer per leg (`route-source-N`/`route-leg-N`,
colored via `legColors[]`) plus the combined `route` source. This means
undo/reorder/sculpt/close-loop all just mutate `route[]` and call
`rebuildRoute()` — no incremental patching.

Free-draw mode (`isFollowRoads` off) skips Directions entirely and pushes
straight lines. Freehand mouse/touch drawing collects raw points into
`freehandPath`, simplifies to ~5 points on release, and feeds them into
`route[]` via `rebuildRoute()`.

Sculpting: clicking/dragging within ~100m of an existing segment inserts a
new point at that position (`draggedPointIndex`) instead of appending — same
`rebuildRoute()` path.

## Status
Roadmap items 1–10 done, plus extras: place search (Mapbox Geocoding),
drag-to-reorder waypoints panel, dark "night" basemap preset, mobile
touch support. Not yet done: elevation, save/share/export, further editing
polish (items 11–13).

## Roadmap
11. Elevation
12. Save/share/export routes
13. More advanced route editing

## Notes
- Mapbox telemetry `ERR_BLOCKED_BY_CLIENT` console error is harmless, ignore.
- Keep diffs small and scoped to one roadmap item at a time.
- `rebuildRoute()` re-fetches Directions for every leg on every mutation —
  fine at prototype scale, but will get slow/rate-limited with many waypoints
  or during a drag; worth revisiting before adding more editing features.
