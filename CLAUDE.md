<< 'EOF'
# Port Traffic Dashboard

Repurposed from a nutrition-tracking app. Container names, the Docker network,
and the database user still say "nutritrack" — that is deliberate, do not rename.

## Stack

Four containers, all on the `nutrition-tracker_default` Docker network:

| Container | Contents |
|---|---|
| `nutrition-tracker-frontend-1` | nginx, static files, proxies `/api/` to backend |
| `nutrition-tracker-backend-1` | FastAPI (`backend/main.py`) |
| `nutrition-tracker-db-1` | PostgreSQL 16 |
| `mage` | Mage AI, pipelines live in the separate `mage-pipelines` repo |

## Databases

Two databases on the same PostgreSQL server:

- `nutritrack` — the `users` table only (auth)
- `portdata` — everything else:
  - `port_raw.country_port_traffic` — one row per country per year (2,232)
  - `port_raw.country_dim` — one row per entity (295), `is_aggregate` flags non-countries
  - `port_mart.country_traffic_summary` — one row per country (168)
  - `port_mart.traffic_by_region_year` — one row per region per year (121)
  - `registry.assets`, `registry.fields`, `registry.edges` — self-maintained metadata

`backend/main.py` has two connections: `get_connection()` for auth, and
`get_port_connection()` for `portdata`. Port endpoints must use the second one
and must be read-only — `PORT_DB_USER` may later point at a SELECT-only role.

## API

- `GET /api/health`
- `POST /api/register`, `POST /api/login` — existing auth, do not change
- `GET /api/port/countries` — ranked country summary
- `GET /api/port/regions` — regional totals by year
- `GET /api/port/country/{iso3}` — full time series for one country

## Frontend

- `index.html` — auth screen (lines 1-47) then `<div id="app">` with the dashboard
- `auth.js` — login/signup. **Do not modify.** It self-runs on load and requires
  the auth markup (`loginForm`, `signupEmail`, `.auth-tab`, etc.) to exist.
- `dashboard.js` — fetches the port endpoints, renders SVG charts
- `app.js` — dead nutrition code, no longer loaded, safe to delete
- `styles.css` — shared; contains nutrition-era rules that can be pruned

## Conventions

- Any value from a URL or user input goes into SQL as a `%s` parameter, never
  an f-string.
- Charts are hand-written SVG. No charting libraries.
- Editing backend or frontend files does NOT affect the running containers.
  Rebuild: `docker compose up -d --build backend` (or `frontend`).
- Never commit `.env` or credentials. `*.bak` is gitignored.
- Work happens on a branch, then PR, then merge. Never commit to `main`.

## Known issues

- SVG text has no `fill`, so labels render black on a dark background
- `PAD_LEFT` of 110 in dashboard.js truncates long country names
- World Bank data: coverage drops sharply after 2019, so cross-country
  comparisons use 2019. Coordinates in `country_dim` are capital cities,
  not ports — do not present them as port locations.
EOF
