import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { Dataset, color, decodeTime, nearest, probability, sourceURL } from "./data.js";
import { makeFixture } from "../tests/zarr-fixture.js";

let fixture, server, url;
const requests = [];
before(async () => {
  fixture = await makeFixture(32);
  server = createServer((request, response) => {
    requests.push({ path: request.url, cache: request.headers["cache-control"] });
    const bytes = fixture.files.get(request.url.slice(1));
    response.writeHead(bytes ? 200 : 404, { "Access-Control-Allow-Origin": "*" });
    response.end(bytes);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test("HTTPS enforcement and source URL validation", () => {
  assert.throws(() => sourceURL("http://example.org/pof.zarr"), /HTTPS/);
  assert.throws(() => sourceURL("https://user:pass@example.org/pof.zarr"), /credentials/);
  assert.throws(() => sourceURL("file:///pof.zarr"), /HTTP/);
  assert.equal(sourceURL("https://example.org/pof.zarr/"), "https://example.org/pof.zarr");
});
test("nearest coordinates support both directions", () => {
  assert.equal(nearest([75, 25, -25, -75], 30), 1);
  assert.equal(nearest([-75, -25, 25, 75], 30), 2);
});
test("numeric probability scale and no-data alpha", () => {
  const output = new Uint8ClampedArray(12);
  color(0, output, 0); color(NaN, output, 4); color(.05, output, 8);
  assert.deepEqual([...output], [255, 245, 218, 220, 0, 0, 0, 0, 228, 131, 119, 220]);
  for (const value of [-.01, 1.01, Infinity]) assert.throws(() => probability(value));
  assert.equal(decodeTime(2n, { units: "days since 2026-10-27 00:00:00" }), "2026-10-29T00:00:00.000Z");
  assert.throws(() => decodeTime(-9223372036854775808n, { units: "days since 2024-01-01" }));
});
test("Blosc/LZ4 metadata, coordinates, paged runs, and original forecast times", async () => {
  const dataset = new Dataset(url);
  const catalog = await dataset.open();
  assert.equal(catalog.total, 32);
  assert.equal(catalog.runs.length, 30);
  assert.equal(catalog.older, 2);
  assert.deepEqual((await dataset.runs(2)).runs.map(run => run.index), [0, 1]);
  assert.deepEqual(await dataset.forecast(0), [
    "2026-10-27T00:00:00.000Z", "2026-10-29T00:00:00.000Z",
  ]);
  assert.equal(requests.filter(request => request.path === "/.zmetadata").length, 1);
  assert.ok(requests.every(request => request.cache?.includes("no-cache")));
});
test("point and full tile sampling preserve zero and missing probabilities", async () => {
  const dataset = new Dataset(url);
  await dataset.open();
  assert.equal((await dataset.point(0, 0, 25, -135)).probability, 0);
  assert.equal((await dataset.point(0, 0, 75, 180)).probability, null);
  assert.equal((await dataset.point(0, 0, -25, 0)).probability, .05);
  assert.equal((await dataset.point(0, 1, -25, 0)).probability, .1);
  const tile = await dataset.tile(0, 0, 0, 0, 0);
  assert.equal(tile.length, 256 * 256 * 4);
  assert.ok(tile.some((value, index) => index % 4 === 3 && value === 0));
  assert.ok(tile.some((value, index) => index % 4 === 3 && value === 220));
  await assert.rejects(dataset.point(100, 0, 0, 0), /out of range/);
});
test("refresh reads updated metadata and chunks, without a stale browser cache", async () => {
  const before = new Dataset(url);
  await before.open();
  assert.equal((await before.point(0, 0, -25, 0)).probability, .05);
  const key = "MODEL_FIRE/0.0.1.1";
  const original = fixture.files.get(key);
  const newValues = new Float64Array(8).fill(.25);
  fixture.files.set(key, await fixture.codec.encode(new Uint8Array(newValues.buffer)));
  try {
    const refreshed = new Dataset(url);
    await refreshed.open();
    assert.equal((await refreshed.point(0, 0, -25, 0)).probability, .25);
  } finally { fixture.files.set(key, original); }
  const previous = fixture;
  fixture = await makeFixture(33);
  try {
    const refreshed = await new Dataset(url).open();
    assert.equal(refreshed.total, 33);
    assert.equal(refreshed.runs.at(-1).index, 32);
  } finally { fixture = previous; }
});
test("absent chunks follow Zarr NaN fill; failed metadata is explicit", async () => {
  const dataset = new Dataset(url);
  await dataset.open();
  const key = "MODEL_FIRE/0.0.1.1", original = fixture.files.get(key);
  fixture.files.delete(key);
  try {
    assert.equal((await dataset.point(0, 0, -25, 0)).probability, null);
  } finally { fixture.files.set(key, original); }
  await assert.rejects(new Dataset(`${url}/missing`).open(), /HTTP 404/);
});
