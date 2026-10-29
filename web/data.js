import * as zarr from "zarrita";

export const DEFAULT_SOURCE = "https://cemsdata.data.compute.cci2.ecmwf.int/fire_front_radar/pof.zarr";
export const STOPS = [0, .001, .005, .01, .02, .05, .1, .2, 1];
export const COLORS = [
  [255, 245, 218], [252, 217, 184], [250, 176, 115],
  [237, 185, 118], [226, 114, 38], [228, 131, 119],
  [219, 110, 99], [199, 64, 61], [115, 9, 67],
];

export function sourceURL(raw, pageProtocol = "https:") {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Use an HTTP(S) Zarr directory URL without credentials, query, or fragment.");
  }
  if (pageProtocol === "https:" && url.protocol !== "https:") {
    throw new Error("GitHub Pages requires an HTTPS Zarr URL. An HTTP store is blocked as mixed content.");
  }
  return url.href.replace(/\/+$/, "");
}

export function nearest(values, target) {
  const ascending = values[0] < values[values.length - 1];
  let low = 0, high = values.length - 1;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if ((values[mid] < target) === ascending) low = mid;
    else high = mid;
  }
  return Math.abs(values[low] - target) <= Math.abs(values[high] - target) ? low : high;
}

export function probability(value) {
  if (Number.isNaN(value)) return null;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("MODEL_FIRE contains values outside [0, 1]. Expected probabilities or NaN.");
  }
  return value;
}

export function color(value, output, offset) {
  if (probability(value) === null) {
    output.fill(0, offset, offset + 4);
    return;
  }
  let stop = 1;
  while (stop < STOPS.length - 1 && value > STOPS[stop]) stop++;
  const fraction = (value - STOPS[stop - 1]) / (STOPS[stop] - STOPS[stop - 1]);
  for (let channel = 0; channel < 3; channel++) {
    output[offset + channel] = Math.floor(
      COLORS[stop - 1][channel] + fraction * (COLORS[stop][channel] - COLORS[stop - 1][channel])
    );
  }
  output[offset + 3] = 220;
}

export function decodeTime(value, attrs) {
  if (attrs.calendar && !["proleptic_gregorian", "gregorian", "standard"].includes(attrs.calendar)) {
    throw new Error(`Unsupported time calendar: ${attrs.calendar}`);
  }
  const units = /^(days|hours|minutes|seconds|milliseconds|microseconds|nanoseconds) since (.+)$/.exec(attrs.units || "");
  const numeric = Number(value);
  if (!units || !Number.isFinite(numeric) || numeric === -9223372036854775808) {
    throw new Error("Missing or unsupported forecast time encoding.");
  }
  let epoch = units[2].trim().replace(" ", "T");
  if (!epoch.includes("T")) epoch += "T00:00:00";
  if (!/(Z|[+-]\d\d:\d\d)$/.test(epoch)) epoch += "Z";
  const factors = { days: 86400000, hours: 3600000, minutes: 60000, seconds: 1000, milliseconds: 1, microseconds: .001, nanoseconds: .000001 };
  const result = new Date(Date.parse(epoch) + numeric * factors[units[1]]);
  if (!Number.isFinite(result.getTime())) throw new Error("Invalid forecast timestamp.");
  return result.toISOString();
}

function monotonic(values, name, minimum, maximum, exclusiveMaximum = false) {
  if (values.length < 2) throw new Error(`${name} requires at least two coordinates.`);
  const ascending = values[1] > values[0];
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i]) || values[i] < minimum ||
        (exclusiveMaximum ? values[i] >= maximum : values[i] > maximum) ||
        (i && (ascending ? values[i] <= values[i - 1] : values[i] >= values[i - 1]))) {
      throw new Error(`${name} coordinates must be finite, in range, and strictly monotonic.`);
    }
  }
}

export class Dataset {
  constructor(url) {
    this.url = url;
    this.active = 0;
    this.waiters = [];
    this.cache = new Map();
    this.pending = new Map();
    this.cacheBytes = 0;
  }

