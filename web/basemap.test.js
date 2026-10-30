import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { geoMercator, geoPath } from "d3-geo";

test("dateline-crossing Russian and Fijian boundaries do not span the world", () => {
  const world = JSON.parse(fs.readFileSync(
    new URL("../pof_explorer/static/countries.geojson", import.meta.url),
    "utf8",
  ));
  const project = geoPath(geoMercator().scale(256 / (2 * Math.PI)).translate([128, 128]));

  for (const country of ["Russia", "Fiji"]) {
    const feature = world.features.find(item => item.properties.name === country);
    assert.ok(feature, `${country} feature exists`);
    const commands = [...project(feature).matchAll(/([ML])(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)];
    let previous;
    for (const [, command, x, y] of commands) {
      const point = [Number(x), Number(y)];
      if (command === "M") {
        previous = point;
        continue;
      }
      assert.ok(Math.hypot(point[0] - previous[0], point[1] - previous[1]) < 20,
        `${country} has no map-wide segment across the dateline`);
      previous = point;
    }
  }
});
