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
  - `port_raw.portwatch_ports` — one row per PortWatch port (2,065)
  - `port_raw.port_calls_monthly` — one row per port per month, calls by vessel type
  - `port_raw.port_connections` — one row per directed port pair (226,904)
  - `port_mart.port_calls_by_type_month` — the monthly calls, named and located
  - `port_mart.port_connection_summary` — the port pairs, ranked, domestic flagged
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
- `GET /api/port/calls/ports` — ports with arrival data, busiest 12 months first
- `GET /api/port/calls/global` — monthly arrivals summed over every port, by
  vessel type; carries `ports_reporting` per month so the card can tell traffic
  apart from coverage
- `GET /api/port/calls/{portid}` — monthly arrivals at one port, by vessel type
- `GET /api/port/connections/global` — the busiest directed port pairs
  worldwide, capped per domestic/international scope
- `GET /api/port/connections/{portid}` — one port's origin and destination legs,
  both directions in one response so the card's toggles never refetch

The two `global` routes are declared above their `{portid}` siblings in
`main.py`, so "global" is matched as a route and never as a port id.

## Frontend

- `index.html` — auth screen, then `<div id="app">`: topbar, the section rail,
  and the two views. Every dashboard panel carries a `data-section`.
- `auth.js` — login/signup. **Do not modify.** It self-runs on load and requires
  the auth markup (`loginForm`, `signupEmail`, `.auth-tab`, etc.) to exist.
- `dashboard.js` — fetches the port endpoints, renders SVG charts
- `nav.js` — the left section rail. A section is a group of cards, not a page:
  it shows the panels whose `data-section` matches and swaps in the register
  view for the `register` section, then fills the one `.view-head` from the
  chosen rail item and fires `nav:section`. Sections are named once, in the
  rail markup in `index.html`. Loads last, so every listener is already up.
- `register.js` — the data register view. Loads itself the first time
  `nav:section` names `register`, not on login.
- `vessels.js` — the two vessel-arrival cards: arrivals by type over time, and
  the busiest routes. Both open worldwide, matching the three throughput cards
  above them; the port picker is an optional drill-down and clearing it returns
  to the world. Owns its own state and fetches;
  `dashboard.js` calls `Vessels.load()` because `Auth.onLogin` takes a single
  callback and `dashboard.js` holds it. Must load before `dashboard.js`.
- `quality.js` — the quality badge in each dashboard panel's corner, plus the
  status vocabulary (colours, glyphs, the 48-hour stale rule, time formatting)
  and the single `/api/registry/assets` fetch that `register.js` shares. Load
  it before `dashboard.js` and `register.js`, which both read `Quality`.
  "Full details" fires a `registry:open` event; `register.js` opens the asset,
  `dashboard.js` closes the country modal.
- `app.js` — dead nutrition code, no longer loaded, safe to delete
- `styles.css` — shared; contains nutrition-era rules that can be pruned

## Conventions

- Panel text is written for the person reading the dashboard, not for us: one
  or two sentences saying what the card shows and how to drill into it. Source
  mechanics — publication schedules, what a vendor does not carry, why a
  caveat exists — belong in code comments and in this file, not on the panel.
  Caveats that change how a number should be read (incomplete coverage, an
  excluded year) do belong there, stated briefly.
- Card titles and rail labels are Title Case; controls and legends stay in
  sentence case.
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
- PortWatch has no vessel size or class dimension, and no free source has one
  at port-call grain. The arrivals card counts ships, not capacity — do not
  add a size filter without a source that actually carries it.
- No free source publishes a transhipment split per port pair either. The
  origin/destination card offers domestic vs international instead.
  `is_domestic` is not a transhipment flag; do not relabel it.
- Both vessel cards are global by default. They used to open on the busiest
  port, which read as "the data only covers Singapore" against three global
  TEU cards. Do not reintroduce a per-port default.
- PortWatch republishes weekly, so the newest month in `port_calls_monthly` is
  always partial. The API names it in `partial_month` and the card drops it —
  drawn, it looks like a collapse that has not happened.
- `ingest/portwatch_load.py` is the seed load, run by hand against the backend
  container. The recurring refresh belongs in a Mage pipeline; until it exists,
  the PortWatch assets go amber 48 hours after each manual run.
EOF

## Registry API (the data register)

- `GET /api/registry/assets` — every dataset with a computed `quality` field:
  "green" (all checks passed, run within 48h), "amber" (passed but stale),
  "red" (any check failed, or no checks exist)
- `GET /api/registry/asset/{key}` — one asset in full: `fields` (name, type,
  description, unit, nullable), `checks` (name, passed, detail, checked_at),
  `upstream` and `downstream` (lineage keys)

The list endpoint carries check *counts* only, so a dashboard badge shows its
status from the one list fetch and pulls the individual checks from the asset
endpoint the first time it is opened.

The registry is populated by the Mage pipelines themselves — quality checks
run inside the exporters and upsert their latest result per (asset, check).
The register UI must never invent or soften a status: red and amber are
information, not embarrassments to hide.

## Working agreements

- **Data ingestion is Haisam's work, done in Mage.** All ingestion and
  pipeline building happens in Mage (the separate mage-pipelines repo),
  built by Haisam himself — it is his learning focus. Claude Code builds
  backend endpoints, marts, and frontend that *read* what the pipelines
  have landed. If a task appears to need new source data, stop and say
  so instead of writing a loader. (ingest/portwatch_load.py predates
  this rule; its recurring refresh is planned to move into Mage,
  built by Haisam.)

- **Git is Haisam's work.** Claude Code leaves staging, committing,
  pushing, and PRs to Haisam unless explicitly told otherwise in the
  session. Changes stay in the working tree for his review.
