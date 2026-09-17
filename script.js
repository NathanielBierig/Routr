console.log("My JavaScript loaded");
console.log(mapboxgl);
mapboxgl.accessToken = "";

const map = new mapboxgl.Map({
    container: "map",
    style: "mapbox://styles/mapbox/standard",
    center: [-74, 40.7],
    zoom: 9
});
const route = [];

map.on("click", function(event) {
    console.log(event.lngLat);
});
