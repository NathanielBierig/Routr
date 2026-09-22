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
let isDrawingMode = true;
let isFollowRoads = true;
let isDraggingLine = false;
let draggedPointIndex = -1;
let freehandPath = [];
let isDrawingFreehand = false;
let isLoading = false;

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

function showLoading() {
    isLoading = true;
    const map_el = document.getElementById("map");
    map_el.style.opacity = "0.7";
    map_el.style.pointerEvents = "none";
}

function hideLoading() {
    isLoading = false;
    const map_el = document.getElementById("map");
    map_el.style.opacity = "1";
    map_el.style.pointerEvents = "auto";
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
        el.style.cursor = 'pointer';
        el.style.boxShadow = `0 0 8px ${color}80`;
        el.style.transition = 'box-shadow 0.2s';

        const marker = new mapboxgl.Marker({ element: el })
            .setLngLat(point)
            .addTo(map);
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
        const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?access_token=${mapboxgl.accessToken}`;
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

async function getRoadRoute(startIdx, endIdx) {
    if (startIdx >= route.length || endIdx >= route.length) return null;

    try {
        const coordinates = [route[startIdx], route[endIdx]]
            .map(point => point.join(","))
            .join(";");

        const url =
            `https://api.mapbox.com/directions/v5/mapbox/${isFollowRoads ? 'walking' : 'driving'}/${coordinates}` +
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
    } catch (err) {
        console.error("Route request failed:", err);
    }
    return null;
}

async function rebuildRoute() {
    legs.length = 0;
    roadRoute = [];
    totalDistance = 0;
    totalDuration = 0;

    if (route.length < 2) {
        updateLayers();
        updateHUD();
        return;
    }

    showLoading();

    // Get road routes for each leg
    for (let i = 0; i < route.length - 1; i++) {
        const legData = await getRoadRoute(i, i + 1);
        if (legData) {
            const coords = i === 0 ? legData.coordinates : legData.coordinates.slice(1);
            legs.push({
                coordinates: legData.coordinates,
                distance: legData.distance,
                duration: legData.duration
            });
            roadRoute.push(...coords);
            totalDistance += legData.distance;
            totalDuration += legData.duration;
        }
    }

    updateLayers();
    updateHUD();
    hideLoading();
}

function updateLayers() {
    if (map.getSource("route")) {
        map.getSource("route").setData({
            type: "Feature",
            geometry: { type: "LineString", coordinates: roadRoute }
        });
    }

    legs.forEach((leg, idx) => {
        const layerId = `route-leg-${idx}`;
        const sourceId = `route-source-${idx}`;

        if (!map.getSource(sourceId)) {
            map.addSource(sourceId, {
                type: "geojson",
                data: {
                    type: "Feature",
                    geometry: { type: "LineString", coordinates: leg.coordinates }
                }
            });
            map.addLayer({
                id: layerId,
                type: "line",
                source: sourceId,
                paint: {
                    "line-width": 10,
                    "line-color": legColors[idx % legColors.length],
                    "line-opacity": 1,
                    "line-blur": 0.5
                }
            });
        } else {
            map.getSource(sourceId).setData({
                type: "Feature",
                geometry: { type: "LineString", coordinates: leg.coordinates }
            });
        }
    });
}

function drawFreehandLine(point) {
    if (!isDrawingFreehand) return;

    freehandPath.push(point);

    if (!map.getSource("freehand")) {
        map.addSource("freehand", {
            type: "geojson",
            data: {
                type: "Feature",
                geometry: { type: "LineString", coordinates: freehandPath }
            }
        });
        map.addLayer({
            id: "freehand-line",
            type: "line",
            source: "freehand",
            paint: {
                "line-width": 6,
                "line-color": "#00FFFF",
                "line-opacity": 0.9
            }
        });
    } else {
        map.getSource("freehand").setData({
            type: "Feature",
            geometry: { type: "LineString", coordinates: freehandPath }
        });
    }
}

