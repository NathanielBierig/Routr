// On-screen error banner: with no live device/remote-debugging access
// available for reproducing a mobile-only "map won't load" report, silent
// console.error/console.warn calls are useless - nobody can read them.
// This surfaces any JS error, unhandled promise rejection, or Mapbox error
// directly on the page itself, in plain text, so a report can include the
// actual error message instead of just "it doesn't work."
function showDebugBanner(message, opts) {
    let banner = document.getElementById("debugBanner");
    if (!banner) {
        banner = document.createElement("div");
        banner.id = "debugBanner";
        banner.style.cssText =
            "position:fixed;top:0;left:0;right:0;z-index:9999;" +
            "background:#3a0a0a;color:#ffb4b4;font:12px/1.4 monospace;" +
            "padding:10px 40px 10px 12px;max-height:40vh;overflow-y:auto;" +
            "white-space:pre-wrap;word-break:break-word;border-bottom:2px solid #ff4444;";
        const closeBtn = document.createElement("button");
        closeBtn.textContent = "×";
        closeBtn.style.cssText =
            "position:absolute;top:4px;right:8px;background:none;border:none;" +
            "color:#ffb4b4;font-size:22px;cursor:pointer;padding:0 6px;line-height:1;";
        closeBtn.addEventListener("click", () => banner.remove());
        banner.appendChild(closeBtn);
        document.body.appendChild(banner);
    }
    // Collapse repeats of the same message into a "xN" counter instead of
    // one new line per occurrence - a single failed tileset can fire the
    // underlying error once per in-flight tile request (dozens at once),
    // which otherwise floods the banner with 30+ identical lines.
    if (opts && opts.dedup) {
        const lastLine = banner.lastElementChild;
        if (lastLine && lastLine.dataset && lastLine.dataset.rawMessage === message) {
            const count = parseInt(lastLine.dataset.count || "1", 10) + 1;
            lastLine.dataset.count = String(count);
            lastLine.textContent = `${message} (x${count})`;
            return;
        }
    }
    const line = document.createElement("div");
    line.textContent = message;
    line.dataset.rawMessage = message;
    line.dataset.count = "1";
    banner.appendChild(line);
}

function hasWebGLSupport() {
    try {
        const canvas = document.createElement("canvas");
        return !!(window.WebGLRenderingContext &&
            (canvas.getContext("webgl") || canvas.getContext("experimental-webgl")));
    } catch (err) {
        return false;
    }
}

window.addEventListener("error", (e) => {
    showDebugBanner(`JS error: ${e.message} @ ${e.filename ? e.filename.split("/").pop() : "?"}:${e.lineno}`);
});
window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason && e.reason.message ? e.reason.message : e.reason;
    showDebugBanner(`Unhandled rejection: ${reason}`);
});

if (!hasWebGLSupport()) {
    showDebugBanner(
        "This browser reports no WebGL support, which Mapbox GL JS needs to " +
        "render the map. Try a different browser, or check for a content/" +
        "script blocker or a restricted browsing mode."
    );
}

mapboxgl.accessToken = MAPBOX_TOKEN;

// Mapbox GL JS does NOT correctly shape right-to-left scripts (Hebrew,
// Arabic) out of the box - without this plugin, place labels in RTL
// languages render with their characters in the wrong order (reported:
// Hebrew location names in Israel showing backwards). `true` lazy-loads
// the plugin only if an RTL-script label is actually encountered, so it
// costs nothing for maps that never need it.
mapboxgl.setRTLTextPlugin(
    "https://api.mapbox.com/mapbox-gl-js/plugins/mapbox-gl-rtl-text/v0.3.0/mapbox-gl-rtl-text.js",
    null,
    true
);

const map = new mapboxgl.Map({
    container: "map",
    style: "mapbox://styles/mapbox/standard",
    config: {
        basemap: {
            lightPreset: "night"
        }
    },
    // Where the map starts when we can't get the user's location (denied,
    // unavailable, still loading): Times Square.
    center: [-73.9855, 40.7580],
    zoom: 14
});

// The Standard style is 3D/WebGL2-heavy (terrain, lighting presets) and can
// fail to render - silently, with the HUD/controls still working fine since
// those are plain DOM, just the map canvas staying blank/gray - on older or
// resource-constrained mobile browsers that don't fully support it, even
// with a valid token and no content blocking. If Mapbox GL JS reports an
// error, fall back once to the classic dark-v11 style, which needs far
// less GPU capability and keeps the same dark aesthetic (no 3D lighting
// config, so the lightPreset/fog/projection calls tuned for Standard don't
// apply to it - that's fine, dark-v11 doesn't need them to render dark).
// Both mapbox://styles/mapbox/standard AND every classic style (dark-v11
// included) declare a "composite" source that bundles several tilesets
// into one mapbox://a,b,c URL - that's baked into Mapbox's own official
// style JSON, not something this app controls. If an account can't access
// composite/multi-tileset requests (confirmed via direct testing: single-
// tileset requests succeed, the identical composite request 403s, on both
// the Standard and dark-v11 tileset bundles) - a real, observed Mapbox
// account-permission state distinct from an invalid/restricted token -
// then EVERY official Mapbox style fails the same way, and dark-v11 alone
// isn't a real fallback. This minimal style below only references a
// single tileset (mapbox.mapbox-streets-v8), confirmed independently
// reachable, so it survives that condition. It's deliberately simple -
// roads, water, parks, buildings, labels - not a full design, just enough
// to route-plan by while the account-level issue gets resolved.
const MINIMAL_FALLBACK_STYLE = {
    version: 8,
    name: "Routr Minimal Fallback",
    sources: {
        streets: { type: "vector", url: "mapbox://mapbox.mapbox-streets-v8" }
    },
    glyphs: "mapbox://fonts/mapbox/{fontstack}/{range}.pbf",
    layers: [
        { id: "background", type: "background", paint: { "background-color": "#0f0f15" } },
        { id: "water", type: "fill", source: "streets", "source-layer": "water", paint: { "fill-color": "#0a1a2a" } },
        { id: "landuse-park", type: "fill", source: "streets", "source-layer": "landuse", filter: ["==", ["get", "class"], "park"], paint: { "fill-color": "#12241a" } },
        { id: "building", type: "fill", source: "streets", "source-layer": "building", paint: { "fill-color": "#1a1a26", "fill-opacity": 0.8 } },
        { id: "road-minor", type: "line", source: "streets", "source-layer": "road", filter: ["in", ["get", "class"], ["literal", ["street", "street_limited", "service", "track", "path"]]], paint: { "line-color": "#2a2a3a", "line-width": 1 } },
        { id: "road-major", type: "line", source: "streets", "source-layer": "road", filter: ["in", ["get", "class"], ["literal", ["primary", "secondary", "tertiary", "trunk"]]], paint: { "line-color": "#3a3a4a", "line-width": 1.5 } },
        { id: "road-motorway", type: "line", source: "streets", "source-layer": "road", filter: ["==", ["get", "class"], "motorway"], paint: { "line-color": "#4a4a5a", "line-width": 2 } },
        { id: "place-label", type: "symbol", source: "streets", "source-layer": "place_label", layout: { "text-field": ["get", "name"], "text-size": 12 }, paint: { "text-color": "#8888aa", "text-halo-color": "#0f0f15", "text-halo-width": 1 } }
    ]
};

let styleFallbackTier = 0;
map.on("error", (e) => {
    const msg = (e && e.error && e.error.message) || "unknown error";
    console.error("Mapbox error:", e && e.error);
    // Dedup: a single failed composite tileset can fire this once per
    // in-flight tile request (dozens at once), which used to flood the
    // on-screen banner with the same line repeated 30+ times - unreadable,
    // and real wasted DOM work on top of the actual problem.
    showDebugBanner(`Mapbox error: ${msg}`, { dedup: true });

    if (styleFallbackTier === 0) {
        styleFallbackTier = 1;
        console.warn("Falling back to mapbox://styles/mapbox/dark-v11 after a map error.");
        showDebugBanner("Falling back to a simpler map style...", { dedup: true });
        map.setStyle("mapbox://styles/mapbox/dark-v11");
    } else if (styleFallbackTier === 1) {
        styleFallbackTier = 2;
        console.warn("dark-v11 also failed - falling back to a minimal single-tileset style.");
        showDebugBanner("That also failed - switching to a minimal map style...", { dedup: true });
        map.setStyle(MINIMAL_FALLBACK_STYLE);
    }
    // styleFallbackTier === 2: already on the minimal style, nothing further to fall back to.
});

// State
const route = [];
// legModes[i] records whether the leg between route[i] and route[i+1] was
// created as road-snapped (true) or straight-line (false). Previously
// rebuildRoute() re-derived every leg from a single global isFollowRoads on
// every call, which meant toggling Follow Roads or Freehand mode silently
// rewrote ALL existing legs on the next edit - e.g. drawing on roads, then
// freehand-tracing a park loop, then tapping one more point would re-snap
// the freehand park legs to the nearest roads, destroying the traced shape.
// legModes makes mode a property of each leg at creation time, not a global
// applied retroactively to the whole route.
const legModes = [];
const legs = [];
let roadRoute = [];
let totalDistance = 0;
let totalDuration = 0;
let markers = [];
let isFollowRoads = true;
let isDraggingLine = false;
let draggedPointIndex = -1;
let isLoading = false;

// Freehand draw mode: lock the map (no panning), drag to trace a path
// (e.g. loop around a park), release to commit it as straight-line
// segments between the captured points - distance "as the crow flies"
// leg by leg, which in aggregate approximates the traced path closely.
let isFreehandMode = false;
let isCapturingFreehand = false;
let freehandCapturePath = [];
let followRoadsBeforeFreehand = true;
// 4m produced a captured point (and therefore a route waypoint + marker)
// roughly every step, so a single loop around a park turned into hundreds
// of vertices/markers - way too dense to be readable. 20m still traces a
// recognizable path shape while cutting vertex count by ~5x.
const MIN_FREEHAND_POINT_METERS = 20;

// Tracks how many route[] points each user action added, in order, so
// undo() can pop a whole action (e.g. a 20-point freehand stroke) in one
// press instead of requiring one Undo click per captured point.
let undoGroups = [];

// Neon colors for legs (cycle through). Was only 6 truly unique colors
// padded to array-length 8 by repeating the first two, so any route with
// 7-8+ legs (a realistic detailed loop) already started repeating a color
// well before the intended "every 8th leg" recycling.
const legColors = [
    '#FF006E', '#FB5607', '#FFBE0B', '#8338EC',
    '#3A86FF', '#06FFA5', '#FF4D9D', '#00D4FF'
];

function getPaceInput() {
    return parseFloat(document.getElementById("paceInput").value) || 5;
}

let useMiles = false;
const KM_PER_MILE = 1.60934;

function debounce(fn, delay) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => fn.apply(this, args), delay);
    };
}

// showLoading only dimmed #map - nothing stopped a user from stacking
// Undo/Clear/Follow-Roads-toggle clicks (all HUD buttons, outside #map)
// during an in-flight Directions API call, which is exactly what could
// trigger the rebuildRoute() race the generation-token guard now recovers
// from. Disabling these buttons too prevents the race from being triggered
// in the first place, rather than just surviving it.
const ACTION_BUTTON_IDS = ['toggleFollowRoads', 'undoBtn', 'clearBtn', 'closeLoopBtn'];

function showLoading() {
    isLoading = true;
    const map_el = document.getElementById("map");
    map_el.style.opacity = "0.7";
    map_el.style.pointerEvents = "none";
    ACTION_BUTTON_IDS.forEach(id => {
        const btn = document.getElementById(id);
        if (btn) btn.disabled = true;
    });
}

function hideLoading() {
    isLoading = false;
    const map_el = document.getElementById("map");
    map_el.style.opacity = "1";
    map_el.style.pointerEvents = "auto";
    ACTION_BUTTON_IDS.forEach(id => {
        const btn = document.getElementById(id);
        if (btn) btn.disabled = false;
    });
}

function updateHUD() {
    const distanceKm = totalDistance / 1000;
    const distanceInUnit = useMiles ? distanceKm / KM_PER_MILE : distanceKm;
    const unitLabel = useMiles ? "mi" : "km";
    const walkingMinutes = totalDuration / 60;
    const pace = getPaceInput();
    // Running time = distance x pace (pace is minutes PER UNIT, e.g. "5
    // min/km" means each km takes 5 minutes - so 5.9km at 5 min/km is
    // 5.9 x 5 = 29.5 minutes). This was previously (distance / pace) * 60,
    // which is not a meaningful formula for this at all - it inflated
    // running time by roughly a factor of 12 at a 5 min/km pace (a 5.9km
    // route reported 71 minutes instead of the correct ~29.5).
    const runningMinutes = distanceInUnit * pace;

    document.getElementById("distance").textContent = `Distance: ${distanceInUnit.toFixed(2)} ${unitLabel}`;
    document.getElementById("walkingTime").textContent = `Walking: ${Math.round(walkingMinutes)} min`;
    document.getElementById("runningTime").textContent = `Running: ${Math.round(runningMinutes)} min`;
    document.getElementById("pace").textContent = `Pace: ${pace.toFixed(1)} min/${unitLabel}`;
    document.getElementById("hudSummary").textContent = `Distance: ${distanceInUnit.toFixed(2)} ${unitLabel}`;
}

