"""
services/ingestion.py — Data ingestion pipeline for the Stock Indicator Testing Tool.

REUSABLE PATTERNS:
- Multi-format datetime parsing: tries a priority list of formats before failing gracefully.
- Header-mapping pattern: frontend sends a JSON mapping of {fileColumn: dbField}
  which is applied as a Polars rename before insertion.
- Pre-storage date-range filter: filters the DataFrame BEFORE creating DB records,
  keeping the database lean and query-fast.
- `session.add_all()` for bulk inserts (SQLAlchemy 2.x / SQLModel compatible).
- UUID injection: adds 'id' to each record dict before model instantiation,
  preventing primary key constraint violations.

KNOWN BUG AVOIDED: Do NOT use `session.bulk_save_objects()` — it is deprecated
in SQLAlchemy 2.x (which SQLModel uses). Always use `session.add_all()`.

KNOWN BUG AVOIDED: Never hardcode a single strptime format for Indian market data.
NSE/BSE files use DD-MM-YYYY, YYYY-MM-DD HH:MM:SS, DD/MM/YYYY HH:MM, etc.
Always try multiple formats and fall back gracefully.
"""

import uuid
import io
import json
from datetime import datetime

import polars as pl
from fastapi import APIRouter, UploadFile, File, Form, Depends
from sqlmodel import Session, select

from database import get_session
from models import SpotData, OptionsData, IndicatorData

router = APIRouter(prefix="/api", tags=["ingestion"])


# ---------------------------------------------------------------------------
# Priority-ordered list of datetime formats commonly found in Indian
# market data files (NSE, BSE, broker exports).
# REUSABLE: Copy this list into any financial data parser.
# ---------------------------------------------------------------------------
DATETIME_FORMATS = [
    "%Y-%m-%d %H:%M:%S",
    "%d-%m-%Y %H:%M:%S",
    "%d/%m/%Y %H:%M:%S",
    "%Y-%m-%dT%H:%M:%S",
    "%d-%m-%Y %H:%M",
    "%d/%m/%Y %H:%M",
    "%Y-%m-%d %H:%M",
    "%d-%b-%Y %H:%M:%S",  # e.g. 24-Oct-2023 10:15:00
    "%d-%m-%Y",
    "%Y-%m-%d",
]


def _try_parse_datetime(series: pl.Series) -> pl.Series:
    """
    Attempts to parse a string Series as Datetime using a priority list of formats.
    Returns the first successfully parsed result, or the original series on failure.
    REUSABLE: Drop-in utility for any Polars-based financial data pipeline.
    """
    for fmt in DATETIME_FORMATS:
        try:
            parsed = series.str.strptime(pl.Datetime, fmt, strict=False)
            # Accept if at least one value was parsed (non-null)
            if parsed.is_not_null().sum() > 0:
                return parsed
        except Exception:
            continue
    # Return original if all formats fail; upstream caller handles null check
    return series


# ---------------------------------------------------------------------------
# Endpoint: Upload file → extract headers + sample rows for the frontend mapper.
# This is a lightweight "peek" step — no data is stored.
# ---------------------------------------------------------------------------
@router.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    """
    Reads the file, extracts headers and returns them plus top 10 rows.
    The frontend uses these headers to build the mapping dropdowns.
    """
    contents = await file.read()
    try:
        if file.filename.endswith(".csv"):
            df = pl.read_csv(io.BytesIO(contents), n_rows=10, infer_schema_length=0)
        else:
            df = pl.read_excel(io.BytesIO(contents))
            df = df.head(10)
    except Exception as e:
        return {"error": f"Could not read file: {str(e)}"}

    return {
        "headers": df.columns,
        "sample": df.to_dicts()
    }


