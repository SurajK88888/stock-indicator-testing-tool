"""
database.py — SQLModel engine and session configuration.

REUSABLE PATTERN: Export `sqlite_url` as a module-level string so that
background tasks (which run outside the request lifecycle and cannot use
FastAPI's Depends injection) can create their own engine and session.
For production, replace the sqlite_url with a PostgreSQL connection string.
"""

from sqlmodel import SQLModel, create_engine, Session
from models import SpotData, OptionsData, IndicatorData, ValidationReport

# Exported so background task workers can create their own DB sessions
sqlite_file_name = "database.db"
sqlite_url = f"sqlite:///{sqlite_file_name}"

connect_args = {"check_same_thread": False}
engine = create_engine(sqlite_url, echo=False, connect_args=connect_args)


def create_db_and_tables():
    """Creates all tables defined in SQLModel metadata. Called once on startup."""
    SQLModel.metadata.create_all(engine)


def get_session():
    """FastAPI dependency: yields a database session for request handlers."""
    with Session(engine) as session:
        yield session