// Pans/zooms the map to show the whole route. Clicking points one at a
// time never needs this (the user is already looking at where they
// clicked), but a full-route replacement (a suggested route, a loaded
// saved route) can land anywhere relative to the current view - one
// casual-user report described a route appearing to "silently fail" to
// show up after applying a suggestion, which this makes impossible
// regardless of whether that specific report was a timing fluke.
function fitMapToRoute() {
    const points = roadRoute.length >= 2 ? roadRoute : route;
    if (points.length < 2) return;
    const bounds = points.reduce(
        (b, c) => b.extend(c),
        new mapboxgl.LngLatBounds(points[0], points[0])
    );
    map.fitBounds(bounds, { padding: 60 });
}

function updateMarkers() {
    markers.forEach(m => m.remove());
    markers = [];

    const markerSize = window.innerWidth < 768 ? '10px' : '12px';
    const borderWidth = window.innerWidth < 768 ? '1.5px' : '2px';

    route.forEach((point, idx) => {
        // Close Loop pushes route[0]'s coordinates again as the final
        // point, so a closed loop's start and "end" markers land exactly
        // on top of each other - two different-colored, independently
        // draggable markers stacked at one spot, impossible to tell apart
        // or grab the one you mean to. Only render the start marker there;
        // the loop-closing point still exists in route[]/legs, it's just
        // not given its own separate marker.
        if (idx > 0 && idx === route.length - 1 && point[0] === route[0][0] && point[1] === route[0][1]) {
            return;
        }

        let color = '#888888';
        if (idx === 0) color = '#00AA44';
        else if (idx === route.length - 1) color = '#FF0000';

        const el = document.createElement('div');
        el.style.width = markerSize;
        el.style.height = markerSize;
        el.style.backgroundColor = color;
        el.style.borderRadius = '50%';
        el.style.border = `${borderWidth} solid white`;
        el.style.cursor = 'grab';
        el.style.boxShadow = `0 0 8px ${color}80`;
        el.style.transition = 'box-shadow 0.2s';

        // Existing waypoints are draggable in place - dragging a point
        // moves it and both adjacent legs (its own leg-in and leg-out)
        // rebuild automatically since rebuildRoute() always recomputes
        // every leg from the current route array.
        const marker = new mapboxgl.Marker({ element: el, draggable: true })
            .setLngLat(point)
            .addTo(map);

        // Distinguishes a plain click (open the info/delete popup) from a
        // drag-release (Mapbox also fires a click on the marker element at
        // the end of a drag) - without this, dragging a point would also
        // pop the info panel open.
        let didDrag = false;

        marker.on('dragstart', () => { el.style.cursor = 'grabbing'; didDrag = false; });
        marker.on('drag', () => { didDrag = true; });

        marker.on('dragend', async () => {
            el.style.cursor = 'grab';
            const lngLat = marker.getLngLat();
            route[idx] = [lngLat.lng, lngLat.lat];
            await rebuildRoute();
            updateMarkers();
        });

        el.addEventListener('click', (e) => {
            e.stopPropagation();
            if (didDrag) return;
            showPointInfoPopup(idx, route[idx]);
        });

        markers.push(marker);
    });

    // Every route change comes through here, so keep the Suggest Route
    // panel's start pin/note in step with whether a first point exists.
    updateSuggestStartInfo();
}

let activeInfoPopup = null;

async function showPointInfoPopup(idx, point) {
    if (activeInfoPopup) activeInfoPopup.remove();

    const popupEl = document.createElement('div');
    popupEl.className = 'point-info-popup';
    popupEl.innerHTML = `
        <div class="point-info-address">Loading address...</div>
        <button class="point-info-delete">Delete Point</button>
    `;

    activeInfoPopup = new mapboxgl.Popup({ closeButton: true, closeOnClick: false, offset: 16, className: 'point-info-popup-wrap' })
        .setLngLat(point)
        .setDOMContent(popupEl)
        .addTo(map);

    popupEl.querySelector('.point-info-delete').addEventListener('click', () => deletePoint(idx));

    const address = await getAddressFromCoords(point[0], point[1]);
    // The popup may have been closed (or replaced by a click on another
    // point) while the reverse-geocode request was in flight.
    if (activeInfoPopup && activeInfoPopup.isOpen()) {
        const addrEl = popupEl.querySelector('.point-info-address');
        if (addrEl) addrEl.textContent = address;
    }
}

function deletePoint(index) {
    if (index < 0 || index >= route.length) return;

    const isFirst = index === 0;
    const isLast = index === route.length - 1;
    route.splice(index, 1);

    // Removing a middle point merges its two adjacent legs into one; keep
    // the mode of the leg before it rather than guessing.
    if (isFirst) {
        if (legModes.length > 0) legModes.splice(0, 1);
    } else if (isLast) {
        legModes.splice(index - 1, 1);
    } else {
        const mergedMode = legModes[index - 1];
        legModes.splice(index - 1, 2, mergedMode);
    }
    // Point counts no longer line up with prior actions' undo groups after
    // an out-of-order deletion - reset to one group per remaining point,
    // same as after a reorder.
    undoGroups = route.map(() => 1);

    if (activeInfoPopup) {
        activeInfoPopup.remove();
        activeInfoPopup = null;
    }

    rebuildRoute();
    updateMarkers();
    updateHUD();
}

function getDistanceInMiles(lat1, lon1, lat2, lon2) {
    const R = 3959;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

// Elevation profile. Computed lazily - only when the Elevation panel is
// actually opened, never automatically on every route edit - since each
// sample point costs a real Mapbox tile request (Terrain-RGB), and this
// app's whole design has been about not burning API quota on things the
// user isn't actively looking at. Terrain-RGB is a SINGLE tileset (not
// the composite multi-tileset bundle official styles need), so it isn't
// affected by the account-level composite-access issue documented above.
const terrainTileCache = new Map();

function lngLatToTileFloat(lng, lat, zoom) {
    const n = Math.pow(2, zoom);
    const x = (lng + 180) / 360 * n;
    const latRad = lat * Math.PI / 180;
    const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
    return { x, y };
}

function loadTerrainTile(zoom, x, y) {
    const key = `${zoom}/${x}/${y}`;
    if (terrainTileCache.has(key)) return terrainTileCache.get(key);
    const promise = new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
            const canvas = document.createElement("canvas");
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0);
            resolve(ctx);
        };
        img.onerror = reject;
        img.src = `https://api.mapbox.com/v4/mapbox.terrain-rgb/${zoom}/${x}/${y}.pngraw?access_token=${mapboxgl.accessToken}`;
    });
    terrainTileCache.set(key, promise);
    return promise;
}

async function getElevationAtPoint(lng, lat, zoom = 14) {
    const tileFloat = lngLatToTileFloat(lng, lat, zoom);
    const tx = Math.floor(tileFloat.x);
    const ty = Math.floor(tileFloat.y);
    const ctx = await loadTerrainTile(zoom, tx, ty);
    const px = Math.min(255, Math.floor((tileFloat.x - tx) * 256));
    const py = Math.min(255, Math.floor((tileFloat.y - ty) * 256));
    const [r, g, b] = ctx.getImageData(px, py, 1, 1).data;
    // Mapbox's documented Terrain-RGB decode formula.
    return -10000 + ((r * 256 * 256 + g * 256 + b) * 0.1);
}

// Picks numSamples points evenly spaced BY DISTANCE (not by index) along
// a dense polyline - a route with long straight stretches and tight turns
// has points bunched unevenly, so sampling by raw index would waste
// samples on the dense sections and miss the sparse ones.
function sampleRouteByDistance(points, numSamples) {
    if (points.length === 0) return [];
    const cumDist = [0];
    for (let i = 1; i < points.length; i++) {
        const d = getDistanceInMiles(points[i - 1][1], points[i - 1][0], points[i][1], points[i][0]) * 1609.34;
        cumDist.push(cumDist[i - 1] + d);
    }
    const total = cumDist[cumDist.length - 1];
    if (total === 0) return [{ point: points[0], distanceM: 0 }];

    const samples = [];
    for (let s = 0; s <= numSamples; s++) {
        const targetDist = (total * s) / numSamples;
        let idx = cumDist.findIndex(d => d >= targetDist);
        if (idx <= 0) idx = 1;
        const d0 = cumDist[idx - 1], d1 = cumDist[idx];
        const t = d1 > d0 ? (targetDist - d0) / (d1 - d0) : 0;
        const p0 = points[idx - 1], p1 = points[idx];
        samples.push({
            point: [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t],
            distanceM: targetDist
        });
    }
    return samples;
}

const ELEVATION_SAMPLE_COUNT = 40;

async function computeElevationProfile() {
    if (roadRoute.length < 2) return null;
    const samples = sampleRouteByDistance(roadRoute, ELEVATION_SAMPLE_COUNT);
    const elevations = await Promise.all(samples.map(s => getElevationAtPoint(s.point[0], s.point[1])));

    let gainM = 0, lossM = 0;
    for (let i = 1; i < elevations.length; i++) {
        const diff = elevations[i] - elevations[i - 1];
        if (diff > 0) gainM += diff; else lossM += -diff;
    }

    const totalKm = totalDistance / 1000;
    const gainPerKm = totalKm > 0 ? gainM / totalKm : 0;
    // Rough, not a scientifically calibrated grading system - just enough
    // to flag "this one's going to feel harder" at a glance.
    let difficulty = "Easy";
    if (gainPerKm > 50) difficulty = "Hard";
    else if (gainPerKm > 20) difficulty = "Moderate";

    return {
        points: samples.map((s, i) => ({ distanceKm: s.distanceM / 1000, elevationM: elevations[i] })),
        gainM, lossM, difficulty
    };
}

