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
