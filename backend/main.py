"""NutriTrack backend — minimal FastAPI auth service.

Accounts live in PostgreSQL; passwords are stored as bcrypt hashes and never
in plaintext. Connection settings come from the environment (DB_HOST, DB_NAME,
DB_USER, DB_PASSWORD) so no credentials are committed to the repo.
"""

import os
from contextlib import asynccontextmanager, contextmanager

import bcrypt
import psycopg
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, status
from pydantic import BaseModel, EmailStr, Field

load_dotenv()

DB_HOST = os.getenv("DB_HOST", "localhost")
DB_NAME = os.getenv("DB_NAME", "nutritrack")
DB_USER = os.getenv("DB_USER", "nutritrack")
DB_PASSWORD = os.getenv("DB_PASSWORD", "")
DB_PORT = os.getenv("DB_PORT", "5432")
PORT_DB_NAME = os.getenv("PORT_DB_NAME", "portdata")
PORT_DB_USER = os.getenv("PORT_DB_USER", DB_USER)
PORT_DB_PASSWORD = os.getenv("PORT_DB_PASSWORD", DB_PASSWORD)

# bcrypt only consults the first 72 bytes of the password; reject anything
# longer rather than silently truncating it.
MAX_PASSWORD_BYTES = 72

CREATE_USERS_TABLE = """
CREATE TABLE IF NOT EXISTS users (
    id            BIGSERIAL PRIMARY KEY,
    email         TEXT        NOT NULL UNIQUE,
    password_hash TEXT        NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
"""


def conninfo() -> str:
    return psycopg.conninfo.make_conninfo(
        host=DB_HOST,
        port=DB_PORT,
        dbname=DB_NAME,
        user=DB_USER,
        password=DB_PASSWORD,
    )


@contextmanager
def get_connection():
    with psycopg.connect(conninfo()) as conn:
        yield conn
def port_conninfo() -> str:
    return psycopg.conninfo.make_conninfo(
        host=DB_HOST,
        port=DB_PORT,
        dbname=PORT_DB_NAME,
        user=PORT_DB_USER,
        password=PORT_DB_PASSWORD,
    )


@contextmanager
def get_port_connection():
    with psycopg.connect(port_conninfo()) as conn:
        yield conn


@asynccontextmanager
async def lifespan(app: FastAPI):
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(CREATE_USERS_TABLE)
        conn.commit()
    yield


app = FastAPI(title="NutriTrack API", lifespan=lifespan)


class Credentials(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8)


def normalise_email(email: str) -> str:
    return email.strip().lower()


def password_bytes(password: str) -> bytes:
    encoded = password.encode("utf-8")
    if len(encoded) > MAX_PASSWORD_BYTES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Password must be at most {MAX_PASSWORD_BYTES} bytes.",
        )
    return encoded


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.post("/api/register", status_code=status.HTTP_201_CREATED)
def register(credentials: Credentials):
    email = normalise_email(credentials.email)
    password_hash = bcrypt.hashpw(
        password_bytes(credentials.password), bcrypt.gensalt()
    ).decode("utf-8")

    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO users (email, password_hash)
                VALUES (%s, %s)
                ON CONFLICT (email) DO NOTHING
                RETURNING id, email, created_at
                """,
                (email, password_hash),
            )
            row = cur.fetchone()
        conn.commit()

    if row is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An account with that email already exists.",
        )

    user_id, user_email, created_at = row
    return {"id": user_id, "email": user_email, "created_at": created_at}


@app.post("/api/login")
def login(credentials: Credentials):
    email = normalise_email(credentials.email)
    candidate = password_bytes(credentials.password)

    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, email, password_hash FROM users WHERE email = %s",
                (email,),
            )
            row = cur.fetchone()

    if row is None:
        # Hash anyway so an unknown email costs the same time as a wrong
        # password, and the response can't be used to enumerate accounts.
        bcrypt.hashpw(candidate, bcrypt.gensalt())
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password.",
        )

    user_id, user_email, password_hash = row
    if not bcrypt.checkpw(candidate, password_hash.encode("utf-8")):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password.",
        )

    return {"id": user_id, "email": user_email}
@app.get("/api/port/countries")
def port_countries():
    """Per-country traffic summary, ranked by 2019 TEU."""
    with get_port_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT country_iso3, country_name, region_name,
                       teu_2019, teu_2010, latest_year, latest_teu,
                       cagr_2010_2019, rank_2019
                FROM port_mart.country_traffic_summary
                WHERE teu_2019 IS NOT NULL
                ORDER BY rank_2019
                """
            )
            rows = cur.fetchall()

    return [
        {
            "iso3": r[0],
            "name": r[1],
            "region": r[2],
            "teu_2019": r[3],
            "teu_2010": r[4],
            "latest_year": r[5],
            "latest_teu": r[6],
            "cagr": r[7],
            "rank": r[8],
        }
        for r in rows
    ]
