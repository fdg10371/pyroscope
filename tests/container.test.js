import assert from "node:assert/strict";
import { test } from "node:test";

const origin = process.env.CONTAINER_URL;
assert.ok(origin, "Set CONTAINER_URL to the running container's HTTP origin.");

test("container exposes a lightweight health endpoint", async () => {
  const response = await fetch(new URL("/healthz", origin));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/plain/);
  assert.equal(await response.text(), "ok\n");
});

test("container serves the viewer, assets, worker, and licenses", async () => {
  const response = await fetch(new URL("/", origin));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-cache");
  const html = await response.text();
  assert.match(html, /Pyroscope/);
  assert.match(html, /id="map"/);
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)]
    .map(match => match[1]);
  assert.ok(assets.some(asset => asset.endsWith(".js")));
  assert.ok(assets.some(asset => asset.endsWith(".css")));

  const workers = new Set();
  for (const asset of assets) {
    const result = await fetch(new URL(asset, origin));
    assert.equal(result.status, 200, asset);
    assert.match(result.headers.get("cache-control"), /immutable/);
    if (asset.endsWith(".js")) {
      assert.match(result.headers.get("content-type"), /javascript/);
      const source = await result.text();
      for (const match of source.matchAll(/["'](\/assets\/worker-[^"']+\.js)["']/g)) {
        workers.add(match[1]);
      }
    } else {
      assert.match(result.headers.get("content-type"), /text\/css/);
    }
  }
  assert.ok(workers.size > 0, "The viewer must reference its Zarr worker.");
  for (const worker of workers) {
    const result = await fetch(new URL(worker, origin));
    assert.equal(result.status, 200, worker);
    assert.match(result.headers.get("content-type"), /javascript/);
  }
  for (const name of ["Leaflet", "Work-Sans", "Zarrita", "Numcodecs"]) {
    const result = await fetch(new URL(`/licenses/${name}.txt`, origin));
    assert.equal(result.status, 200, name);
    assert.ok((await result.text()).length > 0);
  }
});

test("missing resources return 404 rather than the application HTML", async () => {
  for (const path of ["/assets/missing.js", "/missing", "/api/catalog"]) {
    const response = await fetch(new URL(path, origin));
    assert.equal(response.status, 404, path);
    assert.doesNotMatch(response.headers.get("cache-control") || "", /immutable/);
  }
});
