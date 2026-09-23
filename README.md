# Routr

### 🏃 [**Open the live app →**](https://nathanielbierig.github.io/point-map/)
### https://nathanielbierig.github.io/point-map/

No account, no install, no setup — works on any device, any network.

---

Plan a running route by drawing it directly on a map — see distance, time,
and pace instantly.

## What it's for

**Route planning.** Click points on the map to build a route leg by leg.
Routr snaps each leg to real roads/paths (or draws a straight line through
parks and trails that aren't mapped), and gives you a live distance,
walking time, running time, and pace as you build it — so you can plan a
route to a specific distance before you ever leave the house.

**Run corrections.** GPS watches and phones lose signal under tree cover,
in tunnels, and near tall buildings, which under- or over-counts distance
on the recorded track. If your run didn't track cleanly, redraw the route
you actually ran in Routr against the map to get an accurate distance and
pace instead of trusting a GPS-corrupted number.

## Features

- **Draw on the map** — click to add waypoints; each leg snaps to roads by
  default
- **Freehand draw** — trace a path directly (e.g. around a park loop or
  trail) instead of clicking point by point
- **Follow Roads toggle** — switch between road-snapped and straight-line
  legs per section of the route
- **Route sculpting** — drag near an existing line to insert a new point,
  or drag an existing point to reshape the route around it
- **Select & delete a point** — click any waypoint for its address and a
  delete option; the route reconnects automatically
- **Reorder panel** — drag waypoints into a new order, shown by address
- **Search** — find a place by name and drop it as a waypoint
- **Add current location** — add your GPS position as a waypoint
- **Close Loop** — connect the last point back to the first for an
  out-and-back or loop route
- **Live HUD** — distance, walking time, running time, and pace, with a
  km/mi toggle and a typeable pace field
- **Undo / Clear**

## Tech

Vanilla JavaScript, no build step or framework. [Mapbox GL
JS](https://docs.mapbox.com/mapbox-gl-js/) for the map and rendering,
Mapbox Directions and Geocoding APIs for road-snapping and search.

## Development

For editing the code — not needed to just use the app (use the live link
above for that).

```
python -m http.server 8000
```

Then open `http://localhost:8000`. You'll need your own `tokens.js`
(gitignored, never committed) with a Mapbox access token:

```js
const MAPBOX_TOKEN = "pk.your_token_here";
```

## Deployment

Pushes to `main` auto-deploy to GitHub Pages via
`.github/workflows/deploy.yml`, which injects the Mapbox token from the
`MAPBOX_TOKEN` repository secret at build time — the token is never
committed to the repo.