function renderElevationChart(profile) {
    const w = 260, h = 100, pad = 6;
    const elevations = profile.points.map(p => p.elevationM);
    const minE = Math.min(...elevations), maxE = Math.max(...elevations);
    const range = Math.max(maxE - minE, 1);
    const maxDist = profile.points[profile.points.length - 1].distanceKm || 1;

    const linePoints = profile.points.map(p => {
        const x = pad + (p.distanceKm / maxDist) * (w - 2 * pad);
        const y = h - pad - ((p.elevationM - minE) / range) * (h - 2 * pad);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
    const fillPoints = `${pad},${h - pad} ${linePoints} ${w - pad},${h - pad}`;

    return `
        <div class="elevation-chart-wrap">
            <svg viewBox="0 0 ${w} ${h}" width="100%" height="120" preserveAspectRatio="none">
                <polygon points="${fillPoints}" fill="#00ff8822"/>
                <polyline points="${linePoints}" fill="none" stroke="#00ff88" stroke-width="2"/>
            </svg>
            <div class="elevation-minmax">
                <span>Min: ${minE.toFixed(0)} m</span>
                <span>Max: ${maxE.toFixed(0)} m</span>
            </div>
        </div>
    `;
}

async function updateElevationPanel() {
    const content = document.getElementById("elevationContent");
    if (roadRoute.length < 2) {
        content.innerHTML = `<div class="direction-empty">Draw a route to see its elevation profile.</div>`;
        return;
    }
    content.innerHTML = `<div class="direction-empty">Calculating elevation...</div>`;
    try {
        const profile = await computeElevationProfile();
        content.innerHTML = `
            <div class="elevation-stats">
                <div>Gain<br>${Math.round(profile.gainM)} m</div>
                <div>Loss<br>${Math.round(profile.lossM)} m</div>
                <div>${profile.difficulty}</div>
            </div>
            ${renderElevationChart(profile)}
        `;
    } catch (err) {
        console.error("Elevation fetch failed:", err);
        content.innerHTML = `<div class="direction-empty">Couldn't load elevation data.</div>`;
    }
}

// GPX export - a route[]/legModes[] pair only means anything to this app;
// a .gpx file is the portable format watches, Strava, and other routing
// apps actually understand, which is the whole point of planning a route
// here ahead of a run.
function buildGPX() {
    const points = roadRoute.length >= 2 ? roadRoute : route;
    const trkpts = points.map(p => `      <trkpt lat="${p[1]}" lon="${p[0]}"></trkpt>`).join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<gpx version="1.1" creator="Routr" xmlns="http://www.topografix.com/GPX/1/1">\n` +
        `  <trk>\n    <name>Routr Route</name>\n    <trkseg>\n${trkpts}\n    </trkseg>\n  </trk>\n</gpx>`;
}

function exportGPX() {
    if (route.length < 2) {
        alert("Draw a route before exporting.");
        return;
    }
    const blob = new Blob([buildGPX()], { type: "application/gpx+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `routr-route-${Date.now()}.gpx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// EXPERIMENTAL route suggestion. No optimization API or ML - candidate
// loop shapes ringed around a start point at several bearings, each
// scored by asking Mapbox Directions for the REAL road-snapped distance
// (a straight-line guess is unreliable once roads wind around).
function destinationPoint(lng, lat, bearingDeg, distanceKm) {
    const R = 6371;
    const bearing = bearingDeg * Math.PI / 180;
    const lat1 = lat * Math.PI / 180;
    const lon1 = lng * Math.PI / 180;
    const dR = distanceKm / R;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(dR) + Math.cos(lat1) * Math.sin(dR) * Math.cos(bearing));
    const lon2 = lon1 + Math.atan2(
        Math.sin(bearing) * Math.sin(dR) * Math.cos(lat1),
        Math.cos(dR) - Math.sin(lat1) * Math.sin(lat2)
    );
    return [lon2 * 180 / Math.PI, lat2 * 180 / Math.PI];
}

// Builds candidate sets for a given shape: "outback" (straight there-and-
// back), "triangle" (start + 2 interior points), or "square" (start + 3).
// Radius is divided by the number of legs (not halved like an out-and-
// back) since a loop's total length is the sum of all its legs, then by
// 1.3 as a rough real-world road-indirection factor - roads rarely run
// straight toward a target, so a candidate placed at the raw straight-
// line radius usually comes back SHORTER than target once road-snapped.
const SUGGEST_INDIRECTION = 1.45; // measured: real walking routes run ~1.4-1.5x the straight-line size
const SUGGEST_SHAPE_LABELS = { triangle: "Triangle loop", square: "Square loop", outback: "Out & back" };

// shape: "triangle" | "square" | "outback" | "simplest". "simplest" mixes all
// three (with fewer bearings each, to keep the request count down) and lets
// the turn count decide which shape wins. Each candidate carries its own
// `shape` so results can say what they are.
function buildSuggestCandidateSets(targetKm, shape) {
    const dense = shape !== "simplest";
    const make = (s, legs, bearingLists) => bearingLists.map(b => ({
        shape: s,
        radiusKm: (targetKm / legs) / SUGGEST_INDIRECTION,
        bearings: b
    }));
    const triangle = () => make("triangle", 3,
        (dense ? [0, 90, 180, 270] : [0, 120, 240]).flatMap(base => [110, 140].map(spread => [base, base + spread])));
    const square = () => make("square", 4,
        (dense ? [0, 30, 60, 90] : [0, 30, 60]).map(base => [base, base + 90, base + 180]));
    const outback = () => make("outback", 2,
        (dense ? [0, 45, 90, 135, 180, 225, 270, 315] : [0, 60, 120, 180, 240, 300]).map(b => [b]));

    if (shape === "triangle") return triangle();
    if (shape === "square") return square();
    if (shape === "outback") return outback();
    return [...triangle(), ...square(), ...outback()];
}

// Counts the direction changes a runner has to deal with, from Mapbox's own
// turn-by-turn steps: real turns (slight bends count half), forks, ends of
// road and roundabouts - not "continue" / "new name" steps where the road
// just changes its label. The route's via-waypoints (the corners of the
// shape) are added by the caller, because Directions reports those as an
// "arrive" then a "depart" rather than as a turn.
function countStepTurns(directionsRoute) {
    let turns = 0;
    for (const leg of directionsRoute.legs || []) {
        for (const step of leg.steps || []) {
            const m = step.maneuver || {};
            if (m.type === "turn") {
                if (m.modifier === "straight") continue;
                turns += (m.modifier === "slight left" || m.modifier === "slight right") ? 0.5 : 1;
            } else if (["end of road", "fork", "roundabout", "rotary", "roundabout turn"].includes(m.type)) {
                turns += 1;
            }
        }
    }
    return turns;
}

async function fetchSuggestCandidate(start, waypoints, shape) {
    try {
        const coords = [start, ...waypoints, start].map(p => p.join(",")).join(";");
        const url = `https://api.mapbox.com/directions/v5/mapbox/walking/${coords}` +
            `?geometries=geojson&steps=true&access_token=${mapboxgl.accessToken}`;
        const response = await fetch(url);
        const data = await response.json();
        if (!data.routes || data.routes.length === 0) return null;
        const result = data.routes[0];
        return {
            // The start these candidates were measured from. Kept on the
            // option so committing uses THIS point - previewing a route
            // pans/zooms the map, so re-reading the map center at commit
            // time would start the route somewhere other than the preview.
            start,
            shape,
            waypoints,
            // Where Mapbox actually snapped each intermediate waypoint to the
            // walking network. Committing the ROUTE with these (not the raw
            // computed points) matters: the route is rebuilt leg by leg, and
            // a raw point sitting off the network (a river, a pier) can snap
            // to a different place for each leg - one live case measured a
            // 2.5 km leg out and a 17.2 km leg back for a "4.95 km" preview.
            snappedWaypoints: (data.waypoints || []).slice(1, -1).map(w => w.location),
            distanceKm: result.distance / 1000,
            coordinates: result.geometry.coordinates,
            turns: Math.round(countStepTurns(result) + waypoints.length)
        };
    } catch (err) {
        return null;
    }
}

// Finds up to 3 routes of about `targetKm` starting (and ending) at `start`,
// preferring the ones with the fewest turns - the easiest to follow mid-run.
//   Pass 1: candidate shapes around the start, measured on real roads.
//   Pass 2: each candidate is rescaled by (target / what it actually
//           measured) and measured again, so distances land close to what
//           was asked instead of overshooting by the road-winding factor.
//   Rank:   routes within tolerance of the target come first, fewest turns
//           first (closest distance breaks ties); then the nearest misses.
async function suggestRoutes(targetKm, shape, start) {
    const sets = buildSuggestCandidateSets(targetKm, shape);
    const place = (s, radiusKm) => s.bearings.map(b => destinationPoint(start[0], start[1], b, radiusKm));

    const pass1 = (await Promise.all(sets.map(async (s) => {
        const c = await fetchSuggestCandidate(start, place(s, s.radiusKm), s.shape);
        return c && { ...c, set: s };
    }))).filter(Boolean);

    const pass2 = (await Promise.all(pass1.map((c) => {
        const scale = Math.min(1.8, Math.max(0.5, targetKm / (c.distanceKm || 1)));
        return fetchSuggestCandidate(start, place(c.set, c.set.radiusKm * scale), c.shape);
    }))).filter(Boolean);

    const tolerance = Math.max(0.25, targetKm * 0.08);
    const pool = [...pass1, ...pass2].map(c => {
        const diff = Math.abs(c.distanceKm - targetKm);
        return { ...c, diff, inTolerance: diff <= tolerance };
    });
    pool.sort((a, b) => (b.inTolerance - a.inTolerance) ||
        (a.inTolerance ? (a.turns - b.turns || a.diff - b.diff) : a.diff - b.diff));

    // Drop near-identical duplicates (same shape, turns and ~distance).
    const seen = new Set();
    const picks = [];
    for (const c of pool) {
        const key = `${c.shape}|${c.turns}|${Math.round(c.distanceKm * 20)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        picks.push(c);
        if (picks.length === 3) break;
    }
    return picks;
}

let suggestedOption = null;

function showSuggestPreview(option) {
    suggestedOption = option;
    const data = {
        type: "Feature",
        geometry: { type: "LineString", coordinates: option.coordinates }
    };
    if (!map.getSource("suggest-preview")) {
        map.addSource("suggest-preview", { type: "geojson", data });
        map.addLayer({
            id: "suggest-preview-line",
            type: "line",
            source: "suggest-preview",
            // Same two fixes as the real route layers: emissive strength so
            // Standard's night lighting doesn't dim it to dark olive, and the
            // "middle" slot so it sits on the street under 3D buildings.
            slot: "middle",
            paint: {
                "line-width": 5,
                "line-color": "#FFD700",
                "line-opacity": 0.95,
                "line-dasharray": [2, 1.5],
                "line-emissive-strength": 1
            }
        });
    } else {
        map.getSource("suggest-preview").setData(data);
    }
    const bounds = option.coordinates.reduce(
        (b, c) => b.extend(c),
        new mapboxgl.LngLatBounds(option.coordinates[0], option.coordinates[0])
    );
    map.fitBounds(bounds, { padding: getSuggestFitPadding(), duration: 600 });
    document.getElementById("useSuggestedRouteBtn").disabled = false;
}

// Padding that keeps the previewed route inside the part of the map that's
// actually visible: on a phone the suggest sheet covers the top of the
// screen, on desktop it covers the right-hand 300px. Without this the route
// was framed against the whole window and ended up hidden behind the panel.
function getSuggestFitPadding() {
    const panel = document.getElementById("suggestPanel");
    if (window.matchMedia("(max-width: 768px)").matches) {
        const covered = panel.classList.contains("hidden") ? 0 : panel.getBoundingClientRect().height;
        return { top: covered + 24, bottom: 56, left: 28, right: 28 };
    }
    return { top: 60, bottom: 60, left: 60, right: 360 };
}

// Where suggested routes start. Two choices, always spelled out in the panel:
//   "me"       - the user's current location (a blue dot marks it)
//   "selected" - a point the user chose: their first route point if they've
//                placed one, otherwise a pin at the map center (pan to move it)
// The pin only shows while choosing criteria - once results are in the start
// is fixed, and the previewed line itself starts there.
let suggestStartMode = "me";
let suggestMeLocation = null;   // [lng, lat] once we've found the user
let suggestMeMarker = null;

function setSuggestMeLocation(lng, lat) {
    suggestMeLocation = [lng, lat];
    if (!suggestMeMarker) {
        const el = document.createElement("div");
        el.className = "me-dot";
        suggestMeMarker = new mapboxgl.Marker({ element: el }).setLngLat(suggestMeLocation).addTo(map);
    } else {
        suggestMeMarker.setLngLat(suggestMeLocation);
    }
}

// Switch the start choice. Choosing "me" looks up the location right away
// (so the user sees where we think they are) and falls back to "selected"
// with an explanation if it can't be found.
async function setSuggestStartMode(mode) {
    suggestStartMode = mode;
    updateSuggestStartInfo();
    if (mode !== "me") return;

    const note = document.getElementById("suggestStartNote");
    note.textContent = "Finding your location...";
    try {
        const here = await locateUser({ timeout: 10000, maximumAge: 60000, enableHighAccuracy: false });
        if (suggestStartMode !== "me") return; // user switched while we were looking
        setSuggestMeLocation(here.lng, here.lat);
        map.jumpTo({ center: [here.lng, here.lat], zoom: Math.max(map.getZoom(), 14) });
        updateSuggestStartInfo();
    } catch (err) {
        showToast(describeGeoError(err));
        if (suggestStartMode === "me") {
            suggestStartMode = "selected";
            updateSuggestStartInfo();
        }
    }
}

// The actual [lng, lat] a search will start from, right now.
async function resolveSuggestStart() {
    if (suggestStartMode === "me") {
        try {
            const here = await locateUser({ timeout: 10000, maximumAge: 30000, enableHighAccuracy: false });
            setSuggestMeLocation(here.lng, here.lat);
            return suggestMeLocation;
        } catch (err) {
            if (suggestMeLocation) return suggestMeLocation; // use the last known fix
            showToast(describeGeoError(err));
            suggestStartMode = "selected";
            updateSuggestStartInfo();
        }
    }
    return route.length > 0 ? route[0] : [map.getCenter().lng, map.getCenter().lat];
}

function updateSuggestStartInfo() {
    const panel = document.getElementById("suggestPanel");
    const open = !panel.classList.contains("hidden");
    const choosing = open && !panel.classList.contains("results");
    const hasRoute = route.length > 0;
    const me = suggestStartMode === "me";

    // On phones the sheet sits at the top where the main control panel is;
    // hide that panel while the sheet is open so its lower half doesn't
    // peek out underneath.
    document.body.classList.toggle("suggest-open", open);

    document.getElementById("suggestStartMe").classList.toggle("active", me);
    document.getElementById("suggestStartPin").classList.toggle("active", !me);
    document.getElementById("suggestCenterPin").classList.toggle("hidden", !(choosing && !me && !hasRoute));
    if (suggestMeMarker) {
        suggestMeMarker.getElement().style.display = (open && me) ? "" : "none";
    }

    const note = document.getElementById("suggestStartNote");
    if (me) {
        if (suggestMeLocation) note.textContent = "Starting from your current location (the blue dot).";
    } else if (hasRoute) {
        note.textContent = "Starting from your first route point (the green dot).";
    } else {
        note.textContent = "Starting from the pin at the centre of the map - drag the map to move it.";
    }
}

function clearSuggestPreview() {
    suggestedOption = null;
    if (map.getSource("suggest-preview")) {
        map.getSource("suggest-preview").setData({
            type: "Feature",
            geometry: { type: "LineString", coordinates: [] }
        });
    }
    document.getElementById("useSuggestedRouteBtn").disabled = true;
}

async function useSuggestedRoute() {
    if (!suggestedOption) return;
    const start = suggestedOption.start;
    const snapped = suggestedOption.snappedWaypoints;
    const viaPoints = snapped && snapped.length === suggestedOption.waypoints.length && snapped.every(Boolean)
        ? snapped
        : suggestedOption.waypoints;

    route.length = 0;
    route.push(start, ...viaPoints, start);
    legModes.length = 0;
    for (let i = 0; i < route.length - 1; i++) legModes.push(true);
    // Whole suggestion replaces the route as one atomic action, same
    // treatment as loading a saved route - one Undo press removes it.
    undoGroups = [route.length];

    clearSuggestPreview();
    const panel = document.getElementById("suggestPanel");
    panel.classList.add("hidden");
    panel.classList.remove("results");
    document.getElementById("suggestResults").innerHTML = "";
    document.getElementById("suggestSummary").textContent = "";

    await rebuildRoute();
    updateMarkers();
    updateHUD();
    fitMapToRoute();
}

let searchMarker = null;

async function searchPlace(query) {
    try {
        // Bias results toward wherever the user is actually looking (route
        // start if one exists, otherwise the current map center) - without
        // this, Mapbox's geocoder ranks purely on text match and can return
        // a same-named place on the other side of the country/world ahead
        // of the one 2 blocks away.
        const anchor = route.length > 0 ? route[0] : [map.getCenter().lng, map.getCenter().lat];
        const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json` +
            `?proximity=${anchor[0]},${anchor[1]}&access_token=${mapboxgl.accessToken}`;
        const response = await fetch(url);
        const data = await response.json();

        if (data.features && data.features.length > 0) {
            const feature = data.features[0];
            const coords = [feature.center[0], feature.center[1]];
            const placeName = feature.place_name || feature.text || query;

            // Geofence: if route exists, only allow searches within 25 miles
            if (route.length > 0) {
                const startPoint = route[0];
                const distMiles = getDistanceInMiles(startPoint[1], startPoint[0], coords[1], coords[0]);
                if (distMiles > 25) {
                    const searchInput = document.getElementById("searchInput");
                    searchInput.placeholder = `Too far (${distMiles.toFixed(1)} mi > 25 mi)`;
                    searchInput.value = "";
                    return null;
                }
            }

            map.flyTo({ center: coords, zoom: 14 });

            // Add golden search marker
            if (searchMarker) searchMarker.remove();
            const el = document.createElement('div');
            el.style.width = '16px';
            el.style.height = '16px';
            el.style.backgroundColor = '#FFD700';
            el.style.borderRadius = '50%';
            el.style.border = '3px solid white';
            el.style.boxShadow = '0 0 12px rgba(255, 215, 0, 0.8)';

            searchMarker = new mapboxgl.Marker({ element: el })
                .setLngLat(coords)
                .addTo(map);

            const searchInput = document.getElementById("searchInput");
            searchInput.placeholder = `Located: ${placeName}`;
            searchInput.value = "";

            return coords;
        }
    } catch (err) {
        console.error("Search failed:", err);
    }
    return null;
}

function straightLineLeg(a, b) {
    // Fallback for unmapped park paths/trails: Mapbox's walking profile only
    // routes over OSM ways it knows about. Unmapped park interiors return no
    // route at all, and that leg used to just silently vanish. Draw a direct
    // line instead so the route never breaks.
    const distMeters = getDistanceInMiles(a[1], a[0], b[1], b[0]) * 1609.34;
    const AVG_WALK_MPS = 1.4; // ~5 km/h
    return {
        coordinates: [a, b],
        distance: distMeters,
        duration: distMeters / AVG_WALK_MPS,
        isFallback: true
    };
}

function addFreehandPoint(mapPoint) {
    if (freehandCapturePath.length > 0) {
        const last = freehandCapturePath[freehandCapturePath.length - 1];
        const distMeters = getDistanceInMiles(last[1], last[0], mapPoint[1], mapPoint[0]) * 1609.34;
        if (distMeters < MIN_FREEHAND_POINT_METERS) return;
    }
    freehandCapturePath.push(mapPoint);
    updateFreehandPreview();
}

function updateFreehandPreview() {
    const data = {
        type: "Feature",
        geometry: { type: "LineString", coordinates: freehandCapturePath }
    };
    if (!map.getSource("freehand-preview")) {
        map.addSource("freehand-preview", { type: "geojson", data });
        map.addLayer({
            id: "freehand-preview-line",
            type: "line",
            source: "freehand-preview",
            slot: "middle",
            paint: { "line-width": 6, "line-color": "#00FFFF", "line-opacity": 0.9, "line-emissive-strength": 1 }
        });
    } else {
        map.getSource("freehand-preview").setData(data);
    }
}

function clearFreehandPreview() {
    freehandCapturePath = [];
    if (map.getSource("freehand-preview")) {
        map.getSource("freehand-preview").setData({
            type: "Feature",
            geometry: { type: "LineString", coordinates: [] }
        });
    }
}

async function commitFreehandPath() {
    if (freehandCapturePath.length < 2) {
        clearFreehandPreview();
        return;
    }

    let pointsToAdd = freehandCapturePath;
    // Skip the first captured point if it's essentially where the route
    // already ends, to avoid a zero-length leg when continuing a stroke
    // from the last point.
    if (route.length > 0) {
        const lastRoutePoint = route[route.length - 1];
        const d = getDistanceInMiles(lastRoutePoint[1], lastRoutePoint[0], pointsToAdd[0][1], pointsToAdd[0][0]) * 1609.34;
        if (d < MIN_FREEHAND_POINT_METERS) pointsToAdd = pointsToAdd.slice(1);
    }

    route.push(...pointsToAdd);
    // One undo group for the whole stroke, however many points it captured,
    // so a single Undo press removes the entire freehand trace instead of
    // needing one press per captured point.
    if (pointsToAdd.length > 0) undoGroups.push(pointsToAdd.length);
    // Freehand-committed legs are always straight-line, regardless of the
    // current Follow Roads setting - that's the whole point of the mode.
    while (legModes.length < route.length - 1) legModes.push(false);
    clearFreehandPreview();
    await rebuildRoute();
    updateMarkers();
    updateHUD();
}

async function getRoadRoute(startIdx, endIdx) {
    if (startIdx >= route.length || endIdx >= route.length) return null;

    const a = route[startIdx];
    const b = route[endIdx];

    try {
        const coordinates = [a, b].map(point => point.join(",")).join(";");

        const url =
            `https://api.mapbox.com/directions/v5/mapbox/walking/${coordinates}` +
            `?geometries=geojson&steps=true&access_token=${mapboxgl.accessToken}`;

        const response = await fetch(url);
        const data = await response.json();

        if (data.routes && data.routes.length > 0) {
            const leg = data.routes[0];
            // steps=true gives turn-by-turn instructions per Directions leg
            // (Mapbox's own "legs", one per waypoint pair - here always
            // exactly one, since getRoadRoute is only ever called for a
            // single a->b pair). Each step's maneuver.instruction already
            // includes the street name (e.g. "Turn right onto Main St"),
            // so the Directions panel can show "what to look for" instead
            // of just a distance number.
            const steps = (leg.legs && leg.legs[0] && leg.legs[0].steps) || [];
            return {
                coordinates: leg.geometry.coordinates,
                distance: leg.distance,
                duration: leg.duration,
                steps: steps.map(s => ({
                    instruction: s.maneuver.instruction,
                    distance: s.distance
                }))
            };
        }
        // Mapbox found no walking route (e.g. unmapped park trail) - fall back
        return straightLineLeg(a, b);
    } catch (err) {
        console.error("Route request failed, using straight line fallback:", err);
        return straightLineLeg(a, b);
    }
}

// Generation token: every rebuildRoute() call stamps its own call with the
// current value, incremented up front. Since rebuildRoute() is async and
// can overlap with another call triggered mid-flight (double Undo, a click
// landing while a drag's rebuild is still awaiting the Directions API,
// rapid Follow Roads toggling, etc.), a stale call finishing after a newer
// one must NOT write its results into the shared legs/roadRoute/totals -
// that was a real race condition where two overlapping rebuilds fought over
// the same globals and whichever resolved last silently won, regardless of
// which one was actually still relevant.
let rebuildGeneration = 0;

async function rebuildRoute() {
    const myGeneration = ++rebuildGeneration;

    if (route.length < 2) {
        legs.length = 0;
        roadRoute = [];
        totalDistance = 0;
        totalDuration = 0;
        updateLayers();
        updateHUD();
        return;
    }

    // Snapshot each leg's own mode up front (falling back to the current
    // global for any position legModes hasn't caught up with yet, which
    // shouldn't normally happen but keeps this resilient). isFollowRoads
    // itself can still change while this call awaits API responses, but
    // each leg's rendering choice no longer depends on reading it again -
    // it was decided once, when that leg was created.
    const legModesSnapshot = [];
    for (let i = 0; i < route.length - 1; i++) {
        legModesSnapshot.push(legModes[i] !== undefined ? legModes[i] : isFollowRoads);
    }
    const anyRoadSnapped = legModesSnapshot.some(m => m);
    if (anyRoadSnapped) showLoading();

    const newLegs = [];
    let newRoadRoute = [];
    let newTotalDistance = 0;
    let newTotalDuration = 0;

    // Get each leg - road-snapped (API) or straight line (instant, no API)
    // per THAT leg's own recorded mode, not a single global reapplied to
    // the whole route. This is what lets mixed routes (some legs drawn on
    // roads, some freehand-traced through a park) survive later edits
    // (Undo, sculpting, toggling modes, adding more points) without
    // silently rewriting sections the user already drew.
    for (let i = 0; i < route.length - 1; i++) {
        const legMode = legModesSnapshot[i];
        const legData = legMode
            ? await getRoadRoute(i, i + 1)
            : straightLineLeg(route[i], route[i + 1]);

        // A newer rebuildRoute() call started while we were awaiting the
        // API - abandon this one without touching shared state further.
        // hideLoading() is idempotent/safe to call even if nothing is
        // currently shown, so it's fine if the newer call's own showLoading/
        // hideLoading also runs independently - the important thing is this
        // call always clears whatever IT turned on.
        if (myGeneration !== rebuildGeneration) {
            if (anyRoadSnapped) hideLoading();
            return;
        }

        if (legData) {
            const coords = i === 0 ? legData.coordinates : legData.coordinates.slice(1);
            newLegs.push({
                coordinates: legData.coordinates,
                distance: legData.distance,
                duration: legData.duration,
                isFallback: !!legData.isFallback,
                steps: legData.steps || []
            });
            newRoadRoute.push(...coords);
            newTotalDistance += legData.distance;
            newTotalDuration += legData.duration;
        }
    }

    if (myGeneration !== rebuildGeneration) {
        if (anyRoadSnapped) hideLoading();
        return;
    }

    legs.length = 0;
    legs.push(...newLegs);
    roadRoute = newRoadRoute;
    totalDistance = newTotalDistance;
    totalDuration = newTotalDuration;

    updateLayers();
    updateHUD();
    if (anyRoadSnapped) hideLoading();
}

function updateLayers() {
    if (map.getSource("route")) {
        map.getSource("route").setData({
            type: "Feature",
            geometry: { type: "LineString", coordinates: roadRoute }
        });
    }

    legs.forEach((leg, idx) => {
        const glowLayerId = `route-leg-glow-${idx}`;
        const coreLayerId = `route-leg-${idx}`;
        const sourceId = `route-source-${idx}`;
        const color = legColors[idx % legColors.length];

        if (!map.getSource(sourceId)) {
            map.addSource(sourceId, {
                type: "geojson",
                data: {
                    type: "Feature",
                    geometry: { type: "LineString", coordinates: leg.coordinates }
                }
            });
            // Two-layer neon effect: a wide, blurred, low-opacity glow layer
            // underneath a narrow, fully solid, unblurred core layer. A
            // single blurred layer (the old approach) reads as bright only
            // when zoomed in enough that the blur radius is small relative
            // to the line's screen width; zoomed out, the same blur spreads
            // the color across a proportionally wider halo at lower opacity
            // per pixel, so it visually dims toward the dark basemap. The
            // core layer never blurs, so it stays vividly bright at every
            // zoom level - the glow is purely additive on top of it.
            // The wide blurred glow is continuous regardless of dash style,
            // so a fallback leg's dashed core alone was easy to miss at a
            // glance - the glow made it still read as a mostly-solid band.
            // Cut the glow's opacity/width sharply for fallback legs so the
            // dash pattern in the core actually dominates the impression.
            map.addLayer({
                id: glowLayerId,
                type: "line",
                source: sourceId,
                // Standard style's "slot" system controls where a custom
                // layer sits relative to the style's OWN layers (terrain,
                // 3D buildings, labels) - layers added without one get
                // stacked on top of everything, rendered as a flat overlay
                // that ignores 3D depth entirely. Confirmed via a real
                // zoomed-in screenshot: the route line was drawing straight
                // through buildings that should have hidden it, since the
                // layer wasn't integrated into the 3D scene's draw order at
                // all. "middle" is Standard's slot for data above
                // roads/land but below buildings/labels - letting the
                // route sit on the street surface and get properly
                // occluded by buildings in front of it. Ignored harmlessly
                // by styles with no slot concept (dark-v11, the minimal
                // fallback).
                slot: "middle",
                paint: {
                    "line-width": leg.isFallback ? 10 : 18,
                    "line-color": color,
                    "line-opacity": leg.isFallback ? 0.15 : 0.45,
                    "line-blur": 3,
                    // Mapbox GL JS v3's Standard style applies scene-wide 3D
                    // lighting (the "night" lightPreset's dark ambient
                    // light) to every layer by default, custom ones
                    // included - confirmed via a real rendered screenshot
                    // showing this layer's true paint color (bright neon
                    // hex values) rendering as dark maroon/brown on screen,
                    // despite setFog(null) already fixing the earlier
                    // globe/atmosphere dimming at low zoom. Emissive
                    // strength 1 makes the layer render at its own true
                    // color regardless of ambient scene lighting, the way
                    // neon signage would use emissive material to stay lit
                    // in the dark rather than reflecting available light.
                    "line-emissive-strength": 1
                }
            });
            // Fallback legs (unmapped park/trail interiors with no real
            // walking route found - see straightLineLeg()) get a dashed
            // core so they read as an unverified straight-line guess,
            // distinct from a real road/path-snapped leg.
            map.addLayer({
                id: coreLayerId,
                type: "line",
                source: sourceId,
                slot: "middle",
                paint: {
                    "line-width": 5,
                    "line-color": color,
                    "line-opacity": 1,
                    "line-dasharray": leg.isFallback ? [2, 2] : [1, 0],
                    "line-emissive-strength": 1
                }
            });
        } else {
            map.getSource(sourceId).setData({
                type: "Feature",
                geometry: { type: "LineString", coordinates: leg.coordinates }
            });
            // A leg's fallback status can change between rebuilds (e.g. a
            // dragged waypoint now lands on a real mapped path) - keep both
            // layers' fallback styling in sync on updates too, not just
            // first creation.
            map.setPaintProperty(coreLayerId, "line-dasharray", leg.isFallback ? [2, 2] : [1, 0]);
            map.setPaintProperty(glowLayerId, "line-width", leg.isFallback ? 10 : 18);
            map.setPaintProperty(glowLayerId, "line-opacity", leg.isFallback ? 0.15 : 0.45);
        }
    });

    // Remove any leg layers left over from a longer route (e.g. after Undo
    // or dragging a waypoint out of the route) - these used to stay on the
    // map forever since only add/update was handled above.
    let cleanupIdx = legs.length;
    while (map.getLayer(`route-leg-glow-${cleanupIdx}`) || map.getLayer(`route-leg-${cleanupIdx}`) || map.getSource(`route-source-${cleanupIdx}`)) {
        if (map.getLayer(`route-leg-glow-${cleanupIdx}`)) map.removeLayer(`route-leg-glow-${cleanupIdx}`);
        if (map.getLayer(`route-leg-${cleanupIdx}`)) map.removeLayer(`route-leg-${cleanupIdx}`);
        if (map.getSource(`route-source-${cleanupIdx}`)) map.removeSource(`route-source-${cleanupIdx}`);
        cleanupIdx++;
    }
}

function showSnapIndicator(clickedPoint) {
    if (roadRoute.length === 0) return;

    // Meters-based distance (haversine), consistent with getHitRadiusDegrees'
    // approach elsewhere - the old raw-degree comparison here didn't account
    // for latitude, making the ring more/less sensitive depending on the
    // click's east-west vs north-south offset.
    let nearestDistMeters = Infinity;
    let nearestPoint = null;
    roadRoute.forEach(p => {
        const dMeters = getDistanceInMiles(clickedPoint[1], clickedPoint[0], p[1], p[0]) * 1609.34;
        if (dMeters < nearestDistMeters) {
            nearestDistMeters = dMeters;
            nearestPoint = p;
        }
    });

    // Only show snap indicator if the snap moved the point meaningfully (~15m+)
    if (!nearestPoint || nearestDistMeters < 15) return;

    const el = document.createElement('div');
    el.className = 'snap-ring';
    const ringMarker = new mapboxgl.Marker({ element: el })
        .setLngLat(nearestPoint)
        .addTo(map);

    setTimeout(() => ringMarker.remove(), 900);
}

async function addPoint(point) {
    route.push(point);
    undoGroups.push(1);
    if (route.length >= 2) legModes.push(isFollowRoads);

    if (route.length >= 2) {
        await rebuildRoute();
        if (isFollowRoads) showSnapIndicator(point);
    }

    updateMarkers();
    updateHUD();
}

function undo() {
    if (route.length === 0) return;

    // Pop a whole action at once (a single click = 1 point, a freehand
    // stroke = however many points it captured) rather than one point per
    // Undo press - without this, undoing a dense freehand stroke took as
    // many clicks as the stroke had vertices.
    const groupSize = undoGroups.pop() || 1;
    route.splice(-groupSize, groupSize);
    legModes.splice(-groupSize, groupSize);
    rebuildRoute();
    updateMarkers();
    updateHUD();
}

function clear() {
    route.length = 0;
    legModes.length = 0;
    undoGroups.length = 0;
    legs.length = 0;
    roadRoute = [];
    totalDistance = 0;
    totalDuration = 0;

    // Dynamically remove every route-leg layer/source (no arbitrary bound -
    // the old fixed "i < 10" loop left orphaned layers on longer routes).
    let cleanupIdx = 0;
    while (map.getLayer(`route-leg-glow-${cleanupIdx}`) || map.getLayer(`route-leg-${cleanupIdx}`) || map.getSource(`route-source-${cleanupIdx}`)) {
        if (map.getLayer(`route-leg-glow-${cleanupIdx}`)) map.removeLayer(`route-leg-glow-${cleanupIdx}`);
        if (map.getLayer(`route-leg-${cleanupIdx}`)) map.removeLayer(`route-leg-${cleanupIdx}`);
        if (map.getSource(`route-source-${cleanupIdx}`)) map.removeSource(`route-source-${cleanupIdx}`);
        cleanupIdx++;
    }

    if (map.getSource("route")) {
        map.getSource("route").setData({
            type: "Feature",
            geometry: { type: "LineString", coordinates: [] }
        });
    }

    if (searchMarker) {
        searchMarker.remove();
        searchMarker = null;
    }

    updateMarkers();
    updateHUD();
}

function closeLoop() {
    if (route.length < 2) return;

    const firstPoint = route[0];
    const lastPoint = route[route.length - 1];

    if (firstPoint[0] !== lastPoint[0] || firstPoint[1] !== lastPoint[1]) {
        addPoint(firstPoint);
    }
}

async function getAddressFromCoords(lng, lat) {
    try {
        const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json` +
            `?types=address,poi&access_token=${mapboxgl.accessToken}`;
        const response = await fetch(url);
        const data = await response.json();
        if (data.features && data.features.length > 0) {
            const feature = data.features[0];
            // Short label only: street/POI name (+ house number if present)
            // plus city - place_name includes zip/state/country too, which
            // is unreadable clutter in a compact waypoint list.
            const streetName = feature.address ? `${feature.address} ${feature.text}` : feature.text;
            const city = (feature.context || []).find(c => c.id.startsWith('place'));
            return city ? `${streetName}, ${city.text}` : (streetName || `Point ${lat.toFixed(4)}, ${lng.toFixed(4)}`);
        }
    } catch (err) {
        console.error("Reverse geocoding failed:", err);
    }
    return `Point ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
}

function updateReorderList() {
    const list = document.getElementById("reorderList");
    list.innerHTML = "";

    // Shared across all items in this render (touch events only fire on the
    // item where the touch began, so this closure variable tracks which
    // item's drag is in progress).
    let touchReorderFromIdx = null;

    route.forEach((point, idx) => {
        const item = document.createElement("div");
        item.className = "waypoint-item";
        item.draggable = true;
        item.dataset.index = idx;

        // Show address instead of coordinates
        getAddressFromCoords(point[0], point[1]).then(address => {
            item.textContent = `${idx + 1}. ${address}`;
        });

        // Desktop: HTML5 drag-and-drop
        item.addEventListener("dragstart", (e) => {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", idx);
            item.classList.add("dragging");
        });

        item.addEventListener("dragend", () => {
            item.classList.remove("dragging");
        });

        item.addEventListener("dragover", (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
        });

        item.addEventListener("drop", async (e) => {
            e.preventDefault();
            const fromIdx = parseInt(e.dataTransfer.getData("text/plain"));
            const toIdx = idx;

            if (fromIdx !== toIdx) {
                const oldRoute = route.slice();
                const oldLegModes = legModes.slice();
                const [movedPoint] = route.splice(fromIdx, 1);
                route.splice(toIdx, 0, movedPoint);
                legModes.length = 0;
                legModes.push(...deriveLegModesForReorder(oldRoute, oldLegModes, route));
                undoGroups = route.map(() => 1);
                await rebuildRoute();
                updateMarkers();
                updateReorderList();
            }
        });

        // Mobile: HTML5 drag-and-drop has no touch equivalent on iOS
        // Safari/Chrome Android - dragstart never fires from a touch
        // gesture, so reordering was completely non-functional on phones.
        item.addEventListener("touchstart", () => {
            touchReorderFromIdx = parseInt(item.dataset.index);
            item.classList.add("dragging");
        }, { passive: true });

        item.addEventListener("touchmove", (e) => {
            if (touchReorderFromIdx === null) return;
            e.preventDefault();
            const touch = e.touches[0];
            const target = document.elementFromPoint(touch.clientX, touch.clientY);
            const targetItem = target && target.closest(".waypoint-item");
            if (targetItem && targetItem !== item) {
                const targetIdx = parseInt(targetItem.dataset.index);
                if (targetIdx < touchReorderFromIdx) {
                    list.insertBefore(item, targetItem);
                } else {
                    list.insertBefore(item, targetItem.nextSibling);
                }
            }
        }, { passive: false });

        item.addEventListener("touchend", async () => {
            if (touchReorderFromIdx === null) return;
            item.classList.remove("dragging");
            touchReorderFromIdx = null;

            // Read the final on-screen order back into the route array -
            // each item's dataset.index still reflects its ORIGINAL
            // position, only DOM order changed during the drag.
            const newOrder = Array.from(list.children).map(el => parseInt(el.dataset.index));
            const reordered = newOrder.map(i => route[i]);
            const oldRoute = route.slice();
            const oldLegModes = legModes.slice();
            route.length = 0;
            route.push(...reordered);
            legModes.length = 0;
            legModes.push(...deriveLegModesForReorder(oldRoute, oldLegModes, route));
            undoGroups = route.map(() => 1);

            await rebuildRoute();
            updateMarkers();
            updateReorderList();
        });

        list.appendChild(item);
    });
}

function toggleReorderPanel() {
    const panel = document.getElementById("reorderPanel");
    panel.classList.toggle("hidden");
    if (!panel.classList.contains("hidden")) {
        updateReorderList();
    }
}

// Flattens every leg's turn-by-turn steps (each already includes the
// street name via Mapbox's maneuver.instruction, e.g. "Turn right onto
// Main St") into one ordered list for the whole route, so a runner can
// see what to look for at each turn instead of just a distance total.
// Straight-line (fallback/freehand) legs have no steps - shown as a
// single "off-road" entry instead of turn instructions that don't apply.
function updateDirectionsList() {
    const listEl = document.getElementById("directionsList");
    listEl.innerHTML = "";

    if (legs.length === 0) {
        listEl.innerHTML = `<div class="direction-empty">Draw a route to see directions.</div>`;
        return;
    }

    let stepNum = 1;
    let hasAny = false;
    legs.forEach((leg) => {
        if (leg.isFallback || leg.steps.length === 0) {
            const distanceKm = leg.distance / 1000;
            const item = document.createElement("div");
            item.className = "direction-step";
            item.innerHTML = `<span class="step-num">${stepNum}</span>` +
                `<span>Off-road section (no street to follow)</span>` +
                `<span class="step-dist">${distanceKm.toFixed(2)} km</span>`;
            listEl.appendChild(item);
            stepNum++;
            hasAny = true;
            return;
        }
        leg.steps.forEach((step) => {
            // Mapbox includes a zero-distance "arrive" step at the very end
            // of each leg - skip it here since the next leg (or the route's
            // own end) already conveys that.
            if (step.distance === 0) return;
            const item = document.createElement("div");
            item.className = "direction-step";
            item.innerHTML = `<span class="step-num">${stepNum}</span>` +
                `<span>${escapeHtml(step.instruction)}</span>` +
                `<span class="step-dist">${(step.distance).toFixed(0)} m</span>`;
            listEl.appendChild(item);
            stepNum++;
            hasAny = true;
        });
    });

    if (!hasAny) {
        listEl.innerHTML = `<div class="direction-empty">No turn-by-turn steps for this route.</div>`;
    }
}

function toggleDirectionsPanel() {
    const panel = document.getElementById("directionsPanel");
    panel.classList.toggle("hidden");
    if (!panel.classList.contains("hidden")) {
        updateDirectionsList();
    }
}

// Escapes user- or API-derived text before it's dropped into innerHTML -
// street names and saved-route names are both effectively untrusted
// strings (an OSM name field or a runner's own typed input), so this
// avoids building HTML via string concatenation with either.
function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}

// Saved routes: no accounts/backend - just named routes kept in this
// browser's localStorage. Per-device only (won't sync across a phone and
// a laptop), but needs zero infrastructure. A route[] + legModes[] pair
// is everything rebuildRoute() needs to fully reconstruct a route, so
// that's all that's stored.
const SAVED_ROUTES_KEY = "routr_saved_routes";

function getSavedRoutes() {
    try {
        return JSON.parse(localStorage.getItem(SAVED_ROUTES_KEY)) || [];
    } catch (err) {
        return [];
    }
}

function setSavedRoutes(routes) {
    try {
        localStorage.setItem(SAVED_ROUTES_KEY, JSON.stringify(routes));
        return true;
    } catch (err) {
        alert("Couldn't save - your browser's local storage may be full or disabled.");
        return false;
    }
}

function saveCurrentRoute(name) {
    if (route.length < 2) return;
    const routes = getSavedRoutes();
    routes.push({
        id: Date.now().toString(36),
        name: (name || "").trim() || `Route ${routes.length + 1}`,
        savedAt: Date.now(),
        distanceKm: totalDistance / 1000,
        route: route.map(p => [p[0], p[1]]),
        legModes: legModes.slice()
    });
    return setSavedRoutes(routes);
}

async function loadSavedRoute(id) {
    const saved = getSavedRoutes().find(r => r.id === id);
    if (!saved) return;

    route.length = 0;
    route.push(...saved.route);
    legModes.length = 0;
    legModes.push(...saved.legModes);
    // Loading a saved route replaces the whole route as one atomic action,
    // same treatment as a suggested route - one Undo press removes it.
    undoGroups = [route.length];

    document.getElementById("myRoutesPanel").classList.add("hidden");
    await rebuildRoute();
    updateMarkers();
    updateHUD();
    fitMapToRoute();
}

function deleteSavedRoute(id) {
    setSavedRoutes(getSavedRoutes().filter(r => r.id !== id));
    renderMyRoutesList();
}

function renderMyRoutesList() {
    const listEl = document.getElementById("myRoutesList");
    const routes = getSavedRoutes();
    listEl.innerHTML = "";

    if (routes.length === 0) {
        listEl.innerHTML = `<div class="direction-empty">No saved routes yet - name one above and hit Save. Routes are stored in this browser, so they'll be here next time you open Routr on this device.</div>`;
        return;
    }

    routes.slice().reverse().forEach((r) => {
        const item = document.createElement("div");
        item.className = "saved-route-item";
        const date = new Date(r.savedAt).toLocaleDateString();
        item.innerHTML = `
            <div class="saved-route-info">
                <div class="saved-route-name">${escapeHtml(r.name)}</div>
                <div class="saved-route-meta">${r.distanceKm.toFixed(2)} km &middot; ${date}</div>
            </div>
            <div class="saved-route-actions">
                <button class="saved-route-load">Load</button>
                <button class="saved-route-delete">Delete</button>
            </div>
        `;
        item.querySelector(".saved-route-load").addEventListener("click", () => loadSavedRoute(r.id));
        item.querySelector(".saved-route-delete").addEventListener("click", () => {
            if (confirm(`Delete "${r.name}"?`)) deleteSavedRoute(r.id);
        });
        listEl.appendChild(item);
    });
}

// Loading screen: hidden only once BOTH conditions below are true, so the
// user never sees the map centered on the default (Times Square) point and
// then visibly jump once geolocation resolves, and never sees a style
// fallback swap (Standard failing -> dark-v11 -> the minimal style) mid-
// flight as a flash of broken map + red error banner. A hard cap still
// guarantees this can never hang forever on a stalled network/permission
// prompt - geolocation's own `timeout` already guarantees its callback
// fires either way, but the style side has no such built-in guarantee.
let geoSettled = false;
let styleSettleTimer = null;
const LOADING_HARD_CAP_MS = 8000;

function tryHideLoadingScreen() {
    if (!geoSettled || styleSettleTimer !== "settled") return;
    const el = document.getElementById("loadingScreen");
    if (el) el.classList.add("hidden");
}

// Debounced: every style "load"/"style.load" event (the initial load, and
// each fallback swap's own load) resets this, so the loading screen keeps
// waiting through the WHOLE fallback chain rather than revealing after
// just the first one. Settles 700ms after the last such event fires.
function scheduleStyleSettle() {
    if (styleSettleTimer && styleSettleTimer !== "settled") clearTimeout(styleSettleTimer);
    styleSettleTimer = setTimeout(() => {
        styleSettleTimer = "settled";
        tryHideLoadingScreen();
    }, 700);
}

setTimeout(() => {
    const el = document.getElementById("loadingScreen");
    if (el) el.classList.add("hidden");
}, LOADING_HARD_CAP_MS);

// ---- Finding the user's location on load --------------------------------
// The first fix on a phone often takes longer than the 3 seconds this used
// to allow, and when it timed out the app silently stayed on the default
// spot forever - no retry, no hint why. Now: a more patient first attempt
// (accepting a recent cached position, which is instant), a longer
// background retry that moves the map once a fix arrives if the user hasn't
// started using it, plain-English feedback when location is blocked, and a
// locate (◎) button for doing it again by hand.
function locateUser(options) {
    return new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
            reject({ code: 0 });
            return;
        }
        navigator.geolocation.getCurrentPosition(
            (p) => resolve({ lng: p.coords.longitude, lat: p.coords.latitude }),
            (err) => reject(err),
            options
        );
    });
}

