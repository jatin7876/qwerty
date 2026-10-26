# Wind Forecast Dashboard for Day-Ahead Buying

A web app for an energy utility's day-ahead procurement team. It shows the wind generation forecast that was available when the buying decision had to be made, and measures how accurate those forecasts have been, so the team can plan around the typical error.

- **Live app:** `<add your Vercel / Render link here>`


## AI tools used

This project was built with the assistance of Claude for design, code and documentation. I reviewed and tested the result before submitting.

## The problem in one paragraph

Day-ahead power is bought the day before delivery, so buyers rely on wind forecasts. Elexon publishes many forecasts for the same half-hour, each with a `publishTime`. The forecast that matters is the **latest one published before the buyer's cutoff** on the previous day. Accuracy figures must be measured on those same forecasts, otherwise they overstate how good the forecasts were at decision time.

## How it works

1. The backend downloads two Elexon datasets (no API key needed):
   - `FUELHH` with `fuelType = WIND`: actual generation, half-hourly, in MW.
   - `WINDFOR`: forecast generation, with the `publishTime` of each forecast.
2. For each delivery half-hour, it picks the forecast with the latest `publishTime` at or before the **cutoff** (default 09:00 UK time) on the day before delivery.
3. It joins that forecast to the actual generation and computes error as `forecast − actual`. A positive value means the forecast was too high.
4. The frontend shows this in two views.

### Views

**Forecast for a delivery day**
- Forecast at the chosen cutoff, actual generation, and a shaded band showing the typical error range (the size that 90% of past misses stay under).
- Expected wind energy for the day (GWh).
- A low-wind planning case: forecast minus the typical error, as a guide to how much extra cover to consider.
- When the forecast was last updated, and how the day actually turned out.

**Forecast accuracy**
- Average miss (MAE), RMSE, bias, and the 90th percentile absolute error across all delivery days.
- Average miss by delivery day (click a bar to open that day).
- Average miss and bias by time of day.

### Assumptions

- **Delivery days:** decisions made in January 2026 are for delivery on 2 January to 1 February 2026 (UK local dates).
- **Cutoff:** the default is 09:00 UK time on the previous day, and the user can choose 08:00 to 12:00. This is a configurable assumption. Set it to match the client's actual market gate closure.
- **Scope:** wind only. There is no demand data, so the app shows how much wind to expect and how uncertain it is, not how much to buy.
- **Revisions:** if Elexon publishes more than one actual value for a half-hour, the latest is used.

## Files and directories

```
.
├── docker-compose.yml        Runs backend and frontend together for local use
├── .gitignore
├── README.md
├── backend/
│   ├── main.py               FastAPI app: data download, cutoff alignment, accuracy statistics, API endpoints
│   ├── requirements.txt      Python dependencies
│   ├── Dockerfile            Backend image (listens on $PORT, default 8000)
│   ├── .dockerignore
│   └── data/
│       └── elexon_cache.json Cached Elexon data, created on first run (optional to commit)
└── frontend/
    ├── package.json          Node dependencies and scripts
    ├── package-lock.json
    ├── Dockerfile            Frontend image (Vite dev server on port 5173)
    ├── .dockerignore
    ├── index.html            Vite entry page
    ├── vite.config.js
    └── src/
        ├── main.jsx          Mounts the React app
        ├── App.jsx           Dashboard: day view, accuracy view, data fetching
        └── App.css           All styling
```

## How to start the application

You only need [Docker](https://www.docker.com/products/docker-desktop/) installed. There is no need to run `npm install` or `pip install`, because the containers install everything.

```bash
git clone <repo-url>
cd <repo-folder>
docker-compose up --build
```

Then open <http://localhost:5173>. The API runs on <http://localhost:8000>, and its interactive docs are at <http://localhost:8000/docs>.

The first request is slow because the backend downloads about a month of data from Elexon. After that the data is cached, so later starts are fast. Open <http://localhost:8000/api/accuracy> once to warm it up. Stop the app with `Ctrl+C`.

### Configuration

| Variable | Where | Purpose | Default |
|---|---|---|---|
| `VITE_API_URL` | frontend | Backend API base URL, including `/api` | `http://localhost:8000/api` |
| `ALLOWED_ORIGINS` | backend | Comma-separated CORS origins | `*` |
| `DATA_CACHE` | backend | Path of the data cache file | `backend/data/elexon_cache.json` |
| `PORT` | backend (Docker) | Port to listen on | `8000` |

## API

| Endpoint | Description |
|---|---|
| `GET /api/day?date=YYYY-MM-DD&cutoff=HH:MM` | Half-hourly forecast (as available at the cutoff), actual generation and publish time for one delivery day |
| `GET /api/accuracy?cutoff=HH:MM` | MAE, RMSE, bias, 90th percentile error, plus daily and time-of-day breakdowns |
| `GET /api/health` | Service status |
| `POST /api/refresh` | Re-download data from Elexon and rebuild the cache. Remove or protect this in production |


## Design notes

- **Cutoff alignment is the core of the app.** `aligned()` in `backend/main.py` is the one function that decides which forecast counts. Both the day view and the accuracy statistics use it, so the error shown matches what the buyer faced.
- **Data is fetched once.** Elexon data is loaded on the first request, kept in memory and written to a cache file, so later requests do not call Elexon.
- **Time zones.** Data is stored in UTC. Delivery days and cutoffs use UK local time (`Europe/London`).
- **Simple stack.** The backend uses FastAPI, pandas and httpx. The frontend uses React, Vite and Recharts.



## Data source

Contains BMRS data © Elexon Limited. Source: Elexon Insights API, <https://data.elexon.co.uk/bmrs/api/v1>.