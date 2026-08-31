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