function describeGeoError(err) {
    const code = err && err.code;
    if (code === 1) return "Location is turned off for this site. Allow it in your phone's settings (see ? Help) to start where you are.";
    if (code === 2) return "Couldn't work out where you are. Try again in a moment, or tap ◎.";
    if (code === 3) return "Still looking for your location - tap ◎ to try again.";
    return "Location isn't available in this browser.";
}

let toastTimer = null;
function showToast(message, ms = 6000) {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = message;
    el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), ms);
}

// Did the user pan/zoom the map themselves? (movestart has originalEvent only
// for user-driven moves, not our own jumpTo/flyTo calls.)
let userMovedMap = false;
map.on("movestart", (e) => { if (e.originalEvent) userMovedMap = true; });

(async () => {
    try {
        const here = await locateUser({ timeout: 5000, maximumAge: 600000, enableHighAccuracy: false });
        map.jumpTo({ center: [here.lng, here.lat], zoom: 14 });
        geoSettled = true;
        tryHideLoadingScreen();
        return;
    } catch (err) {
        geoSettled = true;
        tryHideLoadingScreen();
        showToast(describeGeoError(err));
        if (err && (err.code === 1 || err.code === 0)) return; // blocked/unsupported: retrying can't help
    }

    // First attempt timed out or failed to get a fix: keep trying quietly.
    try {
        const here = await locateUser({ timeout: 25000, maximumAge: 600000, enableHighAccuracy: false });
        if (!userMovedMap && route.length === 0) {
            map.flyTo({ center: [here.lng, here.lat], zoom: 14, duration: 1200 });
            showToast("Moved to your location.", 3000);
        } else {
            showToast("Found your location - tap ◎ to go there.", 5000);
        }
    } catch (err) {
        showToast(describeGeoError(err));
    }
})();