  async fetchBytes(path) {
    if (this.active >= 6) await new Promise(resolve => this.waiters.push(resolve));
    else this.active++;
    try {
      let response;
      try {
        response = await fetch(`${this.url}/${path}`, {
          cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(60000),
        });
      } catch (error) {
        throw new Error(`Cannot read the Zarr store: check HTTPS, DNS, CORS, and network access. ${error.message}`);
      }
      if (response.status === 404 && !path.startsWith(".")) return undefined;
      if (!response.ok) throw new Error(`Zarr request ${path} failed (HTTP ${response.status}).`);
      return new Uint8Array(await response.arrayBuffer());
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }

  async open() {
    const consolidated = JSON.parse(new TextDecoder().decode(await this.fetchBytes(".zmetadata")));
    if (consolidated.zarr_consolidated_format !== 1 || consolidated.metadata?.[".zgroup"]?.zarr_format !== 2) {
      throw new Error("Expected consolidated Zarr v2 metadata.");
    }
    this.metadata = consolidated.metadata;
    const encoder = new TextEncoder();
    const store = {
      get: async path => {
        const key = path.replace(/^\//, "");
        if (key in this.metadata) return encoder.encode(JSON.stringify(this.metadata[key]));
        if (key.endsWith(".zattrs") || key.endsWith(".zarray")) return undefined;
        // Zarr defines an absent chunk as its metadata fill value.
        return this.fetchBytes(key);
      },
    };
    const names = ["MODEL_FIRE", "base_time", "forecast_time", "forecast_index", "lat", "lon"];
    this.arrays = Object.fromEntries(await Promise.all(names.map(async name => [
      name, await zarr.open.v2(zarr.root(store).resolve(name), { kind: "array" }),
    ])));
    const dimensions = {
      MODEL_FIRE: ["base_time", "forecast_index", "lat", "lon"],
      base_time: ["base_time"], forecast_time: ["base_time", "forecast_index"],
      forecast_index: ["forecast_index"], lat: ["lat"], lon: ["lon"],
    };
    for (const [name, expected] of Object.entries(dimensions)) {
      if (JSON.stringify(this.arrays[name].attrs._ARRAY_DIMENSIONS) !== JSON.stringify(expected)) {
        throw new Error(`Unexpected ${name} dimensions.`);
      }
    }
    const field = this.arrays.MODEL_FIRE;
    const shape = field.shape;
    if (field.chunks[0] !== 1 || field.chunks[1] !== 1 ||
        !["float32", "float64"].includes(field.dtype) ||
        this.metadata["MODEL_FIRE/.zarray"].order !== "C") {
      throw new Error("Expected C-order float probabilities chunked by one run and one step.");
    }
    if (JSON.stringify(this.arrays.forecast_time.shape) !== JSON.stringify(shape.slice(0, 2)) ||
        this.arrays.base_time.shape[0] !== shape[0] ||
        this.arrays.forecast_index.shape[0] !== shape[1] ||
        this.arrays.lat.shape[0] !== shape[2] || this.arrays.lon.shape[0] !== shape[3] ||
        !shape.every(size => size > 0)) throw new Error("Inconsistent forecast array shapes.");
    this.lat = (await zarr.get(this.arrays.lat)).data;
    this.lon = (await zarr.get(this.arrays.lon)).data;
    monotonic(this.lat, "Latitude", -90, 90);
    monotonic(this.lon, "Longitude", -180, 180, true);
    return this.runs(shape[0]);
  }

  async runs(end) {
    if (!Number.isInteger(end) || end < 1 || end > this.arrays.base_time.shape[0]) {
      throw new Error("Invalid run page.");
    }
    const start = Math.max(0, end - 30);
    const result = await zarr.get(this.arrays.base_time, [zarr.slice(start, end)]);
    const runs = Array.from(result.data, (value, index) => ({
      index: start + index, time: decodeTime(value, this.arrays.base_time.attrs),
    }));
    for (let i = 1; i < runs.length; i++) {
      if (runs[i].time <= runs[i - 1].time) throw new Error("Forecast runs must be unique and increasing.");
    }
    return { runs, older: start, total: this.arrays.base_time.shape[0] };
  }

  validateFrame(run, step) {
    if (!Number.isInteger(run) || run < 0 || run >= this.arrays.MODEL_FIRE.shape[0] ||
        !Number.isInteger(step) || step < 0 || step >= this.arrays.MODEL_FIRE.shape[1]) {
      throw new Error("Forecast run or step is out of range.");
    }
  }

  async forecast(run) {
    this.validateFrame(run, 0);
    const result = await zarr.get(this.arrays.forecast_time, [run, null]);
    return Array.from(result.data, value => decodeTime(value, this.arrays.forecast_time.attrs));
  }

  async chunk(run, step, row, col) {
    const key = `${run}.${step}.${row}.${col}`;
    if (this.cache.has(key)) {
      const chunk = this.cache.get(key);
      this.cache.delete(key);
      this.cache.set(key, chunk);
      return chunk;
    }
    if (this.pending.has(key)) return this.pending.get(key);
    const pending = this.arrays.MODEL_FIRE.getChunk([run, step, row, col]).then(chunk => {
      for (const value of chunk.data) probability(value);
      const bytes = chunk.data.byteLength;
      while (this.cacheBytes + bytes > 128 * 1024 * 1024 && this.cache.size) {
        const first = this.cache.keys().next().value;
        this.cacheBytes -= this.cache.get(first).data.byteLength;
        this.cache.delete(first);
      }
      if (bytes <= 128 * 1024 * 1024) {
        this.cache.set(key, chunk);
        this.cacheBytes += bytes;
      }
      return chunk;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, pending);
    return pending;
  }

  async point(run, step, latitude, longitude) {
    this.validateFrame(run, step);
    if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude)) {
      throw new Error("Invalid point coordinates.");
    }
    const row = nearest(this.lat, latitude);
    const col = nearest(this.lon, ((longitude + 180) % 360 + 360) % 360 - 180);
    const [, , height, width] = this.arrays.MODEL_FIRE.chunks;
    const chunk = await this.chunk(run, step, Math.floor(row / height), Math.floor(col / width));
    const value = Number(chunk.data[(row % height) * chunk.stride[2] + (col % width) * chunk.stride[3]]);
    return { probability: probability(value), lat: this.lat[row], lon: this.lon[col] };
  }

  async tile(run, step, z, x, y) {
    this.validateFrame(run, step);
    if (!Number.isInteger(z) || z < 0 || z > 10 || !Number.isInteger(x) ||
        !Number.isInteger(y) || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) {
      throw new Error("Invalid tile coordinates.");
    }
    const rows = new Int32Array(256), cols = new Int32Array(256);
    const [, , height, width] = this.arrays.MODEL_FIRE.chunks;
    for (let pixel = 0; pixel < 256; pixel++) {
      const lon = ((x + (pixel + .5) / 256) / 2 ** z) * 360 - 180;
      const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + (pixel + .5) / 256) / 2 ** z))) * 180 / Math.PI;
      rows[pixel] = nearest(this.lat, lat);
      cols[pixel] = nearest(this.lon, lon);
    }
    const output = new Uint8ClampedArray(256 * 256 * 4);
    for (const chunkRow of new Set(Array.from(rows, row => Math.floor(row / height)))) {
      for (const chunkCol of new Set(Array.from(cols, col => Math.floor(col / width)))) {
        const chunk = await this.chunk(run, step, chunkRow, chunkCol);
        for (let py = 0; py < 256; py++) {
          if (Math.floor(rows[py] / height) !== chunkRow) continue;
          for (let px = 0; px < 256; px++) {
            if (Math.floor(cols[px] / width) !== chunkCol) continue;
            const value = Number(chunk.data[(rows[py] % height) * chunk.stride[2] + (cols[px] % width) * chunk.stride[3]]);
            color(value, output, (py * 256 + px) * 4);
          }
        }
      }
    }
    return output;
  }
}
