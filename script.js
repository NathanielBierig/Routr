mapboxgl.accessToken = MAPBOX_TOKEN;

const map = new mapboxgl.Map({
    container: "map",
    style: "mapbox://styles/mapbox/standard",
    config: {
        basemap: {
            lightPreset: "night"
        }
    },
    center: [-74.01, 40.89],
    zoom: 13
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
            paint: { "line-width": 6, "line-color": "#00FFFF", "line-opacity": 0.9 }
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
                paint: {
                    "line-width": leg.isFallback ? 10 : 18,
                    "line-color": color,
                    "line-opacity": leg.isFallback ? 0.15 : 0.45,
                    "line-blur": 3
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
                paint: {
                    "line-width": 5,
                    "line-color": color,
                    "line-opacity": 1,
                    "line-dasharray": leg.isFallback ? [2, 2] : [1, 0]
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
        listEl.innerHTML = `<div class="direction-empty">No saved routes yet.</div>`;
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

// Center on the user's actual location instead of the hardcoded fallback
// coordinates, if they grant permission. Falls back silently to whatever
// `center` the map was constructed with (denied/unsupported/timed out) -
// never blocks map load waiting on this.
if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
        (position) => {
            map.jumpTo({
                center: [position.coords.longitude, position.coords.latitude],
                zoom: 14
            });
        },
        () => { /* denied or unavailable - keep the fallback center */ },
        { timeout: 5000 }
    );
}

map.on("load", function () {
    // Mapbox Standard style auto-switches to a 3D globe with atmospheric
    // fog below ~zoom 5, and the "night" light preset applies a scene-wide
    // dark/blue atmospheric tint even in mercator view - both desaturate
    // every layer on the map, including our neon route lines, the further
    // out you zoom. Forcing flat mercator projection and disabling fog
    // keeps route colors at full, undimmed brightness regardless of zoom.
    map.setProjection('mercator');
    map.setFog(null);

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

// Touch support for mobile drawing
let isTouchDown = false;
let touchStartPoint = null;
let touchStartClientPos = null;
const SCULPT_MOVE_THRESHOLD_PX = 10;

document.getElementById("map").addEventListener("touchstart", (e) => {
    // Same conflict as the mousedown guard above - a marker's own touch
    // drag must not also trigger our sculpt-drag capture.
    if (e.target.closest('.mapboxgl-marker')) return;

    isTouchDown = true;

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

    let nearestDist = getHitRadiusDegrees(40);
    let nearestSegment = -1;

    for (let i = 0; i < roadRoute.length - 1; i++) {
        const closest = closestPointOnSegment(mapPoint, roadRoute[i], roadRoute[i + 1]);
        const dist = distance(mapPoint, closest);
        if (dist < nearestDist) {
            nearestDist = dist;
            nearestSegment = i;
        }
    }

    // Deliberately do NOT preventDefault or commit to sculpt mode here. A
    // stationary tap must still produce the browser's synthetic click event
    // so it falls through to map.on("click") -> addPoint() normally.
    // preventDefault() on touchstart suppresses that synthetic click
    // entirely, which was silently swallowing any tap landing within the
    // hit radius of an already-drawn route line - exactly the taps most
    // likely during a multi-point loop. We only commit to sculpting once
    // touchmove shows the finger actually moved (see SCULPT_MOVE_THRESHOLD_PX
    // below).
    if (nearestSegment !== -1) {
        touchStartPoint = { segment: nearestSegment, point: mapPoint };
        touchStartClientPos = { x: touch.clientX, y: touch.clientY };
    }
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

    if (touchStartPoint) {
        if (draggedPointIndex === -1) {
            const dx = touch.clientX - touchStartClientPos.x;
            const dy = touch.clientY - touchStartClientPos.y;
            if (Math.hypot(dx, dy) < SCULPT_MOVE_THRESHOLD_PX) return;

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

function endTouchDrag() {
    isTouchDown = false;
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
}

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
    document.getElementById("paceLabel").textContent = `Running Pace (min/${unitLabel}):`;

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
        followRoadsBeforeFreehand = isFollowRoads;
        isFollowRoads = false; // freehand strokes are always straight legs
    } else {
        map.dragPan.enable();
        isFollowRoads = followRoadsBeforeFreehand;
        isCapturingFreehand = false;
        clearFreehandPreview();
    }
});

document.getElementById("moreMenuBtn").addEventListener("click", function () {
    document.getElementById("moreMenu").classList.toggle("hidden");
});

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

document.getElementById("reorderBtn").addEventListener("click", toggleReorderPanel);

document.getElementById("closeReorderBtn").addEventListener("click", toggleReorderPanel);

document.getElementById("directionsBtn").addEventListener("click", () => {
    document.getElementById("moreMenu").classList.add("hidden");
    toggleDirectionsPanel();
});

document.getElementById("closeDirectionsBtn").addEventListener("click", toggleDirectionsPanel);

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