// ◎ button: centres the map on the user (and drops a blue dot), any time.
const geolocateControl = new mapboxgl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true, timeout: 15000 },
    trackUserLocation: false,
    showUserLocation: true,
    fitBoundsOptions: { maxZoom: 15 }
});
map.addControl(geolocateControl, "bottom-right");
geolocateControl.on("error", (err) => showToast(describeGeoError(err)));

map.on("load", scheduleStyleSettle);
map.on("style.load", scheduleStyleSettle);

map.on("load", function () {
    // Mapbox Standard style auto-switches to a 3D globe with atmospheric
    // fog below ~zoom 5, and the "night" light preset applies a scene-wide
    // dark/blue atmospheric tint even in mercator view - both desaturate
    // every layer on the map, including our neon route lines, the further
    // out you zoom. Forcing flat mercator projection and disabling fog
    // keeps route colors at full, undimmed brightness regardless of zoom.
    map.setProjection('mercator');
    map.setFog(null);

    // Mapbox's Standard style doesn't extrude 3D buildings until zoom 15 by
    // default - with the app's starting zoom of 13, buildings stayed flat
    // 2D fills until zooming in a lot further. Lowering each building
    // layer's own minzoom (confirmed via the actual style JSON: 2d-building,
    // 3d-building, procedural-buildings, building-models all gate at
    // 15/15/15/14) makes them extrude starting much further out. Guarded by
    // getLayer() since the fallback styles (dark-v11, the minimal custom
    // style) have no such layers at all - this only does anything when
    // Standard actually loaded.
    ["2d-building", "3d-building", "procedural-buildings", "building-models"].forEach(id => {
        if (map.getLayer(id)) map.setLayerZoomRange(id, 12, 24);
    });

    // Main route source
    map.addSource("route", {
        type: "geojson",
        data: {
            type: "Feature",
            geometry: { type: "LineString", coordinates: [] }
        }
    });

    map.addLayer({
        id: "route-line",
        type: "line",
        source: "route",
        paint: {
            "line-width": 8,
            "line-color": "#FFFFFF",
            "line-opacity": 0
        }
    });
});

