
from __future__ import annotations

import asyncio
import json
import os
import re
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path

import httpx
import pandas as pd
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

BASE_URL = "https://data.elexon.co.uk/bmrs/api/v1"
TZ = "Europe/London"

# Decisions made in January 2026 are for delivery days 2 Jan to 1 Feb 2026 (UK local dates).
DATE_MIN, DATE_MAX = "2026-01-02", "2026-02-01"
DEFAULT_CUTOFF = "09:00"

# Wide enough to cover every cutoff (up to 31 Jan 2026) and every delivery half-hour.
FORECAST_PUBLISH_FROM = datetime(2025, 12, 28, tzinfo=timezone.utc)
FORECAST_PUBLISH_TO = datetime(2026, 2, 1, tzinfo=timezone.utc)
ACTUAL_FROM = datetime(2026, 1, 1, tzinfo=timezone.utc)
ACTUAL_TO = datetime(2026, 2, 3, tzinfo=timezone.utc)

CACHE_FILE = Path(os.getenv("DATA_CACHE", Path(__file__).parent / "data" / "elexon_cache.json"))
CUTOFF_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

app = FastAPI(title="Wind forecast API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("ALLOWED_ORIGINS", "*").split(","),  # set to your Vercel URL in production
    allow_methods=["GET"],
    allow_headers=["*"],
)

_data: dict[str, pd.DataFrame] = {}
_lock = asyncio.Lock()


