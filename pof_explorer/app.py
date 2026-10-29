import io
import logging
import math
import os
import threading
import time
from functools import lru_cache
from pathlib import Path

import numpy as np
import xarray as xr
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image

LOGGER = logging.getLogger(__name__)
SOURCE = os.environ.get(
    "POF_ZARR_URL",
    "http://cemsdata.data.compute.cci2.ecmwf.int/fire_front_radar/pof.zarr",
)
STATIC = Path(__file__).parent / "static"
STOPS = np.array([0, .001, .005, .01, .02, .05, .1, .2, 1])
COLORS = np.array([
    [255, 245, 218], [252, 217, 184], [250, 176, 115],
    [237, 185, 118], [226, 114, 38], [228, 131, 119],
    [219, 110, 99], [199, 64, 61], [115, 9, 67],
])
app = FastAPI(title="Pyroscope")
app.mount("/static", StaticFiles(directory=STATIC), name="static")
_dataset = None
_opened_at = 0.0
_lock = threading.Lock()
_reads = threading.BoundedSemaphore(4)


def dataset():
    global _dataset, _opened_at
    with _lock:
        if _dataset is None or time.monotonic() - _opened_at > 300:
            candidate = xr.open_zarr(SOURCE, consolidated=True)
            try:
                if candidate.MODEL_FIRE.dims != (
                    "base_time", "forecast_index", "lat", "lon"
                ):
                    raise ValueError("Unexpected MODEL_FIRE dimensions")
                if candidate.forecast_time.dims != ("base_time", "forecast_index"):
                    raise ValueError("Unexpected forecast_time dimensions")
                for name in ("lat", "lon"):
                    values = candidate[name].values
                    differences = np.diff(values)
                    if len(values) < 2 or not np.isfinite(values).all() or not (
                        (differences > 0).all() or (differences < 0).all()
                    ):
                        raise ValueError(f"{name} must be finite and strictly monotonic")
                if not (
                    (candidate.lon.values >= -180).all()
                    and (candidate.lon.values < 180).all()
                    and (np.abs(candidate.lat.values) <= 90).all()
                ):
                    raise ValueError("Expected longitude in [-180, 180) and latitude in [-90, 90]")
                runs = candidate.base_time.values
                if not len(runs) or np.isnat(runs).any() or not (np.diff(runs) > np.timedelta64(0, "ns")).all():
                    raise ValueError("base_time must contain increasing, unique dates")
            except Exception:
                candidate.close()
                raise
            # Requests already using the previous dataset keep their own reference.
            _dataset = candidate
            _opened_at = time.monotonic()
            tile_bytes.cache_clear()
        return _dataset


def backend_error(exc):
    LOGGER.exception("PoF data request failed")
    return HTTPException(503, "Forecast data unavailable. Check backend logs and data-store access.")


def frame(ds, run, step):
    matches = np.flatnonzero(
        np.datetime_as_string(ds.base_time.values, unit="s") == run
    )
    if not len(matches):
        raise HTTPException(404, "Forecast run not found")
    if not 0 <= step < ds.sizes["forecast_index"]:
        raise HTTPException(404, "Forecast step not found")
    return ds.MODEL_FIRE.isel(base_time=int(matches[0]), forecast_index=step)


def validate_values(values):
    finite = values[np.isfinite(values)]
    if np.isinf(values).any() or (finite < 0).any() or (finite > 1).any():
        raise ValueError("MODEL_FIRE values must be probabilities in [0, 1], or NaN")


def nearest(coordinates, targets):
    ascending = coordinates[0] < coordinates[-1]
    ordered = coordinates if ascending else coordinates[::-1]
    right = np.searchsorted(ordered, targets).clip(1, len(ordered) - 1)
    indices = np.where(
        np.abs(targets - ordered[right - 1]) <= np.abs(targets - ordered[right]),
        right - 1, right,
    )
    return indices if ascending else len(ordered) - 1 - indices


def colorize(values):
    validate_values(values)
    rgba = np.zeros((*values.shape, 4), dtype=np.uint8)
    present = np.isfinite(values)
    for channel in range(3):
        rgba[..., channel][present] = np.interp(
            values[present], STOPS, COLORS[:, channel]
        ).astype(np.uint8)
    rgba[..., 3][present] = 220
    return rgba


@lru_cache(maxsize=256)
def tile_bytes(ds_id, run, step, z, x, y):
    ds = dataset()
    field = frame(ds, run, step)
    n = 2 ** z
    longitude = ((x + (np.arange(256) + .5) / 256) / n) * 360 - 180
    mercator = math.pi * (1 - 2 * (y + (np.arange(256) + .5) / 256) / n)
    latitude = np.degrees(np.arctan(np.sinh(mercator)))
    rows = nearest(ds.lat.values, latitude)
    cols = nearest(ds.lon.values, longitude)
    r0, r1, c0, c1 = int(rows.min()), int(rows.max()), int(cols.min()), int(cols.max())
    with _reads:
        block = field.isel(lat=slice(r0, r1 + 1), lon=slice(c0, c1 + 1)).values
    values = block[np.ix_(rows - r0, cols - c0)]
    buffer = io.BytesIO()
    Image.fromarray(colorize(values)).save(buffer, format="PNG")
    return buffer.getvalue()


@app.get("/")
def home():
    return FileResponse(STATIC / "index.html")


@app.get("/api/catalog")
def catalog():
    try:
        ds = dataset()
        return {
            "runs": np.datetime_as_string(ds.base_time.values, unit="s").tolist(),
            "steps": ds.sizes["forecast_index"],
            "variable": "MODEL_FIRE",
            "units": "probability",
        }
    except Exception as exc:
        raise backend_error(exc) from exc


@app.get("/api/forecast")
def forecast(run: str):
    try:
        ds = dataset()
        frame(ds, run, 0)
        index = int(np.flatnonzero(np.datetime_as_string(ds.base_time.values, unit="s") == run)[0])
        times = ds.forecast_time.isel(base_time=index).values
        if np.isnat(times).any():
            raise ValueError("Forecast contains missing valid times")
        return {"run": run, "times": np.datetime_as_string(times, unit="s").tolist()}
    except HTTPException:
        raise
    except Exception as exc:
        raise backend_error(exc) from exc


@app.get("/api/tiles/{z}/{x}/{y}.png")
def tile(z: int, x: int, y: int, run: str, step: int = 0):
    if not 0 <= z <= 10 or not 0 <= x < 2 ** z or not 0 <= y < 2 ** z:
        raise HTTPException(400, "Invalid tile coordinates or zoom (0-10)")
    try:
        ds = dataset()
        content = tile_bytes(id(ds), run, step, z, x, y)
        return Response(content, media_type="image/png", headers={"Cache-Control": "public, max-age=300"})
    except HTTPException:
        raise
    except Exception as exc:
        raise backend_error(exc) from exc


@app.get("/api/point")
def point(
    run: str, step: int = 0,
    lat: float = Query(ge=-90, le=90),
    lon: float = Query(ge=-180, le=180),
):
    try:
        ds = dataset()
        field = frame(ds, run, step)
        row = int(nearest(ds.lat.values, np.array([lat]))[0])
        col = int(nearest(ds.lon.values, np.array([((lon + 180) % 360) - 180]))[0])
        with _reads:
            value = float(field.isel(lat=row, lon=col).values)
        validate_values(np.array([value]))
        return {
            "probability": value if np.isfinite(value) else None,
            "lat": float(ds.lat.values[row]), "lon": float(ds.lon.values[col]),
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise backend_error(exc) from exc