# ---------------------------------------------------------------------------
# Endpoint: Ingest mapped data → parse, filter, and bulk-insert into DB.
# The frontend sends: the file, a JSON mapping dict, the dataType, and an
# optional date range. All filtering happens BEFORE DB insertion.
# ---------------------------------------------------------------------------
@router.post("/ingest")
async def ingest_data(
    file: UploadFile = File(...),
    mappings: str = Form(...),      # JSON: {"FileHeader": "dbField", ...}
    dataType: str = Form(...),      # "spot" | "options" | "indicator"
    startDate: str = Form(None),    # Optional: "YYYY-MM-DD"
    endDate: str = Form(None),      # Optional: "YYYY-MM-DD"
    exchange: str = Form(None),
    stock: str = Form(None),
    optionType: str = Form(None),   # "Call" or "Put" — options only
    expiry: str = Form(None),       # "YYYY-MM-DD" — options only
    indicatorName: str = Form(None),  # indicator only
    session: Session = Depends(get_session)
):
    """
    Full ingestion pipeline:
    1. Read file into Polars DataFrame (all columns as strings initially).
    2. Rename columns per the user's header mapping.
    3. Parse datetime column using multi-format parser.
    4. Apply pre-storage date-range filter.
    5. Scale price columns to integer precision (×100).
    6. Inject metadata (exchange, stock, type, etc.) as constant columns.
    7. Bulk insert via session.add_all().
    """
    contents = await file.read()
    try:
        if file.filename.endswith(".csv"):
            # infer_schema_length=0 reads all as strings to avoid type conflicts
            df = pl.read_csv(io.BytesIO(contents), infer_schema_length=0)
        else:
            df = pl.read_excel(io.BytesIO(contents))
    except Exception as e:
        return {"error": f"Could not read file: {str(e)}"}

    # Step 1: Apply header mapping (rename file columns to DB field names)
    mapping_dict = json.loads(mappings)
    # Only rename columns that exist in the DataFrame to avoid KeyError
    rename_map = {k: v for k, v in mapping_dict.items() if k in df.columns and v}
    df = df.rename(rename_map)

    # Step 2: Parse DateTime — try all known formats
    if "dateTime" in df.columns:
        df = df.with_columns(
            _try_parse_datetime(pl.col("dateTime").cast(pl.Utf8)).alias("dateTime")
        )
        # Drop rows where dateTime could not be parsed
        df = df.filter(pl.col("dateTime").is_not_null())

    # Step 3: Pre-storage date-range filter (requirement: filter BEFORE inserting)
    if startDate and endDate and "dateTime" in df.columns:
        try:
            start_dt = datetime.strptime(startDate, "%Y-%m-%d")
            end_dt = datetime.strptime(endDate, "%Y-%m-%d")
            df = df.filter(
                (pl.col("dateTime") >= start_dt) & (pl.col("dateTime") <= end_dt)
            )
        except ValueError:
            return {"error": "Invalid date format. Use YYYY-MM-DD."}

    # Step 4: Scale price columns to int precision (price × 100)
    price_cols = ["price", "open", "high", "low", "close"]
    for col in price_cols:
        if col in df.columns:
            df = df.with_columns(
                (pl.col(col).cast(pl.Float64) * 100).cast(pl.Int64).alias(col)
            )

    # Step 5: Inject metadata constants from form fields
    # These values come from the static dropdowns in the frontend, not the file
    if exchange and "exchange" not in df.columns:
        df = df.with_columns(pl.lit(exchange).alias("exchange"))
    if stock and "stock" not in df.columns:
        df = df.with_columns(pl.lit(stock).alias("stock"))
    if optionType and "type" not in df.columns:
        df = df.with_columns(pl.lit(optionType).alias("type"))
    if expiry and "expiry" not in df.columns:
        df = df.with_columns(pl.lit(expiry).alias("expiry"))
    if indicatorName and "indicatorName" not in df.columns:
        df = df.with_columns(pl.lit(indicatorName).alias("indicatorName"))

    # Step 6: Map dataType to model class
    table_map = {
        "spot": SpotData,
        "options": OptionsData,
        "indicator": IndicatorData,
    }
    TargetModel = table_map.get(dataType)
    if not TargetModel:
        return {"error": f"Invalid dataType '{dataType}'. Must be: spot, options, indicator."}

    records = df.to_dicts()
    if not records:
        return {"error": "No records to insert after filtering. Check date range or file content."}

    # Step 7: Create model instances.
    # IMPORTANT: Always inject a fresh UUID for 'id' — never rely on source data
    # having an id column. This prevents primary key constraint violations.
    instances = []
    for record in records:
        record["id"] = str(uuid.uuid4())
        # Remove keys not in the model to avoid unexpected keyword argument errors
        try:
            instances.append(TargetModel(**{
                k: v for k, v in record.items()
                if k in TargetModel.__fields__
            }))
        except Exception:
            continue  # Skip malformed rows silently

    # Step 8: Bulk insert using session.add_all() — SQLModel/SQLAlchemy 2.x compatible
    # KNOWN BUG: Never use session.bulk_save_objects() — deprecated in SQLAlchemy 2.x
    try:
        session.add_all(instances)
        session.commit()
    except Exception as e:
        session.rollback()
        return {"error": f"Database insert failed: {str(e)}"}

    return {
        "message": f"Successfully ingested {len(instances)} rows into {dataType} table.",
        "count": len(instances)
    }


# ---------------------------------------------------------------------------
# Endpoint: Return all distinct indicator names from the IndicatorData table.
# The frontend Indicator Validator dropdown uses this to show only indicators
# that have actually been imported — not a hardcoded list.
# ---------------------------------------------------------------------------
@router.get("/indicators")
def get_indicator_names(session: Session = Depends(get_session)):
    """
    Returns distinct indicatorName values from the IndicatorData table.
    Used by the frontend to dynamically populate the Indicator dropdown.
    """
    statement = select(IndicatorData.indicatorName).distinct()
    results = session.exec(statement).all()
    return {"indicators": list(results)}