# --------------------------------------------------------------------------- #
# Loading data from Elexon (once), with an optional on-disk cache
# --------------------------------------------------------------------------- #
def _stamp(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%MZ")


async def _get_rows(client: httpx.AsyncClient, dataset: str, params: dict) -> list[dict]:
    """GET one /stream window, retrying on rate limits and server errors."""
    url = f"{BASE_URL}/datasets/{dataset}/stream"
    for attempt in range(4):
        r = await client.get(url, params=params)
        if r.status_code in (429, 500, 502, 503, 504):
            await asyncio.sleep(1.5 * (attempt + 1))
            continue
        r.raise_for_status()
        body = r.json()
        return body.get("data", []) if isinstance(body, dict) else body
    r.raise_for_status()
    return []


async def _download_windows(dataset: str, start: datetime, end: datetime, extra: dict) -> list[dict]:
    """Fetch a dataset in 1-day publish-time windows (keeps each response small) in parallel."""
    sem = asyncio.Semaphore(5)
    windows, t = [], start
    while t < end:
        windows.append((t, min(t + timedelta(days=1), end)))
        t += timedelta(days=1)

    async with httpx.AsyncClient(timeout=60) as client:
        async def one(a: datetime, b: datetime) -> list[dict]:
            async with sem:
                params = {"publishDateTimeFrom": _stamp(a), "publishDateTimeTo": _stamp(b), **extra}
                return await _get_rows(client, dataset, params)

        chunks = await asyncio.gather(*(one(a, b) for a, b in windows))
    return [row for chunk in chunks for row in chunk]


async def _download() -> dict[str, list[dict]]:
    actual, forecast = await asyncio.gather(
        _download_windows("FUELHH", ACTUAL_FROM, ACTUAL_TO, {"fuelType": "WIND"}),
        _download_windows("WINDFOR", FORECAST_PUBLISH_FROM, FORECAST_PUBLISH_TO, {}),
    )
    return {"fuelhh": actual, "windfor": forecast}


def _read_cache() -> dict[str, list[dict]] | None:
    try:
        return json.loads(CACHE_FILE.read_text())
    except (OSError, ValueError):
        return None


_KEEP = ("startTime", "publishTime", "generation", "fuelType")


def _write_cache(raw: dict[str, list[dict]]) -> None:
    """Save only the fields we use, so the file stays small (fast cold starts on serverless)."""
    slim = {k: [{f: r[f] for f in _KEEP if f in r} for r in rows] for k, rows in raw.items()}
    try:  # read-only filesystems (e.g. Vercel) simply skip caching
        CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        CACHE_FILE.write_text(json.dumps(slim, separators=(",", ":")))
    except OSError:
        pass


def _build(raw: dict[str, list[dict]]) -> dict[str, pd.DataFrame]:
    """Turn raw API rows into two clean frames keyed by UTC startTime."""
    a = pd.DataFrame(raw["fuelhh"])
    if "fuelType" in a:
        a = a[a["fuelType"] == "WIND"]
    a = a.assign(startTime=pd.to_datetime(a["startTime"], utc=True), publishTime=pd.to_datetime(a["publishTime"], utc=True))
    # keep the latest published value per half-hour (Elexon can revise)
    a = a.sort_values("publishTime").drop_duplicates("startTime", keep="last")
    a = a[["startTime", "generation"]].rename(columns={"generation": "actual"})

    f = pd.DataFrame(raw["windfor"])
    f = f.assign(startTime=pd.to_datetime(f["startTime"], utc=True), publishTime=pd.to_datetime(f["publishTime"], utc=True))
    f = f[["startTime", "publishTime", "generation"]].rename(columns={"generation": "forecast"})
    f = f.drop_duplicates(["startTime", "publishTime"], keep="last")
    return {"actual": a.reset_index(drop=True), "forecast": f.reset_index(drop=True)}


async def get_data() -> dict[str, pd.DataFrame]:
    if _data:
        return _data
    async with _lock:
        if not _data:
            raw = _read_cache()
            if raw is None:
                try:
                    raw = await _download()
                except httpx.HTTPError as exc:
                    raise HTTPException(502, f"Could not load data from Elexon: {exc}") from exc
                _write_cache(raw)
            _data.update(_build(raw))
            aligned.cache_clear()
    return _data


# --------------------------------------------------------------------------- #
# Core logic: pick the forecast that was available at the buying cutoff
# --------------------------------------------------------------------------- #
@lru_cache(maxsize=16)
def aligned(cutoff: str) -> pd.DataFrame:
    """One row per delivery half-hour: the latest forecast published by `cutoff` (UK time)
    on the day before delivery, joined to the actual generation.

    Columns: startTime, publishTime, forecast, actual, date (UK local), hour (UK local).
    """
    h, m = (int(x) for x in cutoff.split(":"))
    f = _data["forecast"].copy()

    local = f["startTime"].dt.tz_convert(TZ)
    delivery_day = local.dt.tz_localize(None).dt.normalize()  # UK calendar date of each half-hour
    cut_local = delivery_day - pd.Timedelta(days=1) + pd.Timedelta(hours=h, minutes=m)
    cut = cut_local.dt.tz_localize(TZ, ambiguous="NaT", nonexistent="shift_forward").dt.tz_convert("UTC")

    f["date"] = delivery_day.dt.strftime("%Y-%m-%d")
    f["hour"] = local.dt.hour
    f = f[(f["publishTime"] <= cut) & f["date"].between(DATE_MIN, DATE_MAX)]

    f = f.sort_values("publishTime").groupby("startTime", as_index=False).tail(1)
    f = f.merge(_data["actual"], on="startTime", how="left")
    return f.sort_values("startTime").reset_index(drop=True)


def _check_cutoff(cutoff: str) -> str:
    if not CUTOFF_RE.match(cutoff):
        raise HTTPException(422, "cutoff must be HH:MM in 24-hour UK time, e.g. 09:00")
    return cutoff


def _num(x) -> float | None:
    return None if pd.isna(x) else float(x)


# --------------------------------------------------------------------------- #
# Endpoints
# --------------------------------------------------------------------------- #
@app.get("/api/health")
async def health():
    return {"status": "ok", "loaded": bool(_data)}


@app.get("/api/day")
async def day(date: str = Query(..., description="Delivery day, YYYY-MM-DD"), cutoff: str = DEFAULT_CUTOFF):
    """Forecast available at the cutoff on the previous day, with actuals, for one delivery day."""
    _check_cutoff(cutoff)
    if not DATE_RE.match(date) or not DATE_MIN <= date <= DATE_MAX:
        raise HTTPException(422, f"date must be between {DATE_MIN} and {DATE_MAX}")
    await get_data()

    d = aligned(cutoff)
    d = d[d["date"] == date]
    points = [
        {
            "startTime": r.startTime.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "publishTime": r.publishTime.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "forecast": _num(r.forecast),
            "actual": _num(r.actual),
        }
        for r in d.itertuples()
    ]
    return {"date": date, "cutoff": cutoff, "points": points}


@app.get("/api/accuracy")
async def accuracy(cutoff: str = DEFAULT_CUTOFF):
    """Forecast error statistics over all delivery days, using cutoff-aligned forecasts.

    Error = forecast - actual, so a positive bias means forecasts ran high.
    """
    _check_cutoff(cutoff)
    await get_data()

    e = aligned(cutoff).dropna(subset=["actual"]).copy()
    if e.empty:
        raise HTTPException(404, "No overlapping forecast and actual data for this cutoff")
    e["error"] = e["forecast"] - e["actual"]
    e["abs_error"] = e["error"].abs()

    summary = {
        "mae": float(e["abs_error"].mean()),
        "rmse": float((e["error"] ** 2).mean() ** 0.5),
        "bias": float(e["error"].mean()),
        "p90AbsError": float(e["abs_error"].quantile(0.9)),
        "meanActual": float(e["actual"].mean()),
        "n": int(len(e)),
        "days": int(e["date"].nunique()),
    }
    daily = (
        e.groupby("date").agg(mae=("abs_error", "mean"), bias=("error", "mean")).round(1).reset_index().to_dict("records")
    )
    by_hour = (
        e.groupby("hour").agg(mae=("abs_error", "mean"), bias=("error", "mean")).round(1).reset_index().to_dict("records")
    )
    return {"cutoff": cutoff, "summary": summary, "daily": daily, "byHour": by_hour}