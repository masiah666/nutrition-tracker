"""Load IMF PortWatch vessel-arrival and port-connection data into portdata.

PortWatch (portwatch.imf.org, IMF + University of Oxford) publishes AIS-derived
port activity as unauthenticated ArcGIS FeatureServer layers. Three of them are
pulled here:

  PortWatch_ports_database      2,065 ports, one row each   -> port_raw.portwatch_ports
  Daily_Ports_Data              port calls per port per day -> port_raw.port_calls_monthly
  spillovers_port_level_impact  directed port pairs         -> port_raw.port_connections

Daily calls are rolled up to months by the server (outStatistics), so this pulls
~200k grouped rows instead of the 5.8M daily ones.

Two marts are built on top, one per dashboard card, and every asset is written
to the register with its fields, lineage and quality checks — the same contract
the Mage exporters follow.

This is the seed load. The recurring refresh belongs in a Mage pipeline in the
mage-pipelines repo; PortWatch republishes weekly (Tuesdays).

The crawl takes the better part of an hour, so it is resumable. Ports,
connections and each year of monthly calls are committed as they land, and a
rerun skips what is already in the database — an interrupted run is picked up
where it stopped, not started again. Two escape hatches:

    PW_REFETCH=1   refetch and overwrite everything, skipping nothing
    PW_FRESH=1     drop the raw tables first, for when their columns change
    PW_ONLY=marts  skip the crawl and rebuild the marts, register and checks
                   from the raw tables already loaded

Run it where psycopg and the database are both reachable:

    docker cp ingest/portwatch_load.py nutrition-tracker-backend-1:/tmp/
    docker exec nutrition-tracker-backend-1 python3 /tmp/portwatch_load.py
"""

import json
import os
import sys
import time
import urllib.parse
import urllib.request

import psycopg

ARCGIS = (
    "https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services"
    "/{layer}/FeatureServer/0/query"
)

# The layer's own maxRecordCount. Asking for more is silently capped, so paging
# is the only way through a table.
PAGE = 1000

# Daily_Ports_Data starts in 2019. The end is read from the layer rather than
# hardcoded, so a rerun next year picks up the new one.
FIRST_YEAR = 2019

VESSEL_TYPES = ["container", "dry_bulk", "general_cargo", "roro", "tanker"]

OWNER = "Haisam"
SOURCE_SYSTEM = "IMF PortWatch"


def log(msg):
    print(msg, flush=True)


def fetch(layer, params, attempts=6):
    """One ArcGIS query, retried patiently.

    PortWatch republishes weekly and the service answers a valid query with a
    bare HTTP 400 while it is rebuilding. The backoff runs 5s to 80s rather
    than 2s to 8s, because a blip that outlasts the retries used to cost the
    entire crawl."""
    url = ARCGIS.format(layer=layer) + "?" + urllib.parse.urlencode(
        dict(params, f="json")
    )
    last = None
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(url, timeout=120) as response:
                body = json.load(response)
            if "error" in body:
                raise RuntimeError(body["error"])
            return body
        except Exception as exc:  # noqa: BLE001 - retried, then re-raised
            last = exc
            if attempt < attempts - 1:
                delay = min(5 * 2 ** attempt, 80)
                log(f"  {layer} {params.get('where', '')} retry in {delay}s: {exc}")
                time.sleep(delay)
    raise RuntimeError(f"{layer} query failed after {attempts} attempts: {last}")


def fetch_all(layer, params, label):
    """Page a layer to exhaustion, yielding attribute dicts."""
    offset = 0
    rows = []
    while True:
        body = fetch(layer, dict(params, resultOffset=offset, resultRecordCount=PAGE))
        page = [f["attributes"] for f in body.get("features", [])]
        rows.extend(page)
        if len(page) < PAGE:
            break
        offset += PAGE
        if offset % (PAGE * 25) == 0:
            log(f"  {label}: {len(rows)} rows")
    return rows


# ===== Extract =====


