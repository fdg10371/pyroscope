import "../pof_explorer/static/vendor/leaflet.js";
import "../pof_explorer/static/vendor/leaflet.css";
import "../pof_explorer/static/style.css";
import "./style.css";
import geography from "../pof_explorer/static/countries.geojson?url";
import { DEFAULT_SOURCE, sourceURL } from "./data.js";

const L = window.L;
const element = id => document.getElementById(id);
let worker, layer, timer, times = [], currentRun, revision = 0, pointRevision = 0, token = 0, older = 0;
let sequence = 0;
const pending = new Map();
const status = (message, error = false) => {
  element("status").textContent = message;
  element("status").classList.toggle("error", error);
};
const controls = disabled => {
  for (const id of ["run", "step", "play", "previous", "next"]) element(id).disabled = disabled;
};
const formatTime = time => new Date(time).toLocaleString(undefined, {
  timeZone: "UTC", year: "numeric", month: "short", day: "numeric",
  hour: "2-digit", minute: "2-digit", hour12: false,
});
function call(method, ...args) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, method, args, token });
  });
}
function stop() {
  clearInterval(timer);
  timer = null;
  element("play").textContent = "Play forecast";
}
function resetWorker() {
  worker?.terminate();
  for (const request of pending.values()) request.reject(new Error("Connection refreshed."));
  pending.clear();
  worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  worker.onmessage = ({ data }) => {
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.error) request.reject(new Error(data.error));
    else request.resolve(data.result);
  };
  worker.onerror = event => {
    const error = new Error(`Zarr worker failed: ${event.message || "check browser console"}`);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    stop();
    controls(true);
    status(error.message, true);
  };
}
const map = L.map("map", { maxZoom: 10, minZoom: 1 }).setView([15, 5], 2);
map.createPane("basemap").style.zIndex = 150;
async function loadBasemap() {
 try {
  const response = await fetch(geography);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  L.geoJSON(await response.json(), {
    pane: "basemap",
    style: { color: "#b3bfbc", weight: .7, fillColor: "#f7f7f3", fillOpacity: 1 },
    interactive: false,
    attribution: '<a href="https://www.naturalearthdata.com/">Natural Earth</a> (public domain)',
  }).addTo(map);
 } catch (error) {
   status(`Basemap unavailable: ${error.message}`, true);
 }
}
loadBasemap();

const ProbabilityLayer = L.GridLayer.extend({
  createTile(coords, done) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    const viewToken = token;
    call("tile", currentRun, Number(element("step").value), coords.z, coords.x, coords.y).then(pixels => {
      if (viewToken !== token) { done(null, canvas); return; }
      canvas.getContext("2d").putImageData(new ImageData(pixels, 256, 256), 0, 0);
      done(null, canvas);
    }).catch(error => done(error, canvas));
    return canvas;
  },
});

