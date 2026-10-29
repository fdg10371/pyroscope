import Blosc from "numcodecs/blosc";

export async function makeFixture(runCount = 2) {
  const compressor = { id: "blosc", cname: "lz4", clevel: 5, shuffle: 1, blocksize: 0 };
  const codec = Blosc.fromConfig(compressor);
  const metadata = { ".zgroup": { zarr_format: 2 }, ".zattrs": {} };
  const files = new Map();
  const encoder = new TextEncoder();
  async function array(name, shape, chunks, dimensions, dtype, attrs, chunkValues) {
    metadata[`${name}/.zarray`] = {
      zarr_format: 2, shape, chunks, dtype, compressor, filters: null, order: "C",
      dimension_separator: ".", fill_value: dtype === "<f8" ? "NaN" : null,
    };
    metadata[`${name}/.zattrs`] = { _ARRAY_DIMENSIONS: dimensions, ...attrs };
    for (const [key, values] of chunkValues) {
      const data = dtype === "<f8" ? new Float64Array(values) : new BigInt64Array(values.map(BigInt));
      files.set(`${name}/${key}`, await codec.encode(new Uint8Array(data.buffer)));
    }
  }
  const baseChunks = Array.from({ length: runCount }, (_, index) => [`${index}`, [index]]);
  const timeChunks = Array.from({ length: runCount }, (_, index) => [`${index}.0`, [index, index + 2]]);
  await array("base_time", [runCount], [1], ["base_time"], "<i8", {
    units: "days since 2026-10-27 00:00:00", calendar: "proleptic_gregorian",
  }, baseChunks);
  await array("forecast_time", [runCount, 2], [1, 2], ["base_time", "forecast_index"], "<i8", {
    units: "days since 2026-10-27 00:00:00", calendar: "proleptic_gregorian",
  }, timeChunks);
  await array("forecast_index", [2], [2], ["forecast_index"], "<i8", {}, [["0", [0, 1]]]);
  await array("lat", [4], [4], ["lat"], "<f8", {}, [["0", [75, 25, -25, -75]]]);
  await array("lon", [8], [8], ["lon"], "<f8", {}, [["0", [-180, -135, -90, -45, 0, 45, 90, 135]]]);
  const values = [];
  for (let run = 0; run < runCount; run++) {
    for (let step = 0; step < 2; step++) {
      for (let row = 0; row < 2; row++) {
        for (let col = 0; col < 2; col++) {
          const block = Array(8).fill(step ? .1 : .05);
          if (row === 0 && col === 0) { block[0] = NaN; block[5] = 0; }
          values.push([`${run}.${step}.${row}.${col}`, block]);
        }
      }
    }
  }
  await array("MODEL_FIRE", [runCount, 2, 4, 8], [1, 1, 2, 4],
    ["base_time", "forecast_index", "lat", "lon"], "<f8", {}, values);
  const updateMetadata = () => files.set(".zmetadata", encoder.encode(JSON.stringify({
    zarr_consolidated_format: 1, metadata,
  })));
  updateMetadata();
  return { files, metadata, updateMetadata, codec };
}