@app.get("/api/port/regions")
def port_regions():
    """Regional traffic totals by year, for trend charts."""
    with get_port_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT region_code, region_name, traffic_year,
                       total_teu, countries_reporting, mean_teu
                FROM port_mart.traffic_by_region_year
                ORDER BY region_name, traffic_year
                """
            )
            rows = cur.fetchall()

    return [
        {
            "region_code": r[0],
            "region": r[1],
            "year": r[2],
            "total_teu": r[3],
            "countries_reporting": r[4],
            "mean_teu": r[5],
        }
        for r in rows
    ]


@app.get("/api/port/country/{iso3}")
def port_country(iso3: str):
    """Full time series for one country."""
    with get_port_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT traffic_year, teu
                FROM port_raw.country_port_traffic
                WHERE country_iso3 = %s
                ORDER BY traffic_year
                """,
                (iso3.upper(),),
            )
            rows = cur.fetchall()

    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No traffic data for {iso3}.",
        )

    return {
        "iso3": iso3.upper(),
        "series": [{"year": r[0], "teu": r[1]} for r in rows],
    }
# The newest month is whatever PortWatch has published so far, so it covers only
# part of that month and reads as a collapse it is not. It is returned, named,
# and left for the caller to drop — the same treatment the World Bank coverage
# cliff gets on the throughput charts.
def latest_month(cur) -> str | None:
    cur.execute("SELECT max(month_start) FROM port_mart.port_calls_by_type_month")
    row = cur.fetchone()
    return row[0].isoformat() if row and row[0] else None


@app.get("/api/port/calls/ports")
def port_call_ports():
    """Ports with vessel-arrival data, ranked by arrivals in the last 12 months."""
    with get_port_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                WITH bounds AS (
                    SELECT max(month_start) AS latest
                    FROM port_mart.port_calls_by_type_month
                )
                SELECT c.portid, c.portname, c.country, c.country_iso3, c.continent,
                       sum(c.calls_total) AS calls_12m
                FROM port_mart.port_calls_by_type_month c, bounds b
                WHERE c.month_start > b.latest - INTERVAL '12 months'
                GROUP BY c.portid, c.portname, c.country, c.country_iso3, c.continent
                HAVING sum(c.calls_total) > 0
                ORDER BY calls_12m DESC, c.portname
                """
            )
            rows = cur.fetchall()
            partial = latest_month(cur)

    return {
        "partial_month": partial,
        "ports": [
            {
                "portid": r[0], "name": r[1], "country": r[2], "iso3": r[3],
                "continent": r[4], "calls_12m": r[5],
            }
            for r in rows
        ],
    }


@app.get("/api/port/calls/global")
def port_calls_global():
    """Monthly vessel arrivals across every port, split by vessel type.

    The card's default view. Declared above the /{portid} route so "global"
    is matched as a route and never as a port id.

    `ports_reporting` rides along per month because a world total moves for two
    different reasons — more ships, or more ports carrying data — and the card
    has no way to tell them apart without it.
    """
    with get_port_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT month_start,
                       sum(calls_container), sum(calls_dry_bulk),
                       sum(calls_general_cargo), sum(calls_roro),
                       sum(calls_tanker), sum(calls_total),
                       count(DISTINCT portid)
                FROM port_mart.port_calls_by_type_month
                GROUP BY month_start
                ORDER BY month_start
                """
            )
            rows = cur.fetchall()
            partial = latest_month(cur)

            cur.execute(
                "SELECT count(DISTINCT portid) FROM port_mart.port_calls_by_type_month"
            )
            total_ports = cur.fetchone()[0]

    return {
        "scope": {"portid": None, "name": "All ports", "country": "Worldwide",
                  "ports": total_ports},
        "partial_month": partial,
        "series": [
            {
                "month": r[0].isoformat(),
                "container": r[1], "dry_bulk": r[2], "general_cargo": r[3],
                "roro": r[4], "tanker": r[5], "total": r[6],
                "ports_reporting": r[7],
            }
            for r in rows
        ],
    }


