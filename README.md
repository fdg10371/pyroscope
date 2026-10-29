# Pyroscope

A Python/FastAPI backend and responsive Leaflet viewer for the supplied ECMWF
`MODEL_FIRE` Zarr archive. Select a forecast run, play its forecast steps, inspect
grid-cell probabilities, and adjust layer opacity. Forecast dates come from
`forecast_time`, not assumptions about `forecast_index`.

## Run

Requires Python 3.11+ and network access to the Zarr object store.

```sh
python -m venv .venv
. .venv/bin/activate
pip install -e '.[test]'
export POF_ZARR_URL=http://cemsdata.data.compute.cci2.ecmwf.int/fire_front_radar/pof.zarr
uvicorn pof_explorer.app:app --host 127.0.0.1 --port 8000
```

Open http://127.0.0.1:8000. `POF_ZARR_URL` can also be a local Zarr directory.
The default is the supplied HTTP URL; use HTTPS if the store supports it.
The browser fetches forecast data only from the Python backend, so object-store
browser CORS support is not required.

```sh
pytest -q
```

## Data contract and serving

- Consolidated Zarr v2, Blosc/LZ4, `MODEL_FIRE` dimensions:
  `(base_time, forecast_index, lat, lon)`.
- Probabilities are **0–1**, as confirmed by the data provider; NaN means missing.
  Percentages are used only for display. Other values cause an explicit error.
- Increasing unique `base_time`; strictly monotonic latitude/longitude;
  longitude in `[-180, 180)`. Descending latitude is supported.
- `forecast_time(base_time, forecast_index)` supplies decoded UTC valid times.
- Data are opened lazily with xarray/Dask. A tile reads the rectangular source
  region needed for nearest-neighbour sampling, not the whole archive. A
  world-scale tile necessarily touches a whole global field: around 105 MB
  uncompressed for the supplied grid. No interpolation creates new probabilities.
- Web Mercator tiles show latitudes up to approximately +/-85.05 degrees;
  point queries support the poles. The original grid and point values are unchanged.
- Up to four source reads run concurrently per worker. The last 256 rendered
  PNG tiles are cached in memory per worker. Metadata reopens every five minutes;
  browser tiles have a five-minute cache lifetime. No archive is copied locally.

API: `/api/catalog`, `/api/forecast?run=...`,
`/api/tiles/{z}/{x}/{y}.png?run=...&step=...`, and
`/api/point?run=...&step=...&lat=...&lon=...`.
Run values are ISO timestamps without a timezone suffix, as returned by the catalog;
`step` is a positional index into that run's forecast times.

## Scientific interpretation

PoF estimates the daily probability of at least one MODIS active-fire detection
within an approximately 9 x 9 km grid cell, as a proxy for fire occurrence.
It is **not** ignition probability, burned area, intensity, or an emergency alert.
Low probabilities do not imply absence of risk. Skill varies by vegetation,
region, and forecast lead time. The paper reports useful skill up to 10 days
and in some cases up to 30 days; this does not establish uniform skill at all leads.

McNorton, J. R., et al. (2024), *A Global Probability-of-Fire (PoF) Forecast*,
Geophysical Research Letters, 51, e2023GL107929.
https://doi.org/10.1029/2023GL107929

## Design and external services

Follows the supplied State of Wildfires May 2025 branding guidance: Work Sans
(Arial fallback), teal interface accents, and numeric probability colours drawn
from the orange/red palettes, with hot pink at the upper endpoint. The scale is
piecewise linear with explicit anchors at 0, 0.1, 0.5, 1, 2, 5, 10, 20, and
100 percent, to make low probabilities visible. It is not a categorical alert
classification. Missing pixels are transparent; valid zero is pale cream.

No unofficial project logo is recreated. Supply approved logo assets before
adding an official project masthead. The supplied PDFs are not published.
The implementation is original, inspired by Weather Explorer's map/playback UX.

Leaflet 1.9.4, Work Sans Latin fonts, and a Natural Earth 1:110m country basemap
are bundled and self-hosted. No third-party font or map service is contacted
by the viewer. This lightweight basemap is intended for global context, not
street-level navigation. Leaflet's BSD-2-Clause license and the font's OFL license
are included beside their assets. Geography was converted from world-atlas 2.0.2
using topojson-client 3.1.0; Natural Earth source data are public domain.

## Deployment

Run Uvicorn behind an HTTPS reverse proxy. Keep the Zarr URL in server
configuration; clients cannot choose arbitrary data sources. This initial
version has no user accounts, shared disk cache, or distributed rate limiting.
For public production use, add request limits at the reverse proxy and size
worker count/memory against real object-store performance. Each worker maintains
its own cache and concurrency limit. Cold global views can be expensive; a
precomputed low-zoom pyramid is the recommended next optimization at scale.

The remote archive must be validated from a host that can resolve its hostname.
Synthetic fixtures exercise the API independently; they are never served as
real forecasts.
