"""
database.py — SQLModel engine and session configuration.

REUSABLE PATTERN: Export `sqlite_url` as a module-level string so that
background tasks (which run outside the request lifecycle and cannot use
FastAPI's Depends injection) can create their own engine and session.
For production, replace the sqlite_url with a PostgreSQL connection string.

MIGRATION PATTERN: _run_migrations() uses raw SQLite PRAGMA + ALTER TABLE
to add new columns to existing tables without dropping data. This is the
safe, forward-compatible approach for schema evolution in SQLite.
KNOWN BUG AVOIDED: SQLModel/SQLAlchemy's create_all() only creates missing
tables — it never alters existing ones. Always use explicit ALTER TABLE for
adding columns to a live database.
"""

import sqlite3
from sqlmodel import SQLModel, create_engine, Session
from models import OptionsData, IndicatorData, ValidationReport, BacktestTrade, SignalValidationReport

# Exported so background task workers can create their own DB sessions
sqlite_file_name = "database.db"
sqlite_url = f"sqlite:///{sqlite_file_name}"

connect_args = {"check_same_thread": False}
engine = create_engine(sqlite_url, echo=False, connect_args=connect_args)


def _run_migrations():
    """
    Safely add new columns to existing tables.
    REUSABLE: Copy this pattern for any SQLite schema evolution.
    Uses PRAGMA table_info to detect existing columns before ALTER TABLE.
    """
    with sqlite3.connect(sqlite_file_name) as conn:
        cursor = conn.cursor()
        
        # 1. ValidationReport migrations
        cursor.execute("PRAGMA table_info(validationreport)")
        existing_val = {row[1].lower() for row in cursor.fetchall()}
        val_migrations = [
            ("indicatorname", "TEXT",    "NULL"),
            ("stock",         "TEXT",    "NULL"),
            ("maxdrawdown",   "REAL",    "NULL"),
            ("profitfactor",  "REAL",    "NULL"),
            ("avgtrade",      "REAL",    "NULL"),
            ("totaltrades",   "INTEGER", "NULL"),
        ]
        for col_name, col_type, default in val_migrations:
            if col_name not in existing_val:
                cursor.execute(f"ALTER TABLE validationreport ADD COLUMN {col_name} {col_type} DEFAULT {default}")

        # 2. IndicatorData migrations
        cursor.execute("PRAGMA table_info(indicatordata)")
        existing_ind = {row[1].lower() for row in cursor.fetchall()}
        ind_migrations = [
            ("date",      "TEXT",    "NULL"),
            ("time",      "TEXT",    "NULL"),
            ("open",      "INTEGER", "NULL"),
            ("high",      "INTEGER", "NULL"),
            ("low",       "INTEGER", "NULL"),
            ("close",     "INTEGER", "NULL"),
            ("volume",    "INTEGER", "NULL"),
            ("exchange",  "TEXT",    "NULL"),
            ("updatedby", "TEXT",    "NULL"),
            ("timeframe", "TEXT",    "'1m'"),
        ]
        for col_name, col_type, default in ind_migrations:
            if col_name not in existing_ind:
                cursor.execute(f"ALTER TABLE indicatordata ADD COLUMN {col_name} {col_type} DEFAULT {default}")

        # 3. OptionsData migrations
        cursor.execute("PRAGMA table_info(optionsdata)")
        existing_opt = {row[1].lower() for row in cursor.fetchall()}
        opt_migrations = [
            ("updatedby", "TEXT",    "NULL"),
        ]
        for col_name, col_type, default in opt_migrations:
            if col_name not in existing_opt:
                cursor.execute(f"ALTER TABLE optionsdata ADD COLUMN {col_name} {col_type} DEFAULT {default}")

        # 4. SignalValidationReport migrations (new columns added over time)
        # create_all() creates the table on first run; ALTER TABLE handles future columns.
        cursor.execute("PRAGMA table_info(signalvalidationreport)")
        existing_svr = {row[1].lower() for row in cursor.fetchall()}
        svr_migrations = [
            # Add future columns here as the schema evolves — zero data loss pattern
        ]  # type: list
        for col_name, col_type, default in svr_migrations:
            if col_name not in existing_svr:
                cursor.execute(f"ALTER TABLE signalvalidationreport ADD COLUMN {col_name} {col_type} DEFAULT {default}")

        conn.commit()


def create_db_and_tables():
    """Creates all tables defined in SQLModel metadata. Called once on startup."""
    SQLModel.metadata.create_all(engine)
    # Run safe column migrations for existing databases
    _run_migrations()


def get_session():
    """FastAPI dependency: yields a database session for request handlers."""
    with Session(engine) as session:
        yield session