// Helper: find closest point on line segment to a given point
function closestPointOnSegment(p, a, b) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return [a[0] + t * dx, a[1] + t * dy];
}

// Helper: distance between two points (in degrees, approximate)
function distance(p1, p2) {
    const dx = p2[0] - p1[0];
    const dy = p2[1] - p1[1];
    return Math.sqrt(dx * dx + dy * dy);
}

// Hit-test radius in degrees, calibrated to a fixed screen-pixel radius
// regardless of zoom level (was hardcoded to 0.001 ≈ 111m, way too large -
// it was swallowing normal "add point" taps near any existing route line).
function getHitRadiusDegrees(pixelRadius = 18) {
    const zoom = map.getZoom();
    const lat = map.getCenter().lat;
    const metersPerPixel = 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom);
    const meters = pixelRadius * metersPerPixel;
    return meters / 111320;
}

// Sculpt hit-testing finds the nearest segment in `roadRoute` - the DENSE
// rendered polyline, where a single road-snapped leg can contribute dozens
// of coordinate points. That index was being used directly as a `route`
// (the SPARSE waypoint array) insertion index, which only happened to be
// correct when every leg was a straight 2-point line (Follow Roads off).
// With road-snapping on - the default - a click/tap far into a road-snapped
// leg's polyline could splice the new waypoint into completely the wrong
// position in `route`, nowhere near where the user actually dragged. This
// walks `legs[]` to find which leg a roadRoute index actually belongs to,
// using the same "leg 0 keeps its first point, later legs drop their
// duplicate first point" accounting rebuildRoute() uses when concatenating
// legs into roadRoute.
// Reordering waypoints changes which points are adjacent, so the old
// per-leg modes don't line up index-for-index with the new legs anymore.
// Rather than blindly re-deriving every leg from the current global
// Follow Roads toggle (which would silently re-snap or re-straighten
// legs that weren't touched by the reorder - the exact bug legModes was
// introduced to fix elsewhere), look up each new leg's endpoints against
// the OLD adjacency: if that exact pair of points was adjacent before
// (in either direction), keep whatever mode it had; only a genuinely new
// adjacency falls back to the current global toggle.
function deriveLegModesForReorder(oldRoute, oldLegModes, newRoute) {
    const pairMode = new Map();
    for (let i = 0; i < oldRoute.length - 1; i++) {
        const a = oldRoute[i].join(',');
        const b = oldRoute[i + 1].join(',');
        const mode = oldLegModes[i] !== undefined ? oldLegModes[i] : isFollowRoads;
        pairMode.set(`${a}|${b}`, mode);
        pairMode.set(`${b}|${a}`, mode);
    }
    const result = [];
    for (let i = 0; i < newRoute.length - 1; i++) {
        const key = `${newRoute[i].join(',')}|${newRoute[i + 1].join(',')}`;
        result.push(pairMode.has(key) ? pairMode.get(key) : isFollowRoads);
    }
    return result;
}

function roadRouteIndexToLegIndex(roadRouteIdx) {
    let cursor = 0;
    for (let i = 0; i < legs.length; i++) {
        const legLen = i === 0 ? legs[i].coordinates.length : legs[i].coordinates.length - 1;
        if (roadRouteIdx < cursor + legLen) return i;
        cursor += legLen;
    }
    return Math.max(0, legs.length - 1);
}

// Single unified click handler - add points
map.on("click", async function (event) {
    if (isFreehandMode) return; // freehand only commits via drag, not tap
    // On a touchscreen a quick tap (or the tap that ends a scroll/zoom) must
    // never drop a point - that's how scrolling the map kept adding stray
    // points. Touch users add points with a press-and-hold instead (see the
    // hold handling below). lastTouchTime is stamped in a capture-phase
    // listener, so it's already fresh by the time Mapbox fires this click.
    if (Date.now() - lastTouchTime < TOUCH_CLICK_GUARD_MS) return;
    const point = [event.lngLat.lng, event.lngLat.lat];
    await addPoint(point);
});