def latest_year():
    stats = json.dumps([
        {"statisticType": "max", "onStatisticField": "year",
         "outStatisticFieldName": "y"},
    ])
    body = fetch("Daily_Ports_Data", {"where": "1=1", "outStatistics": stats})
    return int(body["features"][0]["attributes"]["y"])


def load_ports():
    log("ports database…")
    rows = fetch_all(
        "PortWatch_ports_database",
        {
            "where": "1=1",
            "outFields": "portid,portname,country,ISO3,continent,lat,lon,LOCODE,"
                         "vessel_count_total",
            "returnGeometry": "false",
            "orderByFields": "portid",
        },
        "ports",
    )
    log(f"  {len(rows)} ports")
    return [
        (
            r["portid"], r["portname"], r["country"], r["ISO3"], r["continent"],
            r["lat"], r["lon"], r["LOCODE"], r["vessel_count_total"],
        )
        for r in rows
    ]


CALL_STATS = json.dumps([
    {"statisticType": "sum", "onStatisticField": f"portcalls_{t}",
     "outStatisticFieldName": t}
    for t in VESSEL_TYPES
] + [
    {"statisticType": "sum", "onStatisticField": "portcalls",
     "outStatisticFieldName": "total"},
])


def load_calls_year(year):
    """Port calls per port per month for one year, aggregated server-side.

    A year at a time is both the paging unit and the commit unit. One query
    over the whole range would page through ~200k grouped rows on every
    request's ORDER BY, and the service times out long before the end of it."""
    rows = fetch_all(
        "Daily_Ports_Data",
        {
            "where": f"year={year}",
            "groupByFieldsForStatistics": "portid,year,month",
            "outStatistics": CALL_STATS,
            "orderByFields": "portid,month",
        },
        f"calls {year}",
    )
    return [
        (
            r["portid"], r["year"], r["month"],
            r["container"], r["dry_bulk"], r["general_cargo"],
            r["roro"], r["tanker"], r["total"],
        )
        for r in rows
    ]


def load_connections():
    log("port connections…")
    rows = fetch_all(
        "spillovers_port_level_impact",
        {
            "where": "1=1",
            "outFields": "from_portid,from_portname,from_country,from_iso3,"
                         "to_portid,to_portname,to_country,to_iso3,"
                         "average_transit_days,daily_capacity_at_risk,"
                         "relative_capacity_at_risk",
            "returnGeometry": "false",
            "orderByFields": "from_portid,to_portid",
        },
        "connections",
    )
    log(f"  {len(rows)} directed port pairs")
    return [
        (
            r["from_portid"], r["from_portname"], r["from_country"], r["from_iso3"],
            r["to_portid"], r["to_portname"], r["to_country"], r["to_iso3"],
            r["average_transit_days"], r["daily_capacity_at_risk"],
            r["relative_capacity_at_risk"],
        )
        for r in rows
    ]


# ===== Load =====

# The raw tables are created, never dropped: a run that dies half way through
# leaves the years it did land, and the next run keeps them. PW_FRESH=1 drops
# them first, which is what to reach for if these columns ever change.
DDL = """
CREATE SCHEMA IF NOT EXISTS port_raw;
CREATE SCHEMA IF NOT EXISTS port_mart;

CREATE TABLE IF NOT EXISTS port_raw.portwatch_ports (
    portid              TEXT PRIMARY KEY,
    portname            TEXT NOT NULL,
    country             TEXT,
    country_iso3        TEXT,
    continent           TEXT,
    latitude            DOUBLE PRECISION,
    longitude           DOUBLE PRECISION,
    locode              TEXT,
    vessel_count_total  INTEGER
);

CREATE TABLE IF NOT EXISTS port_raw.port_calls_monthly (
    portid              TEXT     NOT NULL,
    calls_year          SMALLINT NOT NULL,
    calls_month         SMALLINT NOT NULL,
    calls_container     INTEGER,
    calls_dry_bulk      INTEGER,
    calls_general_cargo INTEGER,
    calls_roro          INTEGER,
    calls_tanker        INTEGER,
    calls_total         INTEGER,
    PRIMARY KEY (portid, calls_year, calls_month)
);

CREATE TABLE IF NOT EXISTS port_raw.port_connections (
    from_portid               TEXT NOT NULL,
    from_portname             TEXT,
    from_country              TEXT,
    from_iso3                 TEXT,
    to_portid                 TEXT NOT NULL,
    to_portname               TEXT,
    to_country                TEXT,
    to_iso3                   TEXT,
    average_transit_days      DOUBLE PRECISION,
    daily_capacity_at_risk    DOUBLE PRECISION,
    relative_capacity_at_risk DOUBLE PRECISION,
    PRIMARY KEY (from_portid, to_portid)
);
"""

