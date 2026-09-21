//init
console.log("My JavaScript loaded");
console.log(mapboxgl);
mapboxgl.accessToken = MAPBOX_TOKEN;
//init map
const map = new mapboxgl.Map({
    container: "map",
    style: "mapbox://styles/mapbox/standard",
    center: [-74.01, 40.89],
    zoom: 13

});
//init data and layers
const route = [];
const currentPoints = [];

// road route func:
async function getRoadRoute() {
    if (currentPoints.length < 2) {
        return;
    }

    const coordinates = currentPoints
        .map(point => point.join(","))
        .join(";");

    const url =
        `https://api.mapbox.com/directions/v5/mapbox/walking/${coordinates}` +
        `?geometries=geojson&access_token=${mapboxgl.accessToken}`;

    console.log("Requesting:", url);

    const response = await fetch(url);
    const data = await response.json();

    console.log("Directions:", data);

    if (data.routes && data.routes.length > 0) {
        const route = data.routes[0];

        console.log("ROAD ROUTE:", route.geometry);

        map.getSource("route").setData({
            type: "Feature",
            geometry: route.geometry
        });

        // Calculate display values
        const distanceKm = route.distance / 1000;
        const walkingMinutes = route.duration / 60;

        // Update HUD
        document.getElementById("distance").textContent =
            `Distance: ${distanceKm.toFixed(2)} km`;

        document.getElementById("time").textContent =
            `Walking: ${Math.round(walkingMinutes)} min`;
    

        console.log("ROAD ROUTE:", route.geometry);

    } else {
        console.log("No route found:", data);
    }

}

map.on("load", function () {
    map.addSource("route", {
        type: "geojson",
        data: {
            type: "Feature",
            geometry: {
                type: "LineString",
                coordinates: []
            }
        }
    });

    map.addLayer({
        id: "route-line",
        type: "line",
        source: "route",
        paint: {
            "line-width": 4
        }
    });
});
// when click add point

map.on("click", function (event) {


    const point = [event.lngLat.lng, event.lngLat.lat];

    route.push(point);

    currentPoints.push(point);

    if (currentPoints.length > 2) {
        currentPoints.shift();
    }

    new mapboxgl.Marker()
        .setLngLat(point)
        .addTo(map);

    
    console.log(" Full Route: ", route)
    console.log("last two points ", currentPoints);

    if (currentPoints.length === 2) {
        getRoadRoute();
    }

});