function finalizeFreehandPath() {
    if (freehandPath.length < 2) {
        freehandPath = [];
        return;
    }

    // Simplify path (every nth point to avoid too many route requests)
    const step = Math.max(1, Math.floor(freehandPath.length / 5));
    const simplified = [freehandPath[0]];
    for (let i = step; i < freehandPath.length; i += step) {
        simplified.push(freehandPath[i]);
    }
    simplified.push(freehandPath[freehandPath.length - 1]);

    // Add simplified points to route
    simplified.forEach(point => {
        if (route.length === 0 || Math.hypot(route[route.length - 1][0] - point[0], route[route.length - 1][1] - point[1]) > 0.0001) {
            route.push(point);
        }
    });

    freehandPath = [];
    if (map.getSource("freehand")) {
        map.getSource("freehand").setData({
            type: "Feature",
            geometry: { type: "LineString", coordinates: [] }
        });
    }

    rebuildRoute();
    updateMarkers();
}

function showSnapIndicator(clickedPoint) {
    if (roadRoute.length === 0) return;

    let nearestDist = Infinity;
    let nearestPoint = null;
    roadRoute.forEach(p => {
        const d = distance(clickedPoint, p);
        if (d < nearestDist) {
            nearestDist = d;
            nearestPoint = p;
        }
    });

    // Only show snap indicator if the snap moved the point meaningfully (~15m+)
    if (!nearestPoint || nearestDist < 0.00012) return;

    const el = document.createElement('div');
    el.className = 'snap-ring';
    const ringMarker = new mapboxgl.Marker({ element: el })
        .setLngLat(nearestPoint)
        .addTo(map);

    setTimeout(() => ringMarker.remove(), 900);
}

