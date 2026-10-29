# Pyroscope

A branded Probability of Fire map that can run entirely on **GitHub Pages**.
The browser reads Zarr v2 directly, decompresses Blosc/LZ4 chunks in a Web
Worker, and draws probability tiles. No Python backend, cloud VM, copied archive,
or scheduled forecast conversion is required.

## Publish on GitHub Pages

1. Merge the direct-Zarr implementation pull request into `main`.
2. In **Settings > Pages > Build and deployment**, set **Source** to
   **GitHub Actions**. Pages for a private repository requires an eligible
   GitHub plan. Do not change repository visibility unless you intend to.
3. Optionally set the repository **Actions variable** `POF_ZARR_URL` to your
   public **HTTPS** Zarr directory URL. Do not put credentials in this variable;
   the URL is included in the public browser bundle.
4. In **Actions > Publish Pyroscope to GitHub Pages**, run the workflow, or push
   a commit to `main`. It builds the frontend and publishes `dist`.
5. After successful deployment, visit `https://fdg10371.github.io/pyroscope/`.
   The workflow obtains the base path from Pages configuration, so assets and
   worker modules also work beneath the project path or a configured domain.

**The live ECMWF store has not been verified from the development environment:
its hostname could not be resolved.** The default HTTPS URL is a candidate,
not a confirmed working endpoint:

```
https://cemsdata.data.compute.cci2.ecmwf.int/fire_front_radar/pof.zarr
```

The original URL supplied was HTTP. GitHub Pages is HTTPS, so that HTTP URL
cannot be used directly from Pages. The store must support HTTPS with a valid
certificate and CORS for `https://fdg10371.github.io` (or `*` for public data).
These headers must be present on **metadata and chunk responses**, including
404s that indicate an absent chunk. No cookies or authentication are sent.
If the store does not support these requirements, its operator must enable
them, or you must use a proxy/backend or a different HTTPS object store.
GitHub Pages settings cannot fix an HTTP-only or non-CORS data source.

Check from a machine that can reach the store:

```sh
curl -i -H 'Origin: https://fdg10371.github.io' \
  'https://cemsdata.data.compute.cci2.ecmwf.int/fire_front_radar/pof.zarr/.zmetadata'
```

Expect HTTP 200, Zarr JSON, and `Access-Control-Allow-Origin` matching the Pages
origin or `*`. Repeat for a real chunk such as `MODEL_FIRE/0.0.0.0`, then
confirm in the browser. Curl alone does not enforce CORS. Allow `GET`; if your
hosting setup triggers a browser preflight, handle `OPTIONS` too.

## Updates and refresh

- Every page refresh or **Connect / refresh data** fetches fresh `.zmetadata`,
  coordinates, and run dates, and clears previously decoded chunks.
- All remote fetches use `cache: "no-store"`: the browser's HTTP cache is bypassed.
  An upstream CDN still needs correct cache/invalidation settings.
- The newest 30 run coordinates are read first; **Load older runs** pages backward
  through the entire archive in batches of 30. Run dates are read, never guessed.
- Valid times come from `forecast_time`, not assumed daily offsets.
- During one connection, decoded chunks are cached in memory up to 128 MiB.
  Refresh to see changes to existing chunks or discover appended runs.
- The publisher must finish writing chunks **before** publishing updated
  consolidated metadata. An in-place archive update is not an atomic snapshot;
  use immutable/versioned stores if consistency during updates is essential.

The viewer reports connection failures, invalid probabilities, unsupported
metadata, and decoding errors explicitly. There is no sample-data fallback.
Per the Zarr specification, a missing chunk (HTTP 404) uses its declared fill
value; NaN is displayed as no data.

## Local frontend development

Requires Node.js 22+.

```sh
npm ci
npm test
npm run dev
```

Open the address printed by Vite. Paste a compatible source into the Zarr URL
field. HTTP data sources are permitted only when the viewer itself is served
over HTTP for local development.

```sh
PAGES_BASE_PATH=/pyroscope/ npm run build
PAGES_BASE_PATH=/pyroscope/ npm run preview
```

`VITE_ZARR_URL` sets the build's default source. Leave it unset to use the
candidate ECMWF HTTPS endpoint. Forecasts are not downloaded during the build.

## Performance and data contract

The supplied archive is about 1 TB, with:

```
MODEL_FIRE(base_time, forecast_index, lat, lon)
chunks = (1, 1, 320, 642)
shape = (1030, 10, 2560, 5136)  # may grow
```

Probabilities are **0–1**, as confirmed by the data provider; the display uses
percentages. Latitude may descend, longitude must be monotonic in `[-180, 180)`,
and coordinate values must be finite. Time coordinates use Gregorian CF units
such as `days since 2024-01-01 00:00:00`. The direct reader currently supports
consolidated Zarr v2 and C-order float arrays chunked by one run and one step.

Only chunks needed for visible tiles or a selected point are fetched. A global
view can still touch all 64 spatial chunks, approximately **105 MB uncompressed
per forecast step**, not the whole archive. Compressed transfer depends on
the data. Six network reads and four worker jobs are allowed concurrently;
identical pending chunk requests are shared. The UI remains on the main thread.
Mobile memory and bandwidth may constrain global playback. Playback waits for
visible tiles, and source values are nearest-neighbour sampled, not smoothed.

Web Mercator displays approximately +/-85.05 degrees. Grid-cell probabilities
are not changed by reprojection. Dates and units remain visible during playback.

## Scientific interpretation and design

PoF estimates the daily probability of at least one MODIS active-fire detection
within an approximately 9 x 9 km grid cell, as a proxy for fire occurrence.
It is **not** ignition probability, burned area, intensity, or an emergency alert.
Low probabilities do not imply absence of risk. Skill varies by vegetation,
region, and forecast lead time. Useful skill up to 10 days, and in some regions
up to 30 days, does not establish uniform skill at all leads.

McNorton, J. R., et al. (2024), *A Global Probability-of-Fire (PoF) Forecast*,
Geophysical Research Letters, 51, e2023GL107929.
https://doi.org/10.1029/2023GL107929

Uses the supplied State of Wildfires May 2025 guidance: Work Sans, teal UI
accents, and orange/red probability colours with hot pink at the upper endpoint.
Piecewise-linear colour anchors: 0, 0.1, 0.5, 1, 2, 5, 10, 20, and 100 percent.
This is a numeric colour scale, **not an alert classification**. Transparent
means no data; zero is pale cream. No official logo is recreated; approved
logo assets are still needed. The supplied PDFs are not published.

Leaflet, Work Sans Latin fonts, and a Natural Earth 1:110m basemap are bundled
and self-hosted. There are no third-party map/font requests. The browser does
contact the selected Zarr host, which sees the visitor's IP and requests.
Library and font licenses are included in `dist/licenses`. Natural Earth
geography is public domain, converted from world-atlas 2.0.2.

## Optional original Python backend

The original backend and its frontend are retained as a separate local option;
they are **not deployed to Pages** and are not required by the direct reader.

```sh
python -m venv .venv
. .venv/bin/activate
pip install -e '.[test]'
export POF_ZARR_URL=http://cemsdata.data.compute.cci2.ecmwf.int/fire_front_radar/pof.zarr
uvicorn pof_explorer.app:app --host 127.0.0.1 --port 8000
pytest -q
```

Open http://127.0.0.1:8000. This variant serves `/api/catalog`, `/api/forecast`,
`/api/tiles`, and `/api/point` with server-side data reads and a five-minute
metadata refresh. A local Zarr directory is also supported by that backend.
