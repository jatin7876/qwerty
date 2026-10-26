# Wind Forecast Dashboard

Web app for day-ahead wind power procurement: shows the wind forecast available at decision time and measures forecast accuracy, using Elexon data (FUELHH and WINDFOR) for January 2026.

*AI tools: this project was built with the assistance of Claude (Anthropic).*

## Files and directories

```
.
├── docker-compose.yml          Runs backend and frontend together
├── .gitignore
├── README.md
├── backend/
│   ├── main.py                 FastAPI app: loads Elexon data, picks the forecast available at the buying cutoff, computes accuracy, serves /api/day, /api/accuracy, /api/health
│   ├── requirements.txt        Python dependencies
│   ├── Dockerfile              Backend image
│   ├── .dockerignore
│   └── data/
│       └── elexon_cache.json   Cached Elexon data
└── frontend/
    ├── package.json            Node dependencies and scripts
    ├── package-lock.json
    ├── Dockerfile              Frontend image
    ├── .dockerignore
    ├── index.html              Vite entry page
    ├── vite.config.js          Vite config
    └── src/
        ├── main.jsx            Mounts the React app
        ├── App.jsx             Dashboard (delivery-day forecast view and accuracy view)
        └── App.css             Styling
```

## How to start the application

Requires Docker only.

```bash
git clone <repo-url>
cd <repo-folder>
docker-compose up --build
```

## Live app

- App: <https://qwerty-swart-six.vercel.app/>
