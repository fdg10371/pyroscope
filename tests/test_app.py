import importlib
import io

import numpy as np
import pytest
import xarray as xr
from fastapi.testclient import TestClient
from PIL import Image

backend = importlib.import_module("pof_explorer.app")


@pytest.fixture
def client(tmp_path, monkeypatch):
    data = np.full((2, 2, 4, 8), .05)
    data[:, :, 0, 0] = np.nan
    data[:, :, 1, 1] = 0
    ds = xr.Dataset(
        {
            "MODEL_FIRE": (("base_time", "forecast_index", "lat", "lon"), data),
            "forecast_time": (("base_time", "forecast_index"), np.array([
                ["2026-10-27", "2026-10-29"], ["2026-10-28", "2026-10-30"]
            ], dtype="datetime64[ns]")),
        },
        coords={
            "base_time": np.array(["2026-10-27", "2026-10-28"], dtype="datetime64[ns]"),
            "forecast_index": [0, 1], "lat": [75., 25., -25., -75.],
            "lon": np.arange(-180., 180., 45.),
        },
    )
    source = tmp_path / "test.zarr"
    ds.to_zarr(source, consolidated=True)
    monkeypatch.setattr(backend, "SOURCE", str(source))
    monkeypatch.setattr(backend, "_dataset", None)
    backend.tile_bytes.cache_clear()
    with TestClient(backend.app) as test_client:
        yield test_client
    if backend._dataset is not None:
        backend._dataset.close()


RUN = "2026-10-28T00:00:00"


def test_catalog_and_actual_valid_times(client):
    assert client.get("/").status_code == 200
    assert client.get("/static/app.js").status_code == 200
    catalog = client.get("/api/catalog").json()
    assert catalog["steps"] == 2
    assert catalog["runs"][-1] == RUN
    assert client.get("/api/forecast", params={"run": RUN}).json()["times"] == [
        "2026-10-28T00:00:00", "2026-10-30T00:00:00"
    ]


def test_point_probability_zero_missing_and_wrap(client):
    params = {"run": RUN, "step": 0, "lat": -25, "lon": 0}
    assert client.get("/api/point", params=params).json()["probability"] == .05
    params.update(lat=25, lon=-135)
    assert client.get("/api/point", params=params).json()["probability"] == 0
    params.update(lat=75, lon=180)
    assert client.get("/api/point", params=params).json()["probability"] is None


def test_tile_and_transparency(client):
    response = client.get("/api/tiles/0/0/0.png", params={"run": RUN})
    assert response.status_code == 200
    pixels = np.array(Image.open(io.BytesIO(response.content)))
    assert pixels.shape == (256, 256, 4)
    assert (pixels[..., 3] == 0).any()
    assert (pixels[..., 3] == 220).any()
    rgba = backend.colorize(np.array([[0, np.nan, .05, 1]]))
    assert rgba[0, 0].tolist() == [255, 245, 218, 220]
    assert rgba[0, 1, 3] == 0
    assert rgba[0, 2, :3].tolist() == [228, 131, 119]
    assert rgba[0, 3, :3].tolist() == [115, 9, 67]


def test_bad_requests(client):
    assert client.get("/api/forecast", params={"run": "missing"}).status_code == 404
    assert client.get("/api/tiles/0/1/0.png", params={"run": RUN}).status_code == 400
    assert client.get("/api/tiles/11/0/0.png", params={"run": RUN}).status_code == 400
    assert client.get("/api/tiles/0/0/0.png", params={"run": RUN, "step": 2}).status_code == 404
    assert client.get("/api/point", params={"run": RUN, "lat": 91, "lon": 0}).status_code == 422


def test_invalid_probabilities():
    for bad in [-.1, 1.01, np.inf, -np.inf]:
        with pytest.raises(ValueError):
            backend.colorize(np.array([[bad]]))


def test_nearest_both_coordinate_directions():
    targets = np.array([-100, -20, 20, 100])
    ascending = np.array([-75, -25, 25, 75])
    assert backend.nearest(ascending, targets).tolist() == [0, 1, 2, 3]
    assert backend.nearest(ascending[::-1], targets).tolist() == [3, 2, 1, 0]


def test_unavailable_store_returns_explicit_error(client, monkeypatch):
    monkeypatch.setattr(backend, "_dataset", None)
    monkeypatch.setattr(backend, "SOURCE", "/does-not-exist/pof.zarr")
    response = client.get("/api/catalog")
    assert response.status_code == 503
    assert "unavailable" in response.json()["detail"]