async function addPoint(point) {
    route.push(point);

    if (isFollowRoads && route.length >= 2) {
        await rebuildRoute();
        showSnapIndicator(point);
    } else if (!isFollowRoads) {
        // Free draw mode - just add straight lines
        roadRoute.push(point);
        if (map.getSource("route")) {
            map.getSource("route").setData({
                type: "Feature",
                geometry: { type: "LineString", coordinates: roadRoute }
            });
        }
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
    freehandPath = [];

    // Clear all layers
    for (let i = 0; i < 10; i++) {
        const layerId = `route-leg-${i}`;
        const sourceId = `route-source-${i}`;
        if (map.getLayer(layerId)) map.removeLayer(layerId);
        if (map.getSource(sourceId)) map.removeSource(sourceId);
    }

    if (map.getSource("route")) {
        map.getSource("route").setData({
            type: "Feature",
            geometry: { type: "LineString", coordinates: [] }
        });
    }

    if (map.getSource("freehand")) {
        map.getSource("freehand").setData({
            type: "Feature",
            geometry: { type: "LineString", coordinates: [] }
        });
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
        const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?access_token=${mapboxgl.accessToken}`;
        const response = await fetch(url);
        const data = await response.json();
        if (data.features && data.features.length > 0) {
            return data.features[0].place_name || `Point ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
        }
    } catch (err) {
        console.error("Reverse geocoding failed:", err);
    }
    return `Point ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
}

function updateReorderList() {
    const list = document.getElementById("reorderList");
    list.innerHTML = "";

    route.forEach((point, idx) => {
        const item = document.createElement("div");
        item.className = "waypoint-item";
        item.draggable = true;
        item.dataset.index = idx;

        // Show address instead of coordinates
        getAddressFromCoords(point[0], point[1]).then(address => {
            item.textContent = `${idx + 1}. ${address}`;
        });

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

    // Freehand drawing source
    map.addSource("freehand", {
        type: "geojson",
        data: {
            type: "Feature",
            geometry: { type: "LineString", coordinates: [] }
        }
    });

    map.addLayer({
        id: "freehand-line",
        type: "line",
        source: "freehand",
        paint: {
            "line-width": 6,
            "line-color": "#00FFFF",
            "line-opacity": 0.9
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
    if (!isDrawingMode) return;

    const point = [event.lngLat.lng, event.lngLat.lat];
    await addPoint(point);
});

// Drag handling for sculpting
let isMouseDown = false;
let dragStartPoint = null;

document.getElementById("map").addEventListener("mousedown", (e) => {
    if (!isDrawingMode) return;
    isMouseDown = true;
    dragStartPoint = null;

    const point = map.unproject([e.clientX - map.getContainer().getBoundingClientRect().left, e.clientY - map.getContainer().getBoundingClientRect().top]);
    const mapPoint = [point.lng, point.lat];

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

document.getElementById("map").addEventListener("mousemove", async (e) => {
    if (!isMouseDown || !dragStartPoint) return;

    const point = map.unproject([e.clientX - map.getContainer().getBoundingClientRect().left, e.clientY - map.getContainer().getBoundingClientRect().top]);
    const mapPoint = [point.lng, point.lat];

    if (draggedPointIndex === -1) {
        draggedPointIndex = dragStartPoint.segment + 1;
        route.splice(draggedPointIndex, 0, dragStartPoint.point);
        isDraggingLine = true;
    }

    route[draggedPointIndex] = mapPoint;
    await rebuildRoute();
    updateMarkers();
});

document.getElementById("map").addEventListener("mouseup", async () => {
    isMouseDown = false;
    if (isDraggingLine) {
        isDraggingLine = false;
        draggedPointIndex = -1;
    }
    dragStartPoint = null;
});

// Touch support for mobile drawing
let isTouchDown = false;
let touchStartPoint = null;

document.getElementById("map").addEventListener("touchstart", (e) => {
    if (!isDrawingMode) return;
    isTouchDown = true;

    const touch = e.touches[0];
    const bounds = map.getContainer().getBoundingClientRect();
    const point = map.unproject([touch.clientX - bounds.left, touch.clientY - bounds.top]);
    const mapPoint = [point.lng, point.lat];

    let nearestDist = getHitRadiusDegrees(28);
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
        e.preventDefault();
        touchStartPoint = { segment: nearestSegment, point: mapPoint };
    }
}, false);

document.getElementById("map").addEventListener("touchmove", async (e) => {
    if (!isTouchDown) return;

    if (touchStartPoint) {
        e.preventDefault();
        const touch = e.touches[0];
        const bounds = map.getContainer().getBoundingClientRect();
        const point = map.unproject([touch.clientX - bounds.left, touch.clientY - bounds.top]);
        const mapPoint = [point.lng, point.lat];

        if (draggedPointIndex === -1) {
            draggedPointIndex = touchStartPoint.segment + 1;
            route.splice(draggedPointIndex, 0, touchStartPoint.point);
            isDraggingLine = true;
        }

        route[draggedPointIndex] = mapPoint;
        await rebuildRoute();
        updateMarkers();
    }
}, false);

document.getElementById("map").addEventListener("touchend", async (e) => {
    isTouchDown = false;
    if (isDraggingLine) {
        isDraggingLine = false;
        draggedPointIndex = -1;
    }
    touchStartPoint = null;
}, false);

// Buttons
document.getElementById("toggleDrawMode").addEventListener("click", function () {
    isDrawingMode = !isDrawingMode;
    this.textContent = `Drawing Mode: ${isDrawingMode ? 'ON' : 'OFF'}`;
    this.classList.toggle("active");
});

document.getElementById("toggleFollowRoads").addEventListener("click", function () {
    isFollowRoads = !isFollowRoads;
    this.textContent = `Follow Roads: ${isFollowRoads ? 'ON' : 'OFF'}`;
    this.classList.toggle("active");
});

document.getElementById("reorderBtn").addEventListener("click", toggleReorderPanel);

document.getElementById("closeReorderBtn").addEventListener("click", toggleReorderPanel);

document.getElementById("undoBtn").addEventListener("click", undo);

document.getElementById("clearBtn").addEventListener("click", clear);

document.getElementById("closeLoopBtn").addEventListener("click", closeLoop);

document.getElementById("paceInput").addEventListener("change", debounce(updateHUD, 100));

document.getElementById("searchInput").addEventListener("keypress", async function (e) {
    if (e.key === "Enter" && this.value.trim()) {
        const coords = await searchPlace(this.value);
        if (coords) {
            this.value = "";
        }
    }
});

document.getElementById("hudToggle").addEventListener("click", function () {
    document.getElementById("hud").classList.toggle("expanded");
});

// Set initial active state for buttons
document.getElementById("toggleDrawMode").classList.add("active");
document.getElementById("toggleFollowRoads").classList.add("active");

// Hide help overlay after first click
map.once("click", () => {
    const overlay = document.getElementById("helpOverlay");
    if (overlay) overlay.remove();
});

updateHUD();