DROP_RAW = """
DROP TABLE IF EXISTS port_raw.portwatch_ports CASCADE;
DROP TABLE IF EXISTS port_raw.port_calls_monthly CASCADE;
DROP TABLE IF EXISTS port_raw.port_connections CASCADE;
"""

# Card 1. Joined to the ports database for the name, country and coordinates the
# daily feed does not carry. The two cover the same 2,065 ids, so the inner join
# is not expected to drop anything; the every_row_has_a_named_port check is what
# says so, and would fail if the feed ever gained an id the reference lacks.
MART_CALLS = """
DROP TABLE IF EXISTS port_mart.port_calls_by_type_month;
CREATE TABLE port_mart.port_calls_by_type_month AS
SELECT p.portid, p.portname, p.country, p.country_iso3, p.continent,
       c.calls_year, c.calls_month,
       make_date(c.calls_year::int, c.calls_month::int, 1) AS month_start,
       c.calls_container, c.calls_dry_bulk, c.calls_general_cargo,
       c.calls_roro, c.calls_tanker, c.calls_total
FROM port_raw.port_calls_monthly c
JOIN port_raw.portwatch_ports p USING (portid);

ALTER TABLE port_mart.port_calls_by_type_month
    ADD PRIMARY KEY (portid, calls_year, calls_month);
CREATE INDEX ON port_mart.port_calls_by_type_month (country_iso3);
"""

# Card 2. is_domestic is the split the card filters on: a leg that stays inside
# one country is feeder or coastal traffic, a leg that crosses a border is not.
# It is NOT a transhipment flag — PortWatch does not publish one, and neither
# does any other free source, so the card must not imply one.
MART_CONNECTIONS = """
DROP TABLE IF EXISTS port_mart.port_connection_summary;
CREATE TABLE port_mart.port_connection_summary AS
SELECT c.from_portid, c.from_portname, c.from_country, c.from_iso3,
       c.to_portid, c.to_portname, c.to_country, c.to_iso3,
       t.continent AS to_continent,
       c.average_transit_days,
       c.daily_capacity_at_risk,
       c.relative_capacity_at_risk,
       (c.from_iso3 = c.to_iso3)                     AS is_domestic,
       ROW_NUMBER() OVER (PARTITION BY c.from_portid
                          ORDER BY c.daily_capacity_at_risk DESC NULLS LAST)
                                                     AS rank_from_port,
       ROW_NUMBER() OVER (PARTITION BY c.to_portid
                          ORDER BY c.daily_capacity_at_risk DESC NULLS LAST)
                                                     AS rank_to_port
FROM port_raw.port_connections c
LEFT JOIN port_raw.portwatch_ports t ON t.portid = c.to_portid;

ALTER TABLE port_mart.port_connection_summary
    ADD PRIMARY KEY (from_portid, to_portid);
CREATE INDEX ON port_mart.port_connection_summary (from_portid, rank_from_port);
CREATE INDEX ON port_mart.port_connection_summary (to_portid, rank_to_port);
"""


def insert_many(cur, table, columns, rows, key):
    """Insert, overwriting any row already under the same key.

    Every stage can be replayed — a half-landed table, or a partial year that
    has since filled out, is corrected rather than duplicated or refused."""
    placeholders = "(" + ", ".join(["%s"] * len(columns)) + ")"
    updates = ", ".join(f"{c} = EXCLUDED.{c}" for c in columns if c not in key)
    sql = (
        f"INSERT INTO {table} ({', '.join(columns)}) VALUES {placeholders} "
        f"ON CONFLICT ({', '.join(key)}) DO UPDATE SET {updates}"
    )
    cur.executemany(sql, rows)


