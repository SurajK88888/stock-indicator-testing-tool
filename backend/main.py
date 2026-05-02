"""
main.py — FastAPI application entry point for the Stock Indicator Testing Tool.

REUSABLE PATTERNS:
- CORS allow_origins includes multiple local ports so frontend port changes (3000→3001)
  do not break API calls. In production, replace with the actual deployed domain.
- `lifespan` context manager replaces the deprecated `@app.on_event("startup")` pattern
  (deprecated in FastAPI ≥ 0.93). Using `lifespan` is the stable, forward-compatible approach.
- Routers are imported and included AFTER the app is created to prevent circular imports.

KNOWN BUG AVOIDED: Do not use `@app.on_event("startup")` — it is deprecated and produces
DeprecationWarning which can cause issues with newer Uvicorn versions. Use `lifespan` instead.

KNOWN BUG AVOIDED: Do not hardcode a single port in CORS allow_origins. Local dev servers
(Next.js, Vite) often switch ports when the default is taken. Allow a range.
"""

from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from database import create_db_and_tables
import sentry_sdk

sentry_sdk.init(
    dsn="", # Add your DSN here
    traces_sample_rate=1.0,
    profiles_sample_rate=1.0,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Runs on startup (before yield) and on shutdown (after yield).
    REUSABLE: Drop-in replacement for @app.on_event("startup") / "shutdown".
    """
    # Startup: create all database tables
    create_db_and_tables()
    yield
    # Shutdown: cleanup (nothing needed for SQLite)


app = FastAPI(
    title="Stock Indicator Testing API",
    description="Backend for the Sovereign Ledger Terminal backtesting platform.",
    version="1.0.0",
    lifespan=lifespan,
)

# ---------------------------------------------------------------------------
# CORS — Allow all likely local dev ports for the Next.js frontend.
# FIX: Added port 3001 (Next.js uses it when 3000 is taken by another process).
# In production replace with: allow_origins=["https://your-domain.com"]
# ---------------------------------------------------------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:3001",   # FIX: Next.js fallback port
        "http://localhost:3002",   # Additional fallback
        "http://127.0.0.1:3000",
        "http://127.0.0.1:3001",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/", tags=["health"])
def read_root():
    """Health check endpoint."""
    return {"status": "ok", "message": "Stock Indicator Testing API is running."}


# Import routers AFTER app is defined to prevent circular import issues
from services import ingestion, validator, results, admin, debug  # noqa: E402

app.include_router(ingestion.router)
app.include_router(validator.router)
app.include_router(results.router)
app.include_router(admin.router)
app.include_router(debug.router)