// Drag handling for sculpting (and, when isFreehandMode is on, for tracing
// a freehand path instead)
let isMouseDown = false;
let dragStartPoint = null;

document.getElementById("map").addEventListener("mousedown", (e) => {
    // Marker elements are DOM children of #map's container, so a mousedown
    // on a marker bubbles up into this listener too - Mapbox's own marker
    // drag logic AND this sculpt-drag logic would both start simultaneously,
    // each fighting over the route array and corrupting it. Let marker drags
    // (see updateMarkers()) handle themselves exclusively.
    if (e.target.closest('.mapboxgl-marker')) return;

    // Browsers fire emulated mouse events after a touch; those must not
    // start a mouse-style line drag (touch has its own press-and-hold path).
    if (Date.now() - lastTouchTime < TOUCH_CLICK_GUARD_MS) return;

    isMouseDown = true;
    dragStartPoint = null;

    const point = map.unproject([e.clientX - map.getContainer().getBoundingClientRect().left, e.clientY - map.getContainer().getBoundingClientRect().top]);
    const mapPoint = [point.lng, point.lat];

    if (isFreehandMode) {
        isCapturingFreehand = true;
        freehandCapturePath = [mapPoint];
        return;
    }

    let nearestDist = getHitRadiusDegrees(18);
    let nearestSegment = -1;

    for (let i = 0; i < roadRoute.length - 1; i++) {
        const closest = closestPointOnSegment(mapPoint, roadRoute[i], roadRoute[i + 1]);
        const dist = distance(mapPoint, closest);
        if (dist < nearestDist) {
            nearestDist = dist;
            nearestSegment = i;
        }
    }

    if (nearestSegment !== -1) {
        dragStartPoint = { segment: nearestSegment, point: mapPoint };
    }
});

// mousemove/mouseup are bound to document, not #map. The HUD and reorder
// panel are sibling elements that visually overlap #map - if a drag started
// near them and the mouse moved over/released on top of the HUD (or outside
// the browser window entirely), a #map-scoped mouseup would never fire,
// leaving isMouseDown/dragStartPoint stuck true forever and corrupting the
// route on every subsequent hover. Binding to document (plus a window
// "blur" fallback for alt-tab/losing focus mid-drag) guarantees the drag
// always ends cleanly.
document.addEventListener("mousemove", async (e) => {
    if (!isMouseDown) return;

    const point = map.unproject([e.clientX - map.getContainer().getBoundingClientRect().left, e.clientY - map.getContainer().getBoundingClientRect().top]);
    const mapPoint = [point.lng, point.lat];

    if (isFreehandMode) {
        if (isCapturingFreehand) addFreehandPoint(mapPoint);
        return;
    }

    if (!dragStartPoint) return;

    if (draggedPointIndex === -1) {
        const legIdx = roadRouteIndexToLegIndex(dragStartPoint.segment);
        draggedPointIndex = legIdx + 1;
        route.splice(draggedPointIndex, 0, dragStartPoint.point);
        const originalMode = legModes[legIdx] !== undefined ? legModes[legIdx] : isFollowRoads;
        legModes.splice(legIdx, 1, originalMode, originalMode);
        undoGroups.push(1);
        isDraggingLine = true;
    }

    route[draggedPointIndex] = mapPoint;
    await rebuildRoute();
    updateMarkers();
});

function endMouseDrag() {
    isMouseDown = false;
    if (isFreehandMode) {
        if (isCapturingFreehand) {
            isCapturingFreehand = false;
            commitFreehandPath();
        }
        return;
    }
    if (isDraggingLine) {
        isDraggingLine = false;
        draggedPointIndex = -1;
    }
    dragStartPoint = null;
}

document.addEventListener("mouseup", endMouseDrag);
window.addEventListener("blur", endMouseDrag);

// Touch support for mobile drawing.
//
// Touch interaction model (changed after real phone testing): a plain tap,
// a swipe, a pinch - anything that isn't a deliberate press-and-hold -
// only ever moves/zooms the map. Two things used to go wrong: taps (and
// the tap that ends a scroll) dropped points, and any swipe that started
// within 40px of the route line was grabbed as a line-drag that inserted a
// point and froze panning, so scrolling around an existing route kept
// adding points. Now:
//   - hold a finger still ~0.4s on empty map  -> drops a point
//   - hold a finger still ~0.4s on the line   -> "grabs" it; drag to reshape
//   - moving or adding a second finger before the hold completes cancels it
let isTouchDown = false;
let touchStartPoint = null;       // set only once a hold has grabbed the line
let touchStartClientPos = null;
let lastTouchTime = 0;
let holdTimer = null;
let holdStart = null;
let holdRingEl = null;
const TOUCH_CLICK_GUARD_MS = 1000;
const HOLD_MS = 400;
const HOLD_MOVE_TOLERANCE_PX = 10;   // finger drift allowed while holding
const LINE_GRAB_RADIUS_PX = 28;      // how close a hold must be to grab the line
const GRABBED_DRAG_THRESHOLD_PX = 3; // movement after a grab before reshaping

// Stamped in the CAPTURE phase (fires before Mapbox's own handlers) so the
// click/mouse guards above can tell "this came from a touch" reliably.
["touchstart", "touchend"].forEach(type => {
    document.getElementById("map").addEventListener(type, () => { lastTouchTime = Date.now(); }, true);
});

function showHoldRing(x, y) {
    removeHoldRing();
    holdRingEl = document.createElement("div");
    holdRingEl.className = "hold-ring";
    holdRingEl.style.left = `${x}px`;
    holdRingEl.style.top = `${y}px`;
    document.body.appendChild(holdRingEl);
}

function removeHoldRing() {
    if (holdRingEl) {
        holdRingEl.remove();
        holdRingEl = null;
    }
}

function cancelHold() {
    if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = null;
        removeHoldRing();
    }
    holdStart = null;
}

// A hold finished while the finger was still down and still.
async function onHoldFired() {
    holdTimer = null;
    if (!holdStart || !isTouchDown) return;
    const { mapPoint, nearestSegment, x, y } = holdStart;
    holdStart = null;

    if (navigator.vibrate) navigator.vibrate(15);
    if (holdRingEl) {
        holdRingEl.classList.add("fired");
        const ring = holdRingEl;
        holdRingEl = null;
        setTimeout(() => ring.remove(), 400);
    }

    if (nearestSegment !== -1) {
        // Held on the line: grab it. The map stops panning so the finger
        // reshapes the route instead; the point itself is inserted on the
        // first real movement (see touchmove).
        touchStartPoint = { segment: nearestSegment, point: mapPoint };
        touchStartClientPos = { x, y };
        map.dragPan.disable();
    } else {
        await addPoint(mapPoint);
    }
}

document.getElementById("map").addEventListener("touchstart", (e) => {
    // Same conflict as the mousedown guard above - a marker's own touch
    // drag must not also trigger our sculpt-drag capture.
    if (e.target.closest('.mapboxgl-marker')) return;

    // A second finger means pinch/rotate: never a hold, never a grab.
    if (e.touches.length > 1) {
        cancelHold();
        if (touchStartPoint && draggedPointIndex === -1) {
            touchStartPoint = null;
            touchStartClientPos = null;
            if (!isFreehandMode) map.dragPan.enable();
        }
        return;
    }

    isTouchDown = true;
    cancelHold();

    const touch = e.touches[0];
    const bounds = map.getContainer().getBoundingClientRect();
    const point = map.unproject([touch.clientX - bounds.left, touch.clientY - bounds.top]);
    const mapPoint = [point.lng, point.lat];

    if (isFreehandMode) {
        e.preventDefault();
        isCapturingFreehand = true;
        freehandCapturePath = [mapPoint];
        return;
    }

    let nearestDist = getHitRadiusDegrees(LINE_GRAB_RADIUS_PX);
    let nearestSegment = -1;

    for (let i = 0; i < roadRoute.length - 1; i++) {
        const closest = closestPointOnSegment(mapPoint, roadRoute[i], roadRoute[i + 1]);
        const dist = distance(mapPoint, closest);
        if (dist < nearestDist) {
            nearestDist = dist;
            nearestSegment = i;
        }
    }

    // Nothing here preventDefaults, so a normal swipe still pans the map and
    // a pinch still zooms - the hold only fires if the finger stays put.
    holdStart = { x: touch.clientX, y: touch.clientY, mapPoint, nearestSegment };
    showHoldRing(touch.clientX, touch.clientY);
    holdTimer = setTimeout(onHoldFired, HOLD_MS);
}, false);

document.getElementById("map").addEventListener("touchmove", async (e) => {
    if (!isTouchDown) return;

    const touch = e.touches[0];
    const bounds = map.getContainer().getBoundingClientRect();
    const point = map.unproject([touch.clientX - bounds.left, touch.clientY - bounds.top]);
    const mapPoint = [point.lng, point.lat];

    if (isFreehandMode) {
        if (isCapturingFreehand) {
            e.preventDefault();
            addFreehandPoint(mapPoint);
        }
        return;
    }

    // Still waiting on a hold: any real movement (or a second finger) means
    // this is a scroll/pan/pinch, not a hold - cancel it and let the map move.
    if (holdTimer && holdStart) {
        const moved = Math.hypot(touch.clientX - holdStart.x, touch.clientY - holdStart.y);
        if (moved > HOLD_MOVE_TOLERANCE_PX || e.touches.length > 1) cancelHold();
        return;
    }

    if (touchStartPoint) {
        if (draggedPointIndex === -1) {
            const dx = touch.clientX - touchStartClientPos.x;
            const dy = touch.clientY - touchStartClientPos.y;
            if (Math.hypot(dx, dy) < GRABBED_DRAG_THRESHOLD_PX) return;

            e.preventDefault();
            const legIdx = roadRouteIndexToLegIndex(touchStartPoint.segment);
            draggedPointIndex = legIdx + 1;
            route.splice(draggedPointIndex, 0, touchStartPoint.point);
            const originalMode = legModes[legIdx] !== undefined ? legModes[legIdx] : isFollowRoads;
            legModes.splice(legIdx, 1, originalMode, originalMode);
            undoGroups.push(1);
            isDraggingLine = true;
        } else {
            e.preventDefault();
        }

        route[draggedPointIndex] = mapPoint;
        await rebuildRoute();
        updateMarkers();
    }
}, false);

function endTouchDrag(e) {
    // touchend fires once per lifted finger; only finish the gesture when the
    // last one comes up (lifting one finger of a pinch is not the end).
    if (e && e.touches && e.touches.length > 0) return;

    isTouchDown = false;
    cancelHold();
    if (isFreehandMode) {
        if (isCapturingFreehand) {
            isCapturingFreehand = false;
            commitFreehandPath();
        }
        return;
    }
    if (isDraggingLine) {
        isDraggingLine = false;
        draggedPointIndex = -1;
    }
    touchStartPoint = null;
    touchStartClientPos = null;
    // A grabbed line turns map panning off for the duration of the drag.
    map.dragPan.enable();
}

// Stop the browser's long-press context menu / text callout from popping up
// over a press-and-hold on the map.
document.getElementById("map").addEventListener("contextmenu", (e) => e.preventDefault());

// Belt and braces with the CSS user-select rules: if a long press still
// manages to start a text selection (older iOS builds), cancel it - except
// inside form fields, where selecting text is normal.
document.addEventListener("selectstart", (e) => {
    const el = e.target && e.target.nodeType === 3 ? e.target.parentElement : e.target;
    if (el && el.closest && el.closest("input, textarea")) return;
    e.preventDefault();
});

document.getElementById("map").addEventListener("touchend", endTouchDrag, false);

// touchcancel fires INSTEAD of touchend when the OS interrupts a gesture
// mid-drag (incoming call, notification-shade swipe, back-gesture, app
// switch). Without handling it, isTouchDown/touchStartPoint/draggedPointIndex
// stay stuck exactly like the mouse-drag bug fixed via window "blur" - the
// touch equivalent of that same failure mode.
document.addEventListener("touchcancel", endTouchDrag, false);

// Buttons
document.getElementById("toggleUnitsBtn").addEventListener("click", function () {
    const pace = getPaceInput();
    // Convert the pace VALUE so it still represents the same real-world
    // speed in the new unit, rather than just relabeling a stale number
    // (e.g. "5 min/km" becoming "5 min/mi" would silently be a much
    // faster pace, not the same pace).
    const newPace = useMiles ? pace / KM_PER_MILE : pace * KM_PER_MILE;
    useMiles = !useMiles;
    document.getElementById("paceInput").value = newPace.toFixed(1);

    const unitLabel = useMiles ? "mi" : "km";
    this.textContent = `Units: ${unitLabel}`;
    document.getElementById("paceLabel").textContent = `Pace (min/${unitLabel})`;

    updateHUD();
});