# ===== Register =====

FIELD_DOCS = {
    "port_raw.portwatch_ports": {
        "portid": ("PortWatch port identifier", None),
        "portname": ("Port display name", None),
        "country": ("Country the port is in", None),
        "country_iso3": ("ISO 3166-1 alpha-3 code", None),
        "continent": ("PortWatch continent grouping", None),
        "latitude": ("Port latitude", "degrees"),
        "longitude": ("Port longitude", "degrees"),
        "locode": ("UN/LOCODE, where PortWatch records one", None),
        "vessel_count_total": ("Distinct vessels seen calling, all types", "vessels"),
    },
    "port_raw.port_calls_monthly": {
        "portid": ("PortWatch port identifier", None),
        "calls_year": ("Calendar year of the month", "year"),
        "calls_month": ("Month number, 1-12", "month"),
        "calls_container": ("Container vessel arrivals in the month", "port calls"),
        "calls_dry_bulk": ("Dry bulk vessel arrivals in the month", "port calls"),
        "calls_general_cargo": ("General cargo vessel arrivals in the month", "port calls"),
        "calls_roro": ("Roll-on/roll-off vessel arrivals in the month", "port calls"),
        "calls_tanker": ("Tanker arrivals in the month", "port calls"),
        "calls_total": ("All arrivals in the month, every vessel type", "port calls"),
    },
    "port_raw.port_connections": {
        "from_portid": ("Origin port identifier", None),
        "from_portname": ("Origin port name", None),
        "from_country": ("Origin country", None),
        "from_iso3": ("Origin country ISO 3166-1 alpha-3 code", None),
        "to_portid": ("Destination port identifier", None),
        "to_portname": ("Destination port name", None),
        "to_country": ("Destination country", None),
        "to_iso3": ("Destination country ISO 3166-1 alpha-3 code", None),
        "average_transit_days": ("Mean observed sailing time on this leg", "days"),
        "daily_capacity_at_risk": ("Mean cargo capacity sailing this leg per day", "DWT/day"),
        "relative_capacity_at_risk": ("That capacity as a share of the destination's total", "fraction"),
    },
    "port_mart.port_calls_by_type_month": {
        "portid": ("PortWatch port identifier", None),
        "portname": ("Port display name", None),
        "country": ("Country the port is in", None),
        "country_iso3": ("ISO 3166-1 alpha-3 code", None),
        "continent": ("PortWatch continent grouping", None),
        "calls_year": ("Calendar year of the month", "year"),
        "calls_month": ("Month number, 1-12", "month"),
        "month_start": ("First day of the month, for plotting", "date"),
        "calls_container": ("Container vessel arrivals in the month", "port calls"),
        "calls_dry_bulk": ("Dry bulk vessel arrivals in the month", "port calls"),
        "calls_general_cargo": ("General cargo vessel arrivals in the month", "port calls"),
        "calls_roro": ("Roll-on/roll-off vessel arrivals in the month", "port calls"),
        "calls_tanker": ("Tanker arrivals in the month", "port calls"),
        "calls_total": ("All arrivals in the month, every vessel type", "port calls"),
    },
    "port_mart.port_connection_summary": {
        "from_portid": ("Origin port identifier", None),
        "from_portname": ("Origin port name", None),
        "from_country": ("Origin country", None),
        "from_iso3": ("Origin country ISO 3166-1 alpha-3 code", None),
        "to_portid": ("Destination port identifier", None),
        "to_portname": ("Destination port name", None),
        "to_country": ("Destination country", None),
        "to_iso3": ("Destination country ISO 3166-1 alpha-3 code", None),
        "to_continent": ("Destination continent", None),
        "average_transit_days": ("Mean observed sailing time on this leg", "days"),
        "daily_capacity_at_risk": ("Mean cargo capacity sailing this leg per day", "DWT/day"),
        "relative_capacity_at_risk": ("That capacity as a share of the destination's total", "fraction"),
        "is_domestic": ("Both ports in the same country. NOT a transhipment flag", None),
        "rank_from_port": ("Rank of this leg among the origin's departures, 1 = largest", None),
        "rank_to_port": ("Rank of this leg among the destination's arrivals, 1 = largest", None),
    },
}