@app.get("/api/port/calls/{portid}")
def port_calls(portid: str):
    """Monthly vessel arrivals at one port, split by vessel type."""
    with get_port_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT portname, country, country_iso3, continent
                FROM port_raw.portwatch_ports
                WHERE portid = %s
                """,
                (portid,),
            )
            port = cur.fetchone()
            if port is None:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"No port with id {portid}.",
                )

            cur.execute(
                """
                SELECT month_start, calls_container, calls_dry_bulk,
                       calls_general_cargo, calls_roro, calls_tanker, calls_total
                FROM port_mart.port_calls_by_type_month
                WHERE portid = %s
                ORDER BY month_start
                """,
                (portid,),
            )
            rows = cur.fetchall()
            partial = latest_month(cur)

    return {
        "port": {
            "portid": portid, "name": port[0], "country": port[1],
            "iso3": port[2], "continent": port[3],
        },
        "partial_month": partial,
        "series": [
            {
                "month": r[0].isoformat(),
                "container": r[1], "dry_bulk": r[2], "general_cargo": r[3],
                "roro": r[4], "tanker": r[5], "total": r[6],
            }
            for r in rows
        ],
    }


# Legs are capped per direction and per domestic/international scope, not
# overall: a cap on the combined list would leave the domestic filter showing a
# handful of legs for a port that has fifty, which reads as a fact about the
# port rather than about the cap.
CONNECTION_LEGS_PER_SCOPE = 60

# Which column anchors the query and which one is the counterpart, per
# direction. Fixed pairs, chosen by key — the direction never reaches SQL as a
# string from the caller.
CONNECTION_SIDES = {
    "outbound": ("from_portid", "to"),
    "inbound": ("to_portid", "from"),
}


def connection_legs(cur, portid: str, direction: str) -> dict:
    anchor, other = CONNECTION_SIDES[direction]

    cur.execute(
        f"""
        WITH legs AS (
            SELECT s.{other}_portid   AS portid,
                   s.{other}_portname AS portname,
                   s.{other}_country  AS country,
                   s.{other}_iso3     AS iso3,
                   p.continent        AS continent,
                   s.average_transit_days,
                   s.daily_capacity_at_risk,
                   s.relative_capacity_at_risk,
                   s.is_domestic,
                   ROW_NUMBER() OVER (
                       PARTITION BY s.is_domestic
                       ORDER BY s.daily_capacity_at_risk DESC NULLS LAST
                   ) AS scope_rank
            FROM port_mart.port_connection_summary s
            LEFT JOIN port_raw.portwatch_ports p ON p.portid = s.{other}_portid
            WHERE s.{anchor} = %s
        )
        SELECT portid, portname, country, iso3, continent, average_transit_days,
               daily_capacity_at_risk, relative_capacity_at_risk, is_domestic
        FROM legs
        WHERE scope_rank <= %s
        ORDER BY daily_capacity_at_risk DESC NULLS LAST
        """,
        (portid, CONNECTION_LEGS_PER_SCOPE),
    )
    legs = [
        {
            "portid": r[0], "name": r[1], "country": r[2], "iso3": r[3],
            "continent": r[4], "transit_days": r[5],
            "daily_capacity": r[6], "relative_capacity": r[7],
            "is_domestic": r[8],
        }
        for r in cur.fetchall()
    ]

    # The full picture behind the cap, so the card can say how much of the
    # port's network it is actually drawing.
    cur.execute(
        f"""
        SELECT s.is_domestic, count(*), sum(s.daily_capacity_at_risk)
        FROM port_mart.port_connection_summary s
        WHERE s.{anchor} = %s
        GROUP BY s.is_domestic
        """,
        (portid,),
    )
    totals = {"domestic": {"legs": 0, "daily_capacity": 0.0},
              "international": {"legs": 0, "daily_capacity": 0.0}}
    for is_domestic, count, capacity in cur.fetchall():
        scope = "domestic" if is_domestic else "international"
        totals[scope] = {"legs": count, "daily_capacity": float(capacity or 0)}

    return {"legs": legs, "totals": totals}


# The busiest routes worldwide are capped the same way one port's legs are, and
# for the same reason: per scope, so the domestic filter is not silently
# showing the leftovers of an international-dominated overall cap.
GLOBAL_ROUTES_PER_SCOPE = 60


@app.get("/api/port/connections/global")
def port_connections_global():
    """The busiest directed port pairs worldwide, ranked by capacity at risk.

    The card's default view. Declared above the /{portid} route so "global" is
    matched as a route and never as a port id. Both scopes come back in one
    response so the domestic/international toggle never refetches.
    """
    with get_port_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                WITH ranked AS (
                    SELECT s.from_portid, s.from_portname, s.from_country, s.from_iso3,
                           s.to_portid, s.to_portname, s.to_country, s.to_iso3,
                           s.to_continent, s.average_transit_days,
                           s.daily_capacity_at_risk, s.relative_capacity_at_risk,
                           s.is_domestic,
                           ROW_NUMBER() OVER (
                               PARTITION BY s.is_domestic
                               ORDER BY s.daily_capacity_at_risk DESC NULLS LAST
                           ) AS scope_rank
                    FROM port_mart.port_connection_summary s
                )
                SELECT from_portid, from_portname, from_country, from_iso3,
                       to_portid, to_portname, to_country, to_iso3, to_continent,
                       average_transit_days, daily_capacity_at_risk,
                       relative_capacity_at_risk, is_domestic
                FROM ranked
                WHERE scope_rank <= %s
                ORDER BY daily_capacity_at_risk DESC NULLS LAST
                """,
                (GLOBAL_ROUTES_PER_SCOPE,),
            )
            routes = [
                {
                    "from": {"portid": r[0], "name": r[1], "country": r[2], "iso3": r[3]},
                    "to": {"portid": r[4], "name": r[5], "country": r[6], "iso3": r[7],
                           "continent": r[8]},
                    "transit_days": r[9],
                    "daily_capacity": r[10],
                    "relative_capacity": r[11],
                    "is_domestic": r[12],
                }
                for r in cur.fetchall()
            ]

            # What the cap is a slice of, so the card can say so on the panel.
            cur.execute(
                """
                SELECT is_domestic, count(*), sum(daily_capacity_at_risk)
                FROM port_mart.port_connection_summary
                GROUP BY is_domestic
                """
            )
            totals = {"domestic": {"legs": 0, "daily_capacity": 0.0},
                      "international": {"legs": 0, "daily_capacity": 0.0}}
            for is_domestic, count, capacity in cur.fetchall():
                scope = "domestic" if is_domestic else "international"
                totals[scope] = {"legs": count, "daily_capacity": float(capacity or 0)}

    return {
        "scope": {"portid": None, "name": "All ports", "country": "Worldwide"},
        "routes_per_scope": GLOBAL_ROUTES_PER_SCOPE,
        "routes": routes,
        "totals": totals,
    }


