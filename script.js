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

// Neon colors for legs (cycle through)
const legColors = [
    '#FF006E', '#FB5607', '#FFBE0B', '#8338EC',
    '#3A86FF', '#06FFA5', '#FF006E', '#FB5607'
];

function getPaceInput() {
    return parseFloat(document.getElementById("paceInput").value) || 5;
}

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
    const walkingMinutes = totalDuration / 60;
    const pace = getPaceInput();
    const runningMinutes = (distanceKm / pace) * 60;

    document.getElementById("distance").textContent = `Distance: ${distanceKm.toFixed(2)} km`;
    document.getElementById("walkingTime").textContent = `Walking: ${Math.round(walkingMinutes)} min`;
    document.getElementById("runningTime").textContent = `Running: ${Math.round(runningMinutes)} min`;
    document.getElementById("pace").textContent = `Pace: ${pace.toFixed(1)} min/km`;
    document.getElementById("hudSummary").textContent = `Distance: ${distanceKm.toFixed(2)} km`;
}

function updateMarkers() {
    markers.forEach(m => m.remove());
    markers = [];

    const markerSize = window.innerWidth < 768 ? '10px' : '12px';
    const borderWidth = window.innerWidth < 768 ? '1.5px' : '2px';

    route.forEach((point, idx) => {
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

        marker.on('dragstart', () => { el.style.cursor = 'grabbing'; });

        marker.on('dragend', async () => {
            el.style.cursor = 'grab';
            const lngLat = marker.getLngLat();
            route[idx] = [lngLat.lng, lngLat.lat];
            await rebuildRoute();
            updateMarkers();
        });

        markers.push(marker);
    });
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
            `?geometries=geojson&access_token=${mapboxgl.accessToken}`;

        const response = await fetch(url);
        const data = await response.json();

        if (data.routes && data.routes.length > 0) {
            const leg = data.routes[0];
            return {
                coordinates: leg.geometry.coordinates,
                distance: leg.distance,
                duration: leg.duration
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

    // Captured once, not re-read later: isFollowRoads can change (another
    // toggle click) while this call is still awaiting API responses. The
    // old code gated hideLoading() on the CURRENT isFollowRoads instead of
    // the value that was true when showLoading() actually ran - if a toggle
    // flipped it to false in between, hideLoading() would never fire and
    // #map would stay dimmed/disabled permanently.
    const wasFollowRoads = isFollowRoads;
    if (wasFollowRoads) showLoading();

    const newLegs = [];
    let newRoadRoute = [];
    let newTotalDistance = 0;
    let newTotalDuration = 0;

    // Get each leg - road-snapped (API) when Follow Roads is on, straight
    // line (instant, no API) when it's off. This is the single place that
    // builds legs, so Undo/Reorder/Click/Sculpt all respect the mode
    // consistently instead of disagreeing about what "free draw" means.
    for (let i = 0; i < route.length - 1; i++) {
        const legData = isFollowRoads
            ? await getRoadRoute(i, i + 1)
            : straightLineLeg(route[i], route[i + 1]);

        // A newer rebuildRoute() call started while we were awaiting the
        // API - abandon this one without touching shared state further.
        // hideLoading() is idempotent/safe to call even if nothing is
        // currently shown, so it's fine if the newer call's own showLoading/
        // hideLoading also runs independently - the important thing is this
        // call always clears whatever IT turned on.
        if (myGeneration !== rebuildGeneration) {
            if (wasFollowRoads) hideLoading();
            return;
        }

        if (legData) {
            const coords = i === 0 ? legData.coordinates : legData.coordinates.slice(1);
            newLegs.push({
                coordinates: legData.coordinates,
                distance: legData.distance,
                duration: legData.duration,
                isFallback: !!legData.isFallback
            });
            newRoadRoute.push(...coords);
            newTotalDistance += legData.distance;
            newTotalDuration += legData.duration;
        }
    }

    if (myGeneration !== rebuildGeneration) {
        if (wasFollowRoads) hideLoading();
        return;
    }

    legs.length = 0;
    legs.push(...newLegs);
    roadRoute = newRoadRoute;
    totalDistance = newTotalDistance;
    totalDuration = newTotalDuration;

    updateLayers();
    updateHUD();
    if (isFollowRoads) hideLoading();
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
            map.addLayer({
                id: glowLayerId,
                type: "line",
                source: sourceId,
                paint: {
                    "line-width": 18,
                    "line-color": color,
                    "line-opacity": 0.45,
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
            // dragged waypoint now lands on a real mapped path) - keep the
            // dash style in sync on updates too, not just first creation.
            map.setPaintProperty(coreLayerId, "line-dasharray", leg.isFallback ? [2, 2] : [1, 0]);
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

    if (route.length >= 2) {
        await rebuildRoute();
        if (isFollowRoads) showSnapIndicator(point);
    }

    updateMarkers();
    updateHUD();
}

function undo() {
    if (route.length === 0) return;

    route.pop();
    rebuildRoute();
    updateMarkers();
}

function clear() {
    route.length = 0;
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
                const [movedPoint] = route.splice(fromIdx, 1);
                route.splice(toIdx, 0, movedPoint);
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
            route.length = 0;
            route.push(...reordered);

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
        draggedPointIndex = dragStartPoint.segment + 1;
        route.splice(draggedPointIndex, 0, dragStartPoint.point);
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
            draggedPointIndex = touchStartPoint.segment + 1;
            route.splice(draggedPointIndex, 0, touchStartPoint.point);
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
document.getElementById("toggleFollowRoads").addEventListener("click", async function () {
    isFollowRoads = !isFollowRoads;
    this.textContent = `Follow Roads: ${isFollowRoads ? 'ON' : 'OFF'}`;
    this.classList.toggle("active");
    // If manually toggled while Freehand is active, keep the "restore on
    // Freehand-off" value in sync - otherwise turning Freehand off later
    // would silently discard this manual change and revert to whatever
    // Follow Roads was BEFORE Freehand was turned on.
    if (isFreehandMode) followRoadsBeforeFreehand = isFollowRoads;
    // Re-render the existing route in the new mode immediately, instead of
    // only affecting points added after the toggle.
    await rebuildRoute();
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

document.getElementById("reorderBtn").addEventListener("click", toggleReorderPanel);

document.getElementById("closeReorderBtn").addEventListener("click", toggleReorderPanel);

document.getElementById("undoBtn").addEventListener("click", undo);

document.getElementById("clearBtn").addEventListener("click", clear);

document.getElementById("closeLoopBtn").addEventListener("click", closeLoop);

document.getElementById("paceInput").addEventListener("change", debounce(updateHUD, 100));

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