function clearForecast() {
  token++;
  worker?.postMessage({ method: "generation", token });
  pointRevision++;
  map.closePopup();
  if (layer) { map.removeLayer(layer); layer = null; }
}
function render() {
  clearForecast();
  const label = `${formatTime(times[Number(element("step").value)])} UTC`;
  element("valid").textContent = label;
  element("map-date").textContent = label;
  const thisLayer = new ProbabilityLayer({
    opacity: Number(element("opacity").value) / 100, maxZoom: 10,
    bounds: [[-85.051129, -180], [85.051129, 180]], keepBuffer: 0,
  });
  let failed = false;
  thisLayer.on("tileerror", event => {
    if (layer !== thisLayer) return;
    failed = true;
    stop();
    status(`Forecast could not load: ${event.error.message} Use Connect / refresh data to retry.`, true);
  });
  thisLayer.on("load", () => {
    if (layer === thisLayer && !failed) status("Forecast ready. Click the map for a grid-cell probability.");
  });
  layer = thisLayer;
  status("Reading and decoding forecast chunks...");
  layer.addTo(map);
}
async function selectRun() {
  const version = ++revision;
  stop();
  controls(true);
  clearForecast();
  times = [];
  element("valid").textContent = "Loading forecast...";
  element("map-date").textContent = "";
  const selected = Number(element("run").value);
  try {
    const forecast = await call("forecast", selected);
    if (version !== revision) return;
    if (!forecast.length) throw new Error("This run has no forecast times.");
    times = forecast;
    currentRun = selected;
    element("step").max = times.length - 1;
    element("step").value = 0;
    controls(false);
    element("older").disabled = older === 0;
    render();
  } catch (error) {
    if (version !== revision) return;
    status(error.message, true);
    element("run").disabled = false;
  }
}
function appendRuns(catalog) {
  older = catalog.older;
  const options = catalog.runs.slice().reverse().map(run => new Option(formatTime(run.time), run.index));
  element("run").append(...options);
  element("older").disabled = older === 0;
  element("older").textContent = older ? `Load older runs (${older} remaining)` : "All runs loaded";
}
async function initialize() {
  const version = ++revision;
  stop();
  controls(true);
  element("older").disabled = true;
  clearForecast();
  times = [];
  element("valid").textContent = "Awaiting data";
  element("map-date").textContent = "";
  element("run").replaceChildren(new Option("Connecting...", ""));
  resetWorker();
  status("Checking direct Zarr access and reading fresh metadata...");
  try {
    const source = sourceURL(element("source").value, location.protocol);
    const catalog = await call("open", source);
    if (version !== revision) return;
    element("run").replaceChildren();
    appendRuns(catalog);
    if (!catalog.runs.length) throw new Error("No forecast runs available.");
    element("connection").textContent = `Connected directly to Zarr. Metadata read ${new Date().toLocaleTimeString()}. Refresh to discover updates.`;
    await selectRun();
  } catch (error) {
    if (version !== revision) return;
    status(error.message, true);
  }
}
map.on("click", async event => {
  if (!times.length || element("step").disabled) return;
  const requestId = ++pointRevision;
  const popup = L.popup().setLatLng(event.latlng).setContent("Reading grid-cell probability...").openOn(map);
  try {
    const value = await call("point", currentRun, Number(element("step").value), event.latlng.lat, event.latlng.lng);
    if (requestId !== pointRevision) return;
    const content = document.createElement("div");
    content.textContent = `${value.probability === null ? "No data" : `${(value.probability * 100).toLocaleString(undefined, { maximumFractionDigits: 3 })}% daily probability`} at grid centre ${value.lat.toFixed(3)}, ${value.lon.toFixed(3)}. Valid ${formatTime(times[Number(element("step").value)])} UTC.`;
    popup.setContent(content);
  } catch (error) {
    if (requestId !== pointRevision) return;
    const content = document.createElement("div");
    content.textContent = error.message;
    popup.setContent(content);
    status(error.message, true);
  }
});
element("run").addEventListener("change", selectRun);
element("step").addEventListener("input", () => { stop(); render(); });
element("opacity").addEventListener("input", () => layer?.setOpacity(Number(element("opacity").value) / 100));
function advance(delta) {
  element("step").value = (Number(element("step").value) + delta + times.length) % times.length;
  render();
}
element("previous").addEventListener("click", () => { stop(); advance(-1); });
element("next").addEventListener("click", () => { stop(); advance(1); });
element("play").addEventListener("click", () => {
  if (timer) { stop(); return; }
  element("play").textContent = "Pause forecast";
  timer = setInterval(() => { if (!layer?.isLoading()) advance(1); }, 1400);
});
element("older").addEventListener("click", async () => {
  const version = revision;
  element("older").disabled = true;
  try {
    const catalog = await call("runs", older);
    if (version === revision) appendRuns(catalog);
  } catch (error) {
    if (version !== revision) return;
    status(error.message, true);
    element("older").disabled = false;
  }
});
element("source").value = import.meta.env.VITE_ZARR_URL || DEFAULT_SOURCE;
element("source-form").addEventListener("submit", event => { event.preventDefault(); initialize(); });
initialize();