@app.get("/api/port/connections/{portid}")
def port_connections(portid: str):
    """One port's origin-destination network, both directions.

    Both directions come back in one response so the card's outbound/inbound
    toggle does not have to go to the network, and neither does its
    domestic/international filter.
    """
    with get_port_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT portname, country, country_iso3, continent
                FROM port_raw.portwatch_ports
                WHERE portid = %s
                """,
                (portid,),
            )
            port = cur.fetchone()
            if port is None:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"No port with id {portid}.",
                )

            outbound = connection_legs(cur, portid, "outbound")
            inbound = connection_legs(cur, portid, "inbound")

    return {
        "port": {
            "portid": portid, "name": port[0], "country": port[1],
            "iso3": port[2], "continent": port[3],
        },
        "legs_per_scope": CONNECTION_LEGS_PER_SCOPE,
        "outbound": outbound,
        "inbound": inbound,
    }


STALE_AFTER_HOURS = 48


@app.get("/api/registry/assets")
def registry_assets():
    """The data register: every asset with a computed quality status."""
    with get_port_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT a.asset_key, a.layer, a.description, a.source_system,
                       a.grain, a.owner, a.last_row_count, a.last_run_at,
                       COUNT(q.check_name)              AS checks_total,
                       COUNT(*) FILTER (WHERE q.passed) AS checks_passed,
                       a.last_run_at < now() - make_interval(hours => %s) AS stale
                FROM registry.assets a
                LEFT JOIN registry.quality_checks q ON q.asset_key = a.asset_key
                GROUP BY a.asset_key
                ORDER BY a.layer, a.asset_key
                """,
                (STALE_AFTER_HOURS,),
            )
            rows = cur.fetchall()

    out = []
    for r in rows:
        checks_total, checks_passed, stale = r[8], r[9], r[10]
        if checks_total == 0 or checks_passed < checks_total:
            quality = "red"
        elif stale:
            quality = "amber"
        else:
            quality = "green"
        out.append({
            "asset_key": r[0], "layer": r[1], "description": r[2],
            "source_system": r[3], "grain": r[4], "owner": r[5],
            "row_count": r[6], "last_run_at": r[7],
            "checks_total": checks_total, "checks_passed": checks_passed,
            "quality": quality,
        })
    return out
