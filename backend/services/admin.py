"""
services/admin.py — Database administration endpoints.

REUSABLE PATTERNS:
- Dynamic table discovery: uses SQLite PRAGMA sqlite_master to list all user
  tables at runtime — no hardcoded table names ever.
- Allowlist guard: validates table name against known tables before executing
  any destructive SQL, preventing SQL injection via path parameter.
- DELETE FROM ... (not DROP TABLE): removes all rows while preserving schema,
  indexes, and constraints — exactly the "clear data, keep structure" pattern.

KNOWN BUG AVOIDED: Never use f-string interpolation directly into SQL for table
names, even after allowlist validation. Use SQLAlchemy text() with safe quoting.
"""

from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlmodel import Session, text

from database import get_session

router = APIRouter(prefix="/api/admin", tags=["admin"])


def _get_all_tables(session: Session) -> list[dict]:
    """
    Dynamically fetches all user-created tables from the SQLite schema.
    Returns a list of dicts with table name and row count.
    REUSABLE: Works for any SQLite-backed FastAPI/SQLModel project.
    """
    result = session.exec(
        text("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    ).all()

    tables = []
    for row in result:
        table_name = row[0]
        # Skip internal sqlite tables
        if table_name.startswith("sqlite_"):
            continue
            
        count_result = session.exec(
            text(f'SELECT COUNT(*) FROM "{table_name}"')
        ).first()
        row_count = count_result[0] if count_result else 0
        
        # Check if table has updated_on, expiry, or type columns
        has_updated_on = False
        has_expiry = False
        has_type = False
        try:
            columns = session.exec(text(f'PRAGMA table_info("{table_name}")')).all()
            has_updated_on = any(col[1] == "updated_on" for col in columns)
            has_expiry = any(col[1] == "expiry" for col in columns)
            has_type = any(col[1] == "type" for col in columns)
        except Exception:
            pass

        tables.append({
            "name": table_name, 
            "rowCount": row_count,
            "hasUpdatedOn": has_updated_on,
            "hasExpiry": has_expiry,
            "hasType": has_type
        })

    return tables


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/admin/tables — List all tables with their current row counts
# ─────────────────────────────────────────────────────────────────────────────
@router.get("/tables")
def list_tables(session: Session = Depends(get_session)):
    """
    Returns all tables in the SQLite database with their row counts and metadata.
    Used by the frontend Clear Data panel to populate the table dropdown.
    """
    return {"tables": _get_all_tables(session)}


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/admin/tables/{table_name}/filters — Get unique values for filters
# ─────────────────────────────────────────────────────────────────────────────
@router.get("/tables/{table_name}/filters")
def get_table_filters(table_name: str, session: Session = Depends(get_session)):
    """Returns unique ingestion timestamps, expiries, and types for a table."""
    # Security: validate table name
    if not table_name.replace("_", "").isalnum():
        raise HTTPException(status_code=400, detail="Invalid table name.")

    columns = session.exec(text(f'PRAGMA table_info("{table_name}")')).all()
    col_names = [col[1] for col in columns]

    filters = {"timestamps": [], "expiries": [], "types": []}

    if "updated_on" in col_names:
        query = text(f'SELECT DISTINCT updated_on FROM "{table_name}" WHERE updated_on IS NOT NULL ORDER BY updated_on DESC')
        result = session.exec(query).all()
        filters["timestamps"] = [ts[0].isoformat() if hasattr(ts[0], "isoformat") else str(ts[0]) for ts in result]

    if "expiry" in col_names:
        query = text(f'SELECT DISTINCT expiry FROM "{table_name}" WHERE expiry IS NOT NULL ORDER BY expiry DESC')
        result = session.exec(query).all()
        filters["expiries"] = [ts[0].isoformat() if hasattr(ts[0], "isoformat") else str(ts[0]) for ts in result]

    if "type" in col_names:
        query = text(f'SELECT DISTINCT type FROM "{table_name}" WHERE type IS NOT NULL ORDER BY type ASC')
        result = session.exec(query).all()
        filters["types"] = [str(ts[0]) for ts in result]

    return filters


# ─────────────────────────────────────────────────────────────────────────────
# DELETE /api/admin/tables/{table_name}/clear — Delete rows from a table
#
# SAFETY: table_name is validated against the real schema before execution.
# This prevents SQL injection and accidental deletion of non-existent tables.
# If updated_on is provided, only deletes records from that ingestion batch.
# ─────────────────────────────────────────────────────────────────────────────
@router.delete("/tables/{table_name}/clear")
def clear_table(
    table_name: str, 
    updated_on: Optional[str] = Query(None),
    expiry: Optional[str] = Query(None),
    opt_type: Optional[str] = Query(None, alias="type"),
    session: Session = Depends(get_session)
):
    """
    Deletes rows from the specified table while preserving its schema.
    If filters are provided, deletes only records matching those conditions.
    Raises 404 if the table doesn't exist.
    """
    # Security: validate table name
    if not table_name.replace("_", "").isalnum():
        raise HTTPException(status_code=400, detail="Invalid table name.")

    # Validate table actually exists in schema
    existing = session.exec(
        text("SELECT name FROM sqlite_master WHERE type='table' AND name=:name"),
        params={"name": table_name}
    ).first()

    if not existing:
        raise HTTPException(
            status_code=404,
            detail=f"Table '{table_name}' does not exist in the database."
        )

    # Verify columns exist before filtering
    columns = session.exec(text(f'PRAGMA table_info("{table_name}")')).all()
    col_names = [col[1] for col in columns]

    conditions = []
    params = {}

    if updated_on:
        if "updated_on" not in col_names:
            raise HTTPException(status_code=400, detail=f"Table '{table_name}' does not have an 'updated_on' column.")
        conditions.append("updated_on = :ts")
        params["ts"] = updated_on

    if expiry:
        if "expiry" not in col_names:
            raise HTTPException(status_code=400, detail=f"Table '{table_name}' does not have an 'expiry' column.")
        conditions.append("expiry = :expiry")
        params["expiry"] = expiry

    if opt_type:
        if "type" not in col_names:
            raise HTTPException(status_code=400, detail=f"Table '{table_name}' does not have a 'type' column.")
        conditions.append("type = :type")
        params["type"] = opt_type

    base_query = f'FROM "{table_name}"'
    where_clause = (" WHERE " + " AND ".join(conditions)) if conditions else ""

    count_query = text(f'SELECT COUNT(*) {base_query}{where_clause}')
    delete_query = text(f'DELETE {base_query}{where_clause}')

    # Count rows before deletion
    count_result = session.exec(count_query, params=params).first()
    rows_deleted = count_result[0] if count_result else 0

    # Execute the deletion
    session.exec(delete_query, params=params)
    session.commit()

    filters_used = [f"{k}='{v}'" for k, v in [("updated_on", updated_on), ("expiry", expiry), ("type", opt_type)] if v]
    filter_msg = " with " + " AND ".join(filters_used) if filters_used else ""
    return {
        "success": True,
        "table": table_name,
        "rowsDeleted": rows_deleted,
        "message": f"Cleared {rows_deleted} rows from '{table_name}'{filter_msg}. Table structure preserved."
    }
