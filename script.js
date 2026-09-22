console.log("My JavaScript loaded");
console.log(mapboxgl);
mapboxgl.accessToken = MAPBOX_TOKEN;

const map = new mapboxgl.Map({
    container: "map",
    style: "mapbox://styles/mapbox/standard",
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

// Neon colors for legs (cycle through)
const legColors = [
    '#FF006E', '#FB5607', '#FFBE0B', '#8338EC',
    '#3A86FF', '#06FFA5', '#FF006E', '#FB5607'
];

function getPaceInput() {
    return parseFloat(document.getElementById("paceInput").value) || 5;
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
}

function updateMarkers() {
    // Clear existing markers
    markers.forEach(m => m.remove());
    markers = [];

    route.forEach((point, idx) => {
        let color = '#888888'; // old points - gray
        if (idx === 0) color = '#00AA44'; // start - green
        else if (idx === route.length - 1) color = '#FF0000'; // newest - red

        const el = document.createElement('div');
        el.style.width = '12px';
        el.style.height = '12px';
        el.style.backgroundColor = color;
        el.style.borderRadius = '50%';
        el.style.border = '2px solid white';
        el.style.cursor = 'pointer';

        const marker = new mapboxgl.Marker({ element: el })
            .setLngLat(point)
            .addTo(map);
        markers.push(marker);
    });
}

async function getRoadRoute(startIdx, endIdx) {
    if (startIdx >= route.length || endIdx >= route.length) return null;

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
}

function updateLayers() {
    // Update route line with full accumulated path
    if (map.getSource("route")) {
        map.getSource("route").setData({
            type: "Feature",
            geometry: { type: "LineString", coordinates: roadRoute }
        });
    }

    // Update individual leg layers (for different colors)
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
                    "line-width": 5,
                    "line-color": legColors[idx % legColors.length],
                    "line-opacity": 0.8,
                    "line-dasharray": [2, 2]
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
    if (!isDrawingFreehand || !isDrawingMode) return;

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
                "line-width": 3,
                "line-color": "#00FFFF",
                "line-dasharray": [4, 4]
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

async function addPoint(point) {
    route.push(point);

    if (isFollowRoads && route.length >= 2) {
        await rebuildRoute();
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
            "line-width": 5,
            "line-color": "#FFFFFF",
            "line-opacity": 0.3
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
            "line-width": 3,
            "line-color": "#00FFFF",
            "line-dasharray": [4, 4]
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

// Click to add point or sculpt route
map.on("click", async function (event) {
    if (!isDrawingMode) return;

    const point = [event.lngLat.lng, event.lngLat.lat];

    // Check if clicking near an existing route segment for sculpting
    let nearestDist = 0.001; // ~100 meters in degrees
    let nearestSegment = -1;

    for (let i = 0; i < roadRoute.length - 1; i++) {
        const closest = closestPointOnSegment(point, roadRoute[i], roadRoute[i + 1]);
        const dist = distance(point, closest);
        if (dist < nearestDist) {
            nearestDist = dist;
            nearestSegment = i;
        }
    }

    if (nearestSegment !== -1) {
        // Sculpting mode: insert a waypoint
        draggedPointIndex = nearestSegment + 1;
        isDraggingLine = true;
        // Add point temporarily
        route.splice(draggedPointIndex, 0, point);
        await rebuildRoute();
        updateMarkers();
    } else {
        // Normal mode: add new point
        if (isFollowRoads) {
            await addPoint(point);
        } else {
            roadRoute.push(point);
            route.push(point);
            if (map.getSource("route")) {
                map.getSource("route").setData({
                    type: "Feature",
                    geometry: { type: "LineString", coordinates: roadRoute }
                });
            }
            updateMarkers();
            updateHUD();
        }
    }
});

// Mouse down to start freehand drawing
map.on("mousedown", function (event) {
    if (!isDrawingMode || !isDrawingMode) return;
    isDrawingFreehand = true;
    freehandPath = [[event.lngLat.lng, event.lngLat.lat]];
});

// Mouse move for freehand drawing
map.on("mousemove", function (event) {
    if (isDrawingFreehand) {
        drawFreehandLine([event.lngLat.lng, event.lngLat.lat]);
    }
});

// Mouse up to finish freehand drawing
map.on("mouseup", function () {
    if (isDrawingFreehand) {
        isDrawingFreehand = false;
        finalizeFreehandPath();
    }
});

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

document.getElementById("undoBtn").addEventListener("click", undo);

document.getElementById("clearBtn").addEventListener("click", clear);

document.getElementById("closeLoopBtn").addEventListener("click", closeLoop);

document.getElementById("paceInput").addEventListener("change", updateHUD);

// Set initial active state for buttons
document.getElementById("toggleDrawMode").classList.add("active");
document.getElementById("toggleFollowRoads").classList.add("active");

updateHUD();
