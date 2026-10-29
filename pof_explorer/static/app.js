/* global L */
"use strict";
const element = id => document.getElementById(id);
let map, layer, timer, times = [], currentRun, revision = 0, pointRevision = 0;
const status = (message, error = false) => {
  element("status").textContent = message;
  element("status").classList.toggle("error", error);
};
const controls = disabled => {
  for (const id of ["run", "step", "play", "previous", "next"]) element(id).disabled = disabled;
};
const formatTime = time => new Date(`${time}Z`).toLocaleString(undefined, {
  timeZone: "UTC", year: "numeric", month: "short", day: "numeric",
  hour: "2-digit", minute: "2-digit", hour12: false,
});
async function request(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.json();
    throw new Error(typeof body.detail === "string" ? body.detail : `Request failed (${response.status})`);
  }
  return response.json();
}
function stop() {
  clearInterval(timer);
  timer = null;
  element("play").textContent = "Play forecast";
}
function render() {
  pointRevision++;
  map.closePopup();
  const step = Number(element("step").value);
  const label = `${formatTime(times[step])} UTC`;
  element("valid").textContent = label;
  element("map-date").textContent = label;
  if (layer) map.removeLayer(layer);
  const thisLayer = L.tileLayer(`/api/tiles/{z}/{x}/{y}.png?run=${encodeURIComponent(currentRun)}&step=${step}`, {
    opacity: Number(element("opacity").value) / 100, maxZoom: 10, maxNativeZoom: 10,
    bounds: [[-85.051129, -180], [85.051129, 180]],
  });
  let failed = false;
  thisLayer.on("tileerror", () => {
    if (layer !== thisLayer) return;
    failed = true;
    stop();
    status("Some forecast tiles could not load. Retry the connection or check backend logs.", true);
    element("retry").hidden = false;
  });
  thisLayer.on("load", () => {
    if (layer === thisLayer && !failed) status("Forecast ready. Click the map for a grid-cell probability.");
  });
  layer = thisLayer;
  status("Loading forecast map...");
  layer.addTo(map);
}
async function selectRun() {
  const version = ++revision;
  stop();
  controls(true);
  if (layer) { map.removeLayer(layer); layer = null; }
  pointRevision++;
  map.closePopup();
  times = [];
  element("valid").textContent = "Loading forecast...";
  element("map-date").textContent = "";
  const selected = element("run").value;
  try {
    const forecast = await request(`/api/forecast?run=${encodeURIComponent(selected)}`);
    if (version !== revision) return;
    times = forecast.times;
    if (!times.length) throw new Error("This run has no forecast times.");
    currentRun = selected;
    element("step").max = times.length - 1;
    element("step").value = 0;
    controls(false);
    render();
  } catch (error) {
    status(error.message, true);
    element("run").disabled = false;
    element("retry").hidden = false;
  }
}
async function initialize() {
  controls(true);
  stop();
  element("retry").hidden = true;
  status("Connecting to the data store...");
  try {
    if (!window.L) throw new Error("Map library unavailable. Check the static asset deployment and reload.");
    if (!map) {
      map = L.map("map", { maxZoom: 10, minZoom: 1 }).setView([15, 5], 2);
      map.createPane("basemap").style.zIndex = 150;
      const geography = await request("/static/countries.geojson");
      L.geoJSON(geography, {
        pane: "basemap",
        style: { color: "#b3bfbc", weight: .7, fillColor: "#f7f7f3", fillOpacity: 1 },
        interactive: false,
        attribution: '<a href="https://www.naturalearthdata.com/">Natural Earth</a> (public domain)',
      }).addTo(map);
      map.on("click", async event => {
        if (!times.length || element("step").disabled) return;
        const requestId = ++pointRevision;
        const lon = ((event.latlng.lng + 180) % 360 + 360) % 360 - 180;
        const popup = L.popup().setLatLng(event.latlng).setContent("Loading probability...").openOn(map);
        try {
          const value = await request(`/api/point?run=${encodeURIComponent(currentRun)}&step=${element("step").value}&lat=${event.latlng.lat}&lon=${lon}`);
          if (requestId !== pointRevision) return;
          const content = document.createElement("div");
          content.textContent = `${value.probability === null ? "No data" : `${(value.probability * 100).toLocaleString(undefined, { maximumFractionDigits: 3 })}% daily probability`} at grid centre ${value.lat.toFixed(3)}, ${value.lon.toFixed(3)}. Valid ${formatTime(times[Number(element("step").value)])} UTC.`;
          popup.setContent(content);
        } catch (error) {
          if (map && !map.listens("click")) {
            map.remove();
            map = null;
          }
          if (requestId !== pointRevision) return;
          const content = document.createElement("div");
          content.textContent = error.message;
          popup.setContent(content);
          status(error.message, true);
        }
      });
    }
    const catalog = await request("/api/catalog");
    if (!catalog.runs.length) throw new Error("No forecast runs available.");
    element("run").replaceChildren(...catalog.runs.slice().reverse().map(run => new Option(formatTime(run), run)));
    await selectRun();
  } catch (error) {
    status(error.message, true);
    element("retry").hidden = false;
  }
}
element("run").addEventListener("change", selectRun);
element("step").addEventListener("input", () => { stop(); render(); });
element("opacity").addEventListener("input", () => layer?.setOpacity(Number(element("opacity").value) / 100));
function advance(delta) {
  const input = element("step");
  input.value = (Number(input.value) + delta + times.length) % times.length;
  render();
}
element("previous").addEventListener("click", () => { stop(); advance(-1); });
element("next").addEventListener("click", () => { stop(); advance(1); });
element("play").addEventListener("click", () => {
  if (timer) { stop(); return; }
  element("play").textContent = "Pause forecast";
  timer = setInterval(() => { if (!layer?.isLoading()) advance(1); }, 1400);
});
element("retry").addEventListener("click", initialize);
initialize();