ASSETS = {
    "port_raw.portwatch_ports": dict(
        layer="raw",
        description="PortWatch port reference list, 2,065 ports worldwide",
        source_detail="ArcGIS layer PortWatch_ports_database",
        grain="one row per port",
    ),
    "port_raw.port_calls_monthly": dict(
        layer="raw",
        description="Vessel arrivals per port per month, split by vessel type",
        source_detail="ArcGIS layer Daily_Ports_Data, summed to months server-side",
        grain="one row per port per month",
    ),
    "port_raw.port_connections": dict(
        layer="raw",
        description="Directed origin-to-destination port pairs with observed sailing capacity",
        source_detail="ArcGIS layer spillovers_port_level_impact",
        grain="one row per directed port pair",
    ),
    "port_mart.port_calls_by_type_month": dict(
        layer="mart",
        description="Monthly vessel arrivals by type, named and located",
        source_detail="Built from port_raw.port_calls_monthly and port_raw.portwatch_ports",
        grain="one row per port per month",
        upstream=["port_raw.port_calls_monthly", "port_raw.portwatch_ports"],
        source_system="Derived",
    ),
    "port_mart.port_connection_summary": dict(
        layer="mart",
        description="Port origin-destination legs, ranked per port, split domestic vs international",
        source_detail="Built from port_raw.port_connections and port_raw.portwatch_ports",
        grain="one row per directed port pair",
        upstream=["port_raw.port_connections", "port_raw.portwatch_ports"],
        source_system="Derived",
    ),
}


def register(cur, asset_key, row_count):
    spec = ASSETS[asset_key]
    schema_name, table_name = asset_key.split(".", 1)

    cur.execute(
        """
        INSERT INTO registry.assets (
            asset_key, schema_name, table_name, layer, description,
            source_system, source_detail, grain, owner,
            pipeline_uuid, block_uuid, last_run_at, last_row_count
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now(), %s)
        ON CONFLICT (asset_key) DO UPDATE SET
            layer          = EXCLUDED.layer,
            description    = EXCLUDED.description,
            source_system  = EXCLUDED.source_system,
            source_detail  = EXCLUDED.source_detail,
            grain          = EXCLUDED.grain,
            last_run_at    = EXCLUDED.last_run_at,
            last_row_count = EXCLUDED.last_row_count
        """,
        (
            asset_key, schema_name, table_name, spec["layer"], spec["description"],
            spec.get("source_system", SOURCE_SYSTEM), spec["source_detail"],
            spec["grain"], OWNER, "portwatch_load", "ingest/portwatch_load.py",
            row_count,
        ),
    )

    cur.execute(
        """
        SELECT column_name, data_type, is_nullable = 'YES'
        FROM information_schema.columns
        WHERE table_schema = %s AND table_name = %s
        """,
        (schema_name, table_name),
    )
    docs = FIELD_DOCS[asset_key]
    for column, data_type, nullable in cur.fetchall():
        description, unit = docs.get(column, (None, None))
        cur.execute(
            """
            INSERT INTO registry.fields
                (asset_key, field_name, data_type, description, unit, is_nullable)
            VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT (asset_key, field_name) DO UPDATE SET
                data_type   = EXCLUDED.data_type,
                description = EXCLUDED.description,
                unit        = EXCLUDED.unit,
                is_nullable = EXCLUDED.is_nullable
            """,
            (asset_key, column, data_type, description, unit, nullable),
        )

    for upstream in spec.get("upstream", []):
        cur.execute(
            """
            INSERT INTO registry.edges (from_asset, to_asset, edge_type)
            VALUES (%s, %s, 'feeds')
            ON CONFLICT DO NOTHING
            """,
            (upstream, asset_key),
        )