document.getElementById("toggleFollowRoads").addEventListener("click", function () {
    isFollowRoads = !isFollowRoads;
    this.textContent = `Follow Roads: ${isFollowRoads ? 'ON' : 'OFF'}`;
    this.classList.toggle("active");
    // If manually toggled while Freehand is active, keep the "restore on
    // Freehand-off" value in sync - otherwise turning Freehand off later
    // would silently discard this manual change and revert to whatever
    // Follow Roads was BEFORE Freehand was turned on.
    if (isFreehandMode) followRoadsBeforeFreehand = isFollowRoads;
    // Deliberately does NOT rebuild the existing route: mode is now a
    // per-leg property recorded at creation time (see legModes above), so
    // toggling this only affects legs added AFTER this point - it no
    // longer silently re-snaps/re-straightens everything already drawn.
});

document.getElementById("toggleFreehandBtn").addEventListener("click", function () {
    isFreehandMode = !isFreehandMode;
    this.textContent = `Freehand Draw: ${isFreehandMode ? 'ON' : 'OFF'}`;
    this.classList.toggle("active");

    if (isFreehandMode) {
        map.dragPan.disable();
        // The button turning green was the only feedback freehand mode
        // gave before actually dragging - easy to miss, especially on a
        // small screen. A crosshair cursor the instant you hover the map
        // confirms the mode switched without needing to drag first.
        map.getCanvas().style.cursor = "crosshair";
        followRoadsBeforeFreehand = isFollowRoads;
        isFollowRoads = false; // freehand strokes are always straight legs
    } else {
        map.dragPan.enable();
        map.getCanvas().style.cursor = "";
        isFollowRoads = followRoadsBeforeFreehand;
        isCapturingFreehand = false;
        clearFreehandPreview();
    }
});

document.getElementById("moreMenuBtn").addEventListener("click", function () {
    document.getElementById("moreMenu").classList.toggle("hidden");
});

// On phones #moreMenu is a bottom sheet (style.css): close it with its ×
// button, or by tapping the dimmed area above it (the sheet's ::before scrim,
// whose clicks land on #moreMenu itself, above the sheet's top edge).
document.getElementById("closeMoreSheetBtn").addEventListener("click", () => {
    document.getElementById("moreMenu").classList.add("hidden");
});
document.getElementById("moreMenu").addEventListener("click", (e) => {
    if (!window.matchMedia("(max-width: 768px)").matches) return;
    if (e.clientY < e.currentTarget.getBoundingClientRect().top) {
        e.currentTarget.classList.add("hidden");
    }
});

// "How to use" tab. The ? button pulses until it has been opened once
// (remembered per-device; storage can be blocked, so every access is guarded).
const HELP_SEEN_KEY = "routr_help_seen";
const helpBtnEl = document.getElementById("helpBtn");
try {
    if (!localStorage.getItem(HELP_SEEN_KEY)) helpBtnEl.classList.add("pulse");
} catch (err) {
    helpBtnEl.classList.add("pulse");
}

helpBtnEl.addEventListener("click", () => {
    document.getElementById("moreMenu").classList.add("hidden");
    document.getElementById("helpPanel").classList.remove("hidden");
    helpBtnEl.classList.remove("pulse");
    try { localStorage.setItem(HELP_SEEN_KEY, "1"); } catch (err) { /* storage blocked - fine */ }
});

document.getElementById("closeHelpBtn").addEventListener("click", () => {
    document.getElementById("helpPanel").classList.add("hidden");
});

// Touch screens add points by press-and-hold, not click - say so up front.
if (window.matchMedia("(pointer: coarse)").matches) {
    const helpText = document.querySelector("#helpOverlay .help-text");
    if (helpText) helpText.textContent = "👇 Press and hold on the map to drop a point";
}

// Explicit, opt-in action - unlike the on-load map centering (which only
// pans the camera), this actually adds the user's current GPS position as
// a real route waypoint, exactly like clicking that spot on the map. A
// runner often wants to plan a route starting somewhere else entirely
// (scouting a route for later, planning from a friend's place, etc.), so
// this is never automatic. Being a normal route point, Clear removes it
// like any other waypoint - no special-casing needed.
document.getElementById("addCurrentLocationBtn").addEventListener("click", function () {
    if (!navigator.geolocation) {
        alert("Geolocation isn't available in this browser.");
        return;
    }
    const btn = this;
    btn.disabled = true;
    btn.textContent = "📍 Locating...";
    navigator.geolocation.getCurrentPosition(
        async (position) => {
            await addPoint([position.coords.longitude, position.coords.latitude]);
            btn.disabled = false;
            btn.textContent = "📍 Add Current Location";
        },
        () => {
            alert("Couldn't get your location - check location permissions for this site.");
            btn.disabled = false;
            btn.textContent = "📍 Add Current Location";
        },
        { timeout: 10000 }
    );
});

document.getElementById("reorderBtn").addEventListener("click", () => {
    document.getElementById("moreMenu").classList.add("hidden");
    toggleReorderPanel();
});

document.getElementById("closeReorderBtn").addEventListener("click", toggleReorderPanel);

document.getElementById("directionsBtn").addEventListener("click", () => {
    document.getElementById("moreMenu").classList.add("hidden");
    toggleDirectionsPanel();
});

document.getElementById("closeDirectionsBtn").addEventListener("click", toggleDirectionsPanel);

document.getElementById("suggestRouteBtn").addEventListener("click", () => {
    document.getElementById("moreMenu").classList.add("hidden");
    const panel = document.getElementById("suggestPanel");
    panel.classList.remove("hidden", "results");
    // Runners usually want to start from where they are, so default to the
    // current location - unless they've already placed a route point, which
    // is a deliberate choice of start.
    setSuggestStartMode(route.length > 0 ? "selected" : "me");
});

function closeSuggestPanel() {
    const panel = document.getElementById("suggestPanel");
    panel.classList.add("hidden");
    panel.classList.remove("results");
    clearSuggestPreview();
    document.getElementById("suggestResults").innerHTML = "";
    document.getElementById("suggestSummary").textContent = "";
    updateSuggestStartInfo();
}

document.getElementById("suggestCloseBtn").addEventListener("click", closeSuggestPanel);

// Back from the slim results bar to the criteria form (phones). The previewed
// route stays on the map until a new search replaces it.
document.getElementById("suggestEditBtn").addEventListener("click", () => {
    document.getElementById("suggestPanel").classList.remove("results");
    updateSuggestStartInfo();
});

document.getElementById("suggestStartMe").addEventListener("click", () => setSuggestStartMode("me"));
document.getElementById("suggestStartPin").addEventListener("click", () => setSuggestStartMode("selected"));

document.getElementById("suggestGoBtn").addEventListener("click", async function () {
    const targetKm = parseFloat(document.getElementById("suggestDistance").value) || 5;
    const shapeEl = document.getElementById("suggestShape");
    const shape = shapeEl.value;
    const resultsEl = document.getElementById("suggestResults");
    const panel = document.getElementById("suggestPanel");
    const btn = this;

    clearSuggestPreview();
    btn.disabled = true;
    resultsEl.innerHTML = `<div class="direction-empty">Finding routes...</div>`;

    const start = await resolveSuggestStart();
    const options = await suggestRoutes(targetKm, shape, start);
    btn.disabled = false;

    if (options.length === 0) {
        resultsEl.innerHTML = `<div class="direction-empty">No routes found nearby - try a different distance.</div>`;
        return;
    }

    resultsEl.innerHTML = "";
    options.forEach((opt) => {
        const item = document.createElement("div");
        item.className = "suggest-option";
        const turnsText = `${opt.turns} turn${opt.turns === 1 ? "" : "s"}`;
        item.innerHTML =
            `<span class="opt-main"><span class="opt-label">${SUGGEST_SHAPE_LABELS[opt.shape] || "Route"}</span>` +
            `<span class="opt-turns">${turnsText}</span></span>` +
            `<span class="opt-km">${opt.distanceKm.toFixed(2)} km</span>`;
        item.addEventListener("click", () => {
            document.querySelectorAll(".suggest-option").forEach(el => el.classList.remove("selected"));
            item.classList.add("selected");
            showSuggestPreview(opt);
        });
        resultsEl.appendChild(item);
    });

    // Switch to the results state BEFORE framing the preview, so the map is
    // fitted around the (now much smaller) panel rather than the full form.
    const shapeNames = { simplest: "fewest turns", triangle: "triangle loop", square: "square loop", outback: "there and back" };
    document.getElementById("suggestSummary").textContent =
        `${targetKm} km from ${suggestStartMode === "me" ? "your location" : "your selected point"} · ${shapeNames[shape] || shape}`;
    panel.classList.add("results");
    updateSuggestStartInfo();

    resultsEl.firstChild.classList.add("selected");
    showSuggestPreview(options[0]);
});

document.getElementById("useSuggestedRouteBtn").addEventListener("click", useSuggestedRoute);

document.getElementById("elevationBtn").addEventListener("click", () => {
    document.getElementById("moreMenu").classList.add("hidden");
    document.getElementById("elevationPanel").classList.remove("hidden");
    updateElevationPanel();
});

document.getElementById("closeElevationBtn").addEventListener("click", () => {
    document.getElementById("elevationPanel").classList.add("hidden");
});

document.getElementById("exportGpxBtn").addEventListener("click", () => {
    document.getElementById("moreMenu").classList.add("hidden");
    exportGPX();
});

document.getElementById("myRoutesBtn").addEventListener("click", () => {
    document.getElementById("moreMenu").classList.add("hidden");
    document.getElementById("myRoutesPanel").classList.remove("hidden");
    renderMyRoutesList();
});

document.getElementById("myRoutesCloseBtn").addEventListener("click", () => {
    document.getElementById("myRoutesPanel").classList.add("hidden");
});

document.getElementById("saveRouteConfirmBtn").addEventListener("click", () => {
    if (route.length < 2) {
        alert("Draw a route before saving.");
        return;
    }
    const nameInput = document.getElementById("saveRouteName");
    if (saveCurrentRoute(nameInput.value)) {
        nameInput.value = "";
        renderMyRoutesList();
    }
});

document.getElementById("undoBtn").addEventListener("click", undo);

document.getElementById("clearBtn").addEventListener("click", clear);

document.getElementById("closeLoopBtn").addEventListener("click", closeLoop);

// "input" fires on every keystroke (live typing), unlike "change" which
// only fired on blur/Enter - typing a new pace now updates Running time as
// you type, not just after you click away from the field.
document.getElementById("paceInput").addEventListener("input", debounce(updateHUD, 100));

// Pace +/- buttons. Tap to nudge by 0.1 min (6 seconds); hold to keep going.
// "-" is a faster pace (fewer minutes per km), "+" a slower one.
(function setUpPaceStepper() {
    const input = document.getElementById("paceInput");
    const STEP = 0.1;
    const nudge = (direction) => {
        const min = parseFloat(input.min) || 1, max = parseFloat(input.max) || 20;
        const next = Math.min(max, Math.max(min, getPaceInput() + direction * STEP));
        input.value = next.toFixed(1);
        updateHUD();
    };
    [["paceDownBtn", -1], ["paceUpBtn", 1]].forEach(([id, direction]) => {
        const btn = document.getElementById(id);
        let delay = null, repeat = null;
        const stop = () => { clearTimeout(delay); clearInterval(repeat); delay = repeat = null; };
        btn.addEventListener("pointerdown", (e) => {
            e.preventDefault();               // keep focus/keyboard out of it
            nudge(direction);
            delay = setTimeout(() => { repeat = setInterval(() => nudge(direction), 90); }, 400);
        });
        ["pointerup", "pointerleave", "pointercancel"].forEach(t => btn.addEventListener(t, stop));
        // Keyboard users: Enter/Space fire click.
        btn.addEventListener("click", (e) => { if (e.detail === 0) nudge(direction); });
    });
})();

async function triggerSearch(input) {
    if (!input.value.trim()) return;
    const coords = await searchPlace(input.value);
    if (coords) input.value = "";
}

document.getElementById("searchInput").addEventListener("keypress", (e) => {
    if (e.key === "Enter") triggerSearch(e.target);
});

// type="search" fires a native "search" event when the mobile keyboard's
// Go/Search action button is tapped, or the field's X is used to clear it.
// keypress "Enter" is unreliable across mobile keyboards/IMEs (varies by
// keyboard app, voice input, autocomplete-suggestion taps) - "search" is
// the platform-native signal and works as a fallback either way covers it.
document.getElementById("searchInput").addEventListener("search", (e) => {
    triggerSearch(e.target);
});

document.getElementById("hudToggle").addEventListener("click", function () {
    document.getElementById("hud").classList.toggle("expanded");
});

// Set initial active state for buttons
document.getElementById("toggleFollowRoads").classList.add("active");

// Hide help overlay on first interaction anywhere (not just a map click -
// the CSS animation's "forwards" fill-mode already guarantees it fades out
// and stays gone after 3s regardless, this just makes it disappear sooner).
document.addEventListener("pointerdown", () => {
    const overlay = document.getElementById("helpOverlay");
    if (overlay) overlay.remove();
}, { once: true });

updateHUD();
