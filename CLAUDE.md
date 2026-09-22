
# Draw Route

Runner route-drawing web app (vanilla JS + Mapbox GL JS). Design a route on a
map, see distance/time instantly — not turn-by-turn A→B navigation.
Differentiator: route *design/sculpting*, not navigation.

## Files
- `index.html` — HUD div + map div, loads Mapbox GL JS, `tokens.js` (gitignored,
  holds `MAPBOX_TOKEN`), `script.js`.
- `script.js` — all logic.
- `style.css` — layout + HUD styling.

## State (script.js)
- `route[]` — every clicked point, ever.
- `currentPoints[]` — last 2 clicked points (used to request the next leg).
- `roadRoute[]` — accumulated road-snapped coordinates for the full line.
- `totalDistance`, `totalDuration` — running totals across all legs (meters, seconds).

## How routing works
Click on map → push point → call Mapbox Directions API (`walking` profile) for
`currentPoints` (last 2) → append returned leg's coordinates to `roadRoute`
(drop the leg's first coord after leg 1 to avoid duplicate join point) → add
leg's distance/duration to totals → redraw `route-line` layer from `roadRoute`
→ update HUD text.

## Status
Multi-point routing (A→B→C→D accumulates, doesn't overwrite) — done.

## Roadmap (in order)
1. Neon route, different color per leg
2. Better markers: start / old points / newest red
3. Close Loop: last point → first point
4. Runner HUD: distance, walking time, running time, pace
5. User-selected running pace
6. Undo + Clear
7. Start Drawing mode
8. Follow Roads ↔ Free Draw
9. Mouse/touch freehand drawing
10. Route sculpting: drag the middle of a route to reshape it (A→B becomes A→C→B)
11. Elevation
12. Save/share/export routes
13. More advanced route editing

## Notes
- Mapbox telemetry `ERR_BLOCKED_BY_CLIENT` console error is harmless, ignore.
- Keep diffs small and scoped to one roadmap item at a time.