def record_check(cur, asset_key, check_name, passed, detail):
    cur.execute(
        """
        INSERT INTO registry.quality_checks
            (asset_key, check_name, passed, detail, checked_at)
        VALUES (%s, %s, %s, %s, now())
        ON CONFLICT (asset_key, check_name) DO UPDATE SET
            passed     = EXCLUDED.passed,
            detail     = EXCLUDED.detail,
            checked_at = EXCLUDED.checked_at
        """,
        (asset_key, check_name, passed, detail),
    )


def run_checks(cur, asset_key, checks):
    """A check that crashes is recorded as a failure, never skipped — the same
    rule the Mage exporters follow. A check that cannot run is not a pass.

    Each check runs inside its own savepoint. A statement that errors aborts
    only that savepoint, so the failure can still be written down; without one,
    the first bad check poisons the stage's transaction and the INSERT that
    would have recorded it fails too, burying the original error."""
    for name, sql, verdict in checks:
        # A check may carry bound parameters as (sql, params) — no value is
        # ever formatted into the statement.
        sql, params = sql if isinstance(sql, tuple) else (sql, ())
        try:
            with cur.connection.transaction():
                cur.execute(sql, params)
                value = cur.fetchone()[0]
            passed, detail = verdict(value)
        except Exception as exc:  # noqa: BLE001 - recorded as a failure
            passed, detail = False, f"check crashed: {exc}"
            log(f"  {asset_key}.{name} crashed: {exc}")
        record_check(cur, asset_key, name, passed, detail)