@app.get("/api/registry/asset/{asset_key}")
def registry_asset(asset_key: str):
    """One asset in full: fields, checks, and lineage."""
    with get_port_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT asset_key, layer, description, source_system,
                       source_detail, grain, owner, last_row_count, last_run_at
                FROM registry.assets
                WHERE asset_key = %s
                """,
                (asset_key,),
            )
            asset = cur.fetchone()
            if asset is None:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"No asset named {asset_key}.",
                )

            cur.execute(
                """
                SELECT field_name, data_type, description, unit, is_nullable
                FROM registry.fields
                WHERE asset_key = %s
                ORDER BY field_name
                """,
                (asset_key,),
            )
            fields = cur.fetchall()

            cur.execute(
                """
                SELECT check_name, passed, detail, checked_at
                FROM registry.quality_checks
                WHERE asset_key = %s
                ORDER BY check_name
                """,
                (asset_key,),
            )
            checks = cur.fetchall()

            cur.execute(
                "SELECT from_asset FROM registry.edges WHERE to_asset = %s",
                (asset_key,),
            )
            upstream = [r[0] for r in cur.fetchall()]

            cur.execute(
                "SELECT to_asset FROM registry.edges WHERE from_asset = %s",
                (asset_key,),
            )
            downstream = [r[0] for r in cur.fetchall()]

    return {
        "asset_key": asset[0], "layer": asset[1], "description": asset[2],
        "source_system": asset[3], "source_detail": asset[4],
        "grain": asset[5], "owner": asset[6],
        "row_count": asset[7], "last_run_at": asset[8],
        "fields": [
            {"name": f[0], "type": f[1], "description": f[2],
             "unit": f[3], "nullable": f[4]}
            for f in fields
        ],
        "checks": [
            {"name": c[0], "passed": c[1], "detail": c[2], "checked_at": c[3]}
            for c in checks
        ],
        "upstream": upstream,
        "downstream": downstream,
    }