def check_all(cur, through_year):
    run_checks(cur, "port_raw.portwatch_ports", [
        ("has_rows", "SELECT count(*) FROM port_raw.portwatch_ports",
         lambda n: (n > 0, f"{n} rows")),
        ("key_fields_present",
         "SELECT count(*) FROM port_raw.portwatch_ports "
         "WHERE portname IS NULL OR country_iso3 IS NULL",
         lambda n: (n == 0, f"{n} rows missing portname or country_iso3")),
        ("coordinates_in_range",
         "SELECT count(*) FROM port_raw.portwatch_ports "
         "WHERE latitude NOT BETWEEN -90 AND 90 OR longitude NOT BETWEEN -180 AND 180",
         lambda n: (n == 0, f"{n} ports outside valid lat/lon")),
    ])

    run_checks(cur, "port_raw.port_calls_monthly", [
        ("has_rows", "SELECT count(*) FROM port_raw.port_calls_monthly",
         lambda n: (n > 0, f"{n} rows")),
        ("months_in_range",
         "SELECT count(*) FROM port_raw.port_calls_monthly "
         "WHERE calls_month NOT BETWEEN 1 AND 12",
         lambda n: (n == 0, f"{n} rows with a month outside 1-12")),
        ("calls_non_negative",
         "SELECT count(*) FROM port_raw.port_calls_monthly WHERE calls_total < 0",
         lambda n: (n == 0, f"{n} rows with negative total calls")),
        ("types_sum_within_total",
         "SELECT count(*) FROM port_raw.port_calls_monthly WHERE "
         "calls_container + calls_dry_bulk + calls_general_cargo + calls_roro "
         "+ calls_tanker > calls_total",
         lambda n: (n == 0,
                    f"{n} rows where the five vessel types exceed the reported total")),
        ("reaches_current_year",
         ("SELECT count(*) FROM port_raw.port_calls_monthly WHERE calls_year = %s",
          (through_year,)),
         lambda n: (n > 0, f"{n} rows in {through_year}, the layer's latest year")),
        # The load commits a year at a time, so an abandoned run shows up here
        # as a hole in the range rather than as a quietly short table.
        ("every_year_loaded",
         # The casts are load-bearing: a bare int parameter arrives as smallint,
         # and generate_series has no smallint overload to resolve to.
         ("SELECT count(*) FROM generate_series(%s::int, %s::int) y "
          "WHERE NOT EXISTS ("
          "SELECT 1 FROM port_raw.port_calls_monthly WHERE calls_year = y)",
          (FIRST_YEAR, through_year)),
         lambda n: (n == 0,
                    f"{n} years between {FIRST_YEAR} and {through_year} have no rows")),
    ])

    run_checks(cur, "port_raw.port_connections", [
        ("has_rows", "SELECT count(*) FROM port_raw.port_connections",
         lambda n: (n > 0, f"{n} rows")),
        ("no_self_legs",
         "SELECT count(*) FROM port_raw.port_connections WHERE from_portid = to_portid",
         lambda n: (n == 0, f"{n} legs from a port to itself")),
        ("transit_days_positive",
         "SELECT count(*) FROM port_raw.port_connections WHERE average_transit_days <= 0",
         lambda n: (n == 0, f"{n} legs with a non-positive transit time")),
        ("capacity_non_negative",
         "SELECT count(*) FROM port_raw.port_connections WHERE daily_capacity_at_risk < 0",
         lambda n: (n == 0, f"{n} legs with negative daily capacity")),
    ])

    run_checks(cur, "port_mart.port_calls_by_type_month", [
        ("has_rows", "SELECT count(*) FROM port_mart.port_calls_by_type_month",
         lambda n: (n > 0, f"{n} rows")),
        ("every_row_has_a_named_port",
         "SELECT count(*) FROM port_mart.port_calls_by_type_month WHERE portname IS NULL",
         lambda n: (n == 0, f"{n} rows with no port name")),
        ("no_month_gaps_in_top_ports",
         """
         SELECT count(*) FROM (
             SELECT portid,
                    count(*)                                  AS months,
                    (max(month_start) - min(month_start)) / 30 AS span
             FROM port_mart.port_calls_by_type_month
             GROUP BY portid
             ORDER BY sum(calls_total) DESC
             LIMIT 50
         ) t WHERE months < span - 1
         """,
         lambda n: (n == 0, f"{n} of the 50 busiest ports have gaps in their monthly series")),
    ])

    run_checks(cur, "port_mart.port_connection_summary", [
        ("has_rows", "SELECT count(*) FROM port_mart.port_connection_summary",
         lambda n: (n > 0, f"{n} rows")),
        ("domestic_split_populated",
         "SELECT count(*) FROM port_mart.port_connection_summary WHERE is_domestic IS NULL",
         lambda n: (n == 0, f"{n} legs where the domestic/international split is unknown")),
        ("origins_resolve_to_known_ports",
         "SELECT count(DISTINCT s.from_portid) FROM port_mart.port_connection_summary s "
         "LEFT JOIN port_raw.portwatch_ports p ON p.portid = s.from_portid "
         "WHERE p.portid IS NULL",
         lambda n: (n == 0, f"{n} origin ports are not in the ports reference list")),
        ("ranks_start_at_one",
         "SELECT count(*) FROM (SELECT from_portid FROM port_mart.port_connection_summary "
         "GROUP BY from_portid HAVING min(rank_from_port) <> 1) t",
         lambda n: (n == 0, f"{n} origin ports whose ranking does not start at 1")),
    ])


CALLS_COLUMNS = [
    "portid", "calls_year", "calls_month", "calls_container",
    "calls_dry_bulk", "calls_general_cargo", "calls_roro",
    "calls_tanker", "calls_total",
]


def table_count(cur, table):
    cur.execute(f"SELECT count(*) FROM {table}")
    return cur.fetchone()[0]


def years_landed(cur):
    """Years already in port_calls_monthly, and how many port-months each has.

    A year is written and committed in one transaction, so a year is either
    entirely here or not here at all — which is what makes it safe to skip."""
    cur.execute(
        "SELECT calls_year, count(*) FROM port_raw.port_calls_monthly "
        "GROUP BY calls_year"
    )
    return dict(cur.fetchall())


def stage_ports(conn, force):
    with conn.cursor() as cur:
        landed = table_count(cur, "port_raw.portwatch_ports")
    if landed and not force:
        log(f"ports database… {landed} already landed, skipping")
        return
    rows = load_ports()
    with conn.cursor() as cur:
        insert_many(cur, "port_raw.portwatch_ports", [
            "portid", "portname", "country", "country_iso3", "continent",
            "latitude", "longitude", "locode", "vessel_count_total",
        ], rows, key=["portid"])
    conn.commit()
    log("  committed")


def stage_connections(conn, force):
    with conn.cursor() as cur:
        landed = table_count(cur, "port_raw.port_connections")
    if landed and not force:
        log(f"port connections… {landed} already landed, skipping")
        return
    rows = load_connections()
    with conn.cursor() as cur:
        insert_many(cur, "port_raw.port_connections", [
            "from_portid", "from_portname", "from_country", "from_iso3",
            "to_portid", "to_portname", "to_country", "to_iso3",
            "average_transit_days", "daily_capacity_at_risk",
            "relative_capacity_at_risk",
        ], rows, key=["from_portid", "to_portid"])
    conn.commit()
    log("  committed")


def stage_calls(conn, through_year, force):
    """Fetch and commit the monthly calls one year at a time.

    Each year is committed as it lands, so a crawl that dies — or is killed —
    resumes at the year it stopped on instead of starting again. The newest
    year is always refetched: PortWatch is still filling it in, and the rows
    already here are last run's partial view of it."""
    with conn.cursor() as cur:
        landed = years_landed(cur)

    for year in range(FIRST_YEAR, through_year + 1):
        if year in landed and year < through_year and not force:
            log(f"monthly calls {year}… {landed[year]} port-months already "
                f"landed, skipping")
            continue
        if year in landed:
            log(f"monthly calls {year}… (refetching the newest year)")
        else:
            log(f"monthly calls {year}…")
        rows = load_calls_year(year)
        log(f"  {len(rows)} port-months")
        with conn.cursor() as cur:
            insert_many(cur, "port_raw.port_calls_monthly", CALLS_COLUMNS,
                        rows, key=["portid", "calls_year", "calls_month"])
        conn.commit()
        log(f"  committed {year}")


def stage_marts(conn, through_year):
    """Rebuilt from the raw tables on every run — seconds of work, and it keeps
    the marts honest about whatever the raw tables now hold."""
    log("building marts…")
    with conn.cursor() as cur:
        cur.execute(MART_CALLS)
        cur.execute(MART_CONNECTIONS)

        for asset_key in ASSETS:
            register(cur, asset_key, table_count(cur, asset_key))

        check_all(cur, through_year)
    conn.commit()
    log("  committed")


def main():
    dsn = psycopg.conninfo.make_conninfo(
        host=os.getenv("DB_HOST", "localhost"),
        port=os.getenv("DB_PORT", "5432"),
        dbname=os.getenv("PORT_DB_NAME", "portdata"),
        user=os.getenv("PORT_DB_USER", os.getenv("DB_USER", "nutritrack")),
        password=os.getenv("PORT_DB_PASSWORD", os.getenv("DB_PASSWORD", "")),
    )
    force = os.getenv("PW_REFETCH") == "1"
    fresh = os.getenv("PW_FRESH") == "1"
    only_marts = os.getenv("PW_ONLY") == "marts"

    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            if fresh:
                log("PW_FRESH=1 — dropping the raw tables")
                cur.execute(DROP_RAW)
            cur.execute(DDL)
        conn.commit()

        if only_marts:
            # Rebuild on top of what is already landed. The marts are seconds
            # of work and the crawl is the better part of an hour, so a mart or
            # check that needs fixing should not cost the crawl again.
            with conn.cursor() as cur:
                cur.execute("SELECT max(calls_year) FROM port_raw.port_calls_monthly")
                through = cur.fetchone()[0]
            if through is None:
                log("PW_ONLY=marts, but no calls are loaded — nothing to build on")
                return 1
            log(f"PW_ONLY=marts — rebuilding on calls through {through}")
        else:
            through = latest_year()
            log(f"PortWatch daily data runs to {through}")

            stage_ports(conn, force)
            stage_connections(conn, force)
            stage_calls(conn, through, force)

        stage_marts(conn, through)

    log("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
