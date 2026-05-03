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
import re
from datetime import datetime

import polars as pl
from fastapi import APIRouter, UploadFile, File, Form, Depends
from sqlmodel import Session, select

from database import get_session
from models import OptionsData, IndicatorData

router = APIRouter(prefix="/api", tags=["ingestion"])


# ---------------------------------------------------------------------------
# Priority-ordered list of datetime formats commonly found in Indian
# market data files (NSE, BSE, broker exports).
# NOTE: Formats with %z are intentionally NOT listed here because Polars
# str.strptime does not handle colon-separated offsets like +05:30 reliably.
# Instead, _try_parse_datetime() pre-strips timezone suffixes from the raw
# string BEFORE attempting to parse — this is the safe, universal approach.
# REUSABLE: Copy this list into any financial data parser.
# ---------------------------------------------------------------------------
DATETIME_FORMATS = [
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%dT%H:%M",
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d %H:%M",
    "%d-%m-%Y %H:%M:%S",
    "%d/%m/%Y %H:%M:%S",
    "%d-%m-%Y %H:%M",
    "%d/%m/%Y %H:%M",
    "%d-%b-%Y %H:%M:%S",   # e.g. 24-Oct-2023 10:15:00
    "%d-%m-%Y",
    "%Y-%m-%d",
]


# Regex that matches any trailing timezone suffix:
# +05:30 | +0530 | -05:30 | Z | z
_TZ_SUFFIX_RE = re.compile(r"([+-]\d{2}:?\d{2}|[Zz])$")


def _strip_timezone(series: pl.Series) -> pl.Series:
    """
    Pre-strips timezone suffixes from an Utf8 Series using vectorised Polars
    str.replace. This is safer than relying on %z in strptime, which is
    inconsistent across Polars versions for colon-separated offsets.
    REUSABLE: Use before any datetime parsing in financial data pipelines.
    """
    # Remove +05:30 / +0530 / -05:30 / Z suffixes
    return series.str.replace(r"([+-]\d{2}:?\d{2}|[Zz])$", "", literal=False)


def _try_parse_datetime(series: pl.Series) -> pl.Series:
    """
    Attempts to parse a string Series as Datetime.
    Step 1: Strip timezone suffix so formats without %z can match.
    Step 2: Try each format in priority order; accept first with >0 non-null values.
    Returns the original series on total failure; upstream caller handles null check.
    REUSABLE: Drop-in utility for any Polars-based financial data pipeline.

    KNOWN BUG FIXED: Polars str.strptime with %z fails silently on '+05:30' strings
    (colon-separated IST offset). Pre-stripping the timezone is the correct fix.
    """
    clean = _strip_timezone(series)
    for fmt in DATETIME_FORMATS:
        try:
            parsed = clean.str.strptime(pl.Datetime, fmt, strict=False)
            if parsed.is_not_null().sum() > 0:
                return parsed
        except Exception:
            continue
    # All formats failed — return original for upstream error handling
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
    startTime: str = Form(None),    # Optional: "HH:MM" or "HH:MM:SS"
    endTime: str = Form(None),      # Optional: "HH:MM" or "HH:MM:SS"
    exchange: str = Form(None),
    stock: str = Form(None),
    optionType: str = Form(None),   # "Call" or "Put" — options only
    expiry: str = Form(None),       # "YYYY-MM-DD" — options only
    indicatorName: str = Form(None),  # indicator only
    manualScript: str = Form(None),   # Level 3 fallback for script
    manualLotSize: str = Form(None),  # Optional manual lot size override
    timeframe: str = Form("1m"),     # NEW: 1m, 5m, 15m etc
    updatedBy: str = Form(None),     # NEW: User who uploaded the data
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

    # Capture ingestion time once for the entire batch (System Datetime)
    ingestion_time = datetime.now()

    # ── Pre-flight validation ──────────────────────────────────────────────────
    # KNOWN BUG FIXED: indicatordata.indicatorName is NOT NULL.
    # If the frontend sends an empty indicatorName, Step 5 skips injection and
    # SQLite raises an IntegrityError. Catch this early with a clear message.
    if dataType == "indicator" and not indicatorName:
        return {"error": "Indicator Name is required. Please select an indicator (e.g. RSI, MACD) before ingesting."}

    # Step 1: Apply header mapping (rename file columns to DB field names)
    mapping_dict = json.loads(mappings)
    # Only rename columns that exist in the DataFrame to avoid KeyError
    rename_map = {k: v for k, v in mapping_dict.items() if k in df.columns and v}
    
    # REUSABLE PATTERN: Robust Renaming
    # If the user maps 'Column A' -> 'open', but the file already contains an 'open' column 
    # that wasn't mapped, Polars would raise a DuplicateError. 
    # We resolve this by dropping any conflicting columns that were NOT explicitly mapped by the user.
    target_names = set(rename_map.values())
    cols_to_drop = [c for c in df.columns if c in target_names and c not in rename_map.keys()]
    if cols_to_drop:
        df = df.drop(cols_to_drop)

    df = df.rename(rename_map)

    # Step 2: Parse DateTime — try all known formats
    if "dateTime" in df.columns:
        df = df.with_columns(
            _try_parse_datetime(df["dateTime"].cast(pl.Utf8)).alias("dateTime")
        )
        if df["dateTime"].dtype in (pl.Datetime, pl.Date):
            # Drop rows where dateTime is null after parsing (malformed rows)
            df = df.filter(pl.col("dateTime").is_not_null())
            if df.is_empty():
                return {"error": "All rows failed datetime parsing. Check that the correct DateTime column is mapped."}

            # dateTime is now always timezone-naive (timezone was pre-stripped by
            # _strip_timezone before parsing). No convert_time_zone needed.

            # Generate derived 'date' string if not already a column
            if "date" not in df.columns:
                df = df.with_columns(pl.col("dateTime").dt.strftime("%Y-%m-%d").alias("date"))
            # Generate derived 'time' string if not already a column
            if "time" not in df.columns:
                df = df.with_columns(pl.col("dateTime").dt.strftime("%H:%M:%S").alias("time"))
        else:
            return {"error": "Failed to parse dateTime column. Supported formats: YYYY-MM-DD HH:MM:SS, DD-MM-YYYY HH:MM, ISO 8601 with/without timezone."}

    # Step 3: Pre-storage date and time range filter
    if "dateTime" in df.columns and df["dateTime"].dtype in (pl.Datetime, pl.Date):
        # CASE A: Combined Interval (Continuous Timeline)
        # If all 4 are set, treat as: FROM (startDate startTime) TO (endDate endTime)
        if startDate and endDate and startTime and endTime:
            try:
                # Polars str.to_datetime is fast, but we'll use python datetime for boundary creation
                fmt_start = "%H:%M:%S" if len(startTime) > 5 else "%H:%M"
                fmt_end = "%H:%M:%S" if len(endTime) > 5 else "%H:%M"
                start_dt_str = f"{startDate} {startTime}"
                end_dt_str = f"{endDate} {endTime}"
                start_val = datetime.strptime(start_dt_str, f"%Y-%m-%d {fmt_start}")
                end_val = datetime.strptime(end_dt_str, f"%Y-%m-%d {fmt_end}")
                
                df = df.filter(
                    (pl.col("dateTime") >= start_val) & 
                    (pl.col("dateTime") <= end_val)
                )
            except ValueError:
                return {"error": "Invalid Date/Time format. Use YYYY-MM-DD and HH:MM(:SS)."}

        # CASE B: Date-Only (Broad Range)
        elif startDate and endDate:
            try:
                start_dt = datetime.strptime(startDate, "%Y-%m-%d").date()
                end_dt = datetime.strptime(endDate, "%Y-%m-%d").date()
                # Ensure end_dt covers full day
                end_val = datetime.combine(end_dt, datetime.max.time())
                df = df.filter(
                    (pl.col("dateTime").dt.date() >= start_dt) & 
                    (pl.col("dateTime").dt.date() <= end_dt)
                )
            except ValueError:
                return {"error": "Invalid date format. Use YYYY-MM-DD."}
        
        # CASE C: Time-Only (Recurring Daily Window)
        elif startTime and endTime:
            try:
                fmt_start = "%H:%M:%S" if len(startTime) > 5 else "%H:%M"
                fmt_end = "%H:%M:%S" if len(endTime) > 5 else "%H:%M"
                start_t = datetime.strptime(startTime, fmt_start).time()
                end_t = datetime.strptime(endTime, fmt_end).time()
                df = df.filter(
                    (pl.col("dateTime").dt.time() >= start_t) & 
                    (pl.col("dateTime").dt.time() <= end_t)
                )
            except ValueError:
                return {"error": "Invalid time format. Use HH:MM or HH:MM:SS."}


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
    
    # Step 6: Inject timeframe (always)
    if timeframe:
        df = df.with_columns(pl.lit(timeframe).alias("timeframe"))
    
    # Inject updatedBy for indicators
    if updatedBy and "updatedBy" not in df.columns:
        df = df.with_columns(pl.lit(updatedBy).alias("updatedBy"))

    # Level 1/2/3 Script Logic Fallback & Phase 1 Smart Parsing
    if dataType == "options":
        # User requirement: Store script as integer if possible for calculations.
        # Clean numeric script values (remove ".0" from float inference)
        if "script" in df.columns:
            df = df.with_columns(
                pl.col("script").cast(pl.Utf8)
                .str.replace(r"\.0$", "", literal=False)
                .alias("script")
            )
        else:
            # Fallback if no script column is mapped
            if manualScript and manualScript.strip():
                script_val = manualScript.strip()
            else:
                script_val = re.sub(r'\.(csv|xlsx)$', '', file.filename, flags=re.IGNORECASE).replace('_', ' ')
            df = df.with_columns(pl.lit(script_val).alias("script"))
            
        # Regex Extraction of Strike
        def extract_strike(s):
            if s:
                m = re.search(r'(\d{4,5})', str(s))
                if m: return int(m.group(1))
            return None
            
        df = df.with_columns(
            pl.col("script").map_elements(extract_strike, return_dtype=pl.Int64).alias("strike")
        )
        
        # Automated Lot Size logic
        if manualLotSize and manualLotSize.isdigit():
            df = df.with_columns(pl.lit(int(manualLotSize)).alias("lot_size"))
        else:
            def extract_lot(st):
                if not st: return 1
                st_upper = str(st).upper()
                if "BANKNIFTY" in st_upper: return 15
                if "NIFTY" in st_upper: return 65
                if "SENSEX" in st_upper: return 20
                return 1
                
            df = df.with_columns(
                pl.col("stock").map_elements(extract_lot, return_dtype=pl.Int64).alias("lot_size")
            )

    # Step 6: Map dataType to model class
    table_map = {
        "options": OptionsData,
        "indicator": IndicatorData,
    }
    TargetModel = table_map.get(dataType)
    if not TargetModel:
        return {"error": f"Invalid dataType '{dataType}'. Must be: spot, options, indicator."}

    records = df.to_dicts()
    if not records:
        return {"error": "No records to insert after filtering. Check date range or file content."}

    # --- BULK DUPLICATE CHECK LOGIC ---
    existing_keys = set()
    skipped_count = 0
    try:
        # Extract min and max dates directly from the records to scope the DB query
        valid_records = [r for r in records if r.get("dateTime")]
        if valid_records:
            min_dt = min(r["dateTime"] for r in valid_records)
            max_dt = max(r["dateTime"] for r in valid_records)

            if dataType == "indicator":
                statement = select(IndicatorData.dateTime, IndicatorData.stock, IndicatorData.timeframe, IndicatorData.indicatorName).where(
                    IndicatorData.dateTime >= min_dt, IndicatorData.dateTime <= max_dt
                )
                existing_records = session.exec(statement).all()
                existing_keys = {(r[0], r[1], r[2], r[3]) for r in existing_records}
                
            elif dataType == "options":
                statement = select(OptionsData.dateTime, OptionsData.stock, OptionsData.script, OptionsData.type, OptionsData.expiry).where(
                    OptionsData.dateTime >= min_dt, OptionsData.dateTime <= max_dt
                )
                existing_records = session.exec(statement).all()
                existing_keys = {(r[0], r[1], r[2], r[3], r[4]) for r in existing_records}
    except Exception as e:
        return {"error": f"Failed during duplicate check query: {str(e)}"}

    # Step 7: Create model instances.
    # IMPORTANT: Always inject a fresh UUID for 'id' — never rely on source data
    # having an id column. This prevents primary key constraint violations.
    instances = []
    for record in records:
        dt = record.get("dateTime")
        
        # Build the composite key for the current row
        if dataType == "indicator":
            key = (dt, record.get("stock"), record.get("timeframe"), record.get("indicatorName"))
        elif dataType == "options":
            key = (dt, record.get("stock"), record.get("script"), record.get("type"), record.get("expiry"))
        else:
            key = None
            
        # Check if key exists in the database already
        if key and key in existing_keys:
            skipped_count += 1
            continue

        record["id"] = str(uuid.uuid4())
        record["updated_on"] = ingestion_time  # Inject system datetime

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
    if instances:
        try:
            session.add_all(instances)
            session.commit()
        except Exception as e:
            session.rollback()
            return {"error": f"Database insert failed: {str(e)}"}

    msg = f"Successfully ingested {len(instances)} rows into {dataType} table."
    if skipped_count > 0:
        msg += f" (Skipped {skipped_count} duplicate rows)"

    return {
        "message": msg,
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
    # Filter out empty/null and sort alphabetically
    unique_names = sorted([name for name in results if name])
    return {"indicators": unique_names}


# ---------------------------------------------------------------------------
# Endpoint: Preview filtered data
# ---------------------------------------------------------------------------
@router.post("/preview")
async def preview_data(
    file: UploadFile = File(...),
    mappings: str = Form(...),
    dataType: str = Form(...),
    startDate: str = Form(None),
    endDate: str = Form(None),
    startTime: str = Form(None),
    endTime: str = Form(None),
    exchange: str = Form(None),
    stock: str = Form(None),
    optionType: str = Form(None),
    expiry: str = Form(None),
    indicatorName: str = Form(None),
    manualScript: str = Form(None),
    manualLotSize: str = Form(None),
    timeframe: str = Form("1m"),
    updatedBy: str = Form(None)
):

    contents = await file.read()
    try:
        if file.filename.endswith(".csv"):
            df = pl.read_csv(io.BytesIO(contents), infer_schema_length=0)
        else:
            df = pl.read_excel(io.BytesIO(contents))
    except Exception as e:
        return {"error": f"Could not read file: {str(e)}"}

    mapping_dict = json.loads(mappings)
    rename_map = {k: v for k, v in mapping_dict.items() if k in df.columns and v}
    
    # Robust Renaming: Drop original columns if they conflict with target names and weren't mapped
    target_names = set(rename_map.values())
    cols_to_drop = [c for c in df.columns if c in target_names and c not in rename_map.keys()]
    if cols_to_drop:
        df = df.drop(cols_to_drop)

    df = df.rename(rename_map)

    min_date, max_date, min_time, max_time = None, None, None, None
    unique_dates = []
    unique_times = []

    if "dateTime" in df.columns:
        df = df.with_columns(
            _try_parse_datetime(df["dateTime"].cast(pl.Utf8)).alias("dateTime")
        )
        # Protect against crash if parsing failed (column remains Utf8)
        if df["dateTime"].dtype in (pl.Datetime, pl.Date):
            valid_dates = df.filter(pl.col("dateTime").is_not_null())["dateTime"]
            if len(valid_dates) > 0:
                unique_dates_series = valid_dates.dt.date().unique().sort()
                unique_times_series = valid_dates.dt.time().unique().sort()
                unique_dates = [d.strftime("%Y-%m-%d") for d in unique_dates_series if d is not None]
                unique_times = [t.strftime("%H:%M:%S") for t in unique_times_series if t is not None]

                min_dt = valid_dates.min()
                max_dt = valid_dates.max()
                min_date = min_dt.strftime("%Y-%m-%d")
                max_date = max_dt.strftime("%Y-%m-%d")
                min_time = min_dt.strftime("%H:%M:%S")
                max_time = max_dt.strftime("%H:%M:%S")

            # Create Virtual Columns for the UI preview table
            df = df.with_columns(
                pl.col("dateTime").dt.strftime("%Y-%m-%d").alias("Calculated_Date"),
                pl.col("dateTime").dt.strftime("%H:%M:%S").alias("Calculated_Time")
            )
        else:
            # Fallback if parsing fails
            pass

        # Apply Filters (Same Logic as Ingest)
        if startDate and endDate and startTime and endTime and df["dateTime"].dtype in (pl.Datetime, pl.Date):
            try:
                fmt_start = "%H:%M:%S" if len(startTime) > 5 else "%H:%M"
                fmt_end = "%H:%M:%S" if len(endTime) > 5 else "%H:%M"
                start_val = datetime.strptime(f"{startDate} {startTime}", f"%Y-%m-%d {fmt_start}")
                end_val = datetime.strptime(f"{endDate} {endTime}", f"%Y-%m-%d {fmt_end}")
                df = df.filter((pl.col("dateTime") >= start_val) & (pl.col("dateTime") <= end_val))
            except ValueError: pass
        elif startDate and endDate and df["dateTime"].dtype in (pl.Datetime, pl.Date):
            try:
                start_dt = datetime.strptime(startDate, "%Y-%m-%d").date()
                end_dt = datetime.strptime(endDate, "%Y-%m-%d").date()
                df = df.filter((pl.col("dateTime").dt.date() >= start_dt) & (pl.col("dateTime").dt.date() <= end_dt))
            except ValueError: pass
        elif startTime and endTime and df["dateTime"].dtype in (pl.Datetime, pl.Date):
            try:
                fmt_start = "%H:%M:%S" if len(startTime) > 5 else "%H:%M"
                fmt_end = "%H:%M:%S" if len(endTime) > 5 else "%H:%M"
                start_t = datetime.strptime(startTime, fmt_start).time()
                end_t = datetime.strptime(endTime, fmt_end).time()
                df = df.filter((pl.col("dateTime").dt.time() >= start_t) & (pl.col("dateTime").dt.time() <= end_t))
            except ValueError: pass


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
    
    # Inject timeframe
    if timeframe:
        df = df.with_columns(pl.lit(timeframe).alias("timeframe"))
        
    if updatedBy and "updatedBy" not in df.columns:
        df = df.with_columns(pl.lit(updatedBy).alias("updatedBy"))

    if dataType == "options":
        if "script" not in df.columns:
            if manualScript and manualScript.strip():
                script_val = manualScript.strip()
            else:
                script_val = re.sub(r'\.(csv|xlsx)$', '', file.filename, flags=re.IGNORECASE).replace('_', ' ')
            df = df.with_columns(pl.lit(script_val).alias("script"))
            
        def extract_strike(s):
            if s:
                m = re.search(r'(\d{4,5})', str(s))
                if m: return int(m.group(1))
            return None
            
        df = df.with_columns(
            pl.col("script").map_elements(extract_strike, return_dtype=pl.Int64).alias("strike")
        )
        
        if manualLotSize and manualLotSize.isdigit():
            df = df.with_columns(pl.lit(int(manualLotSize)).alias("lot_size"))
        else:
            def extract_lot(st):
                if not st: return 1
                st_upper = str(st).upper()
                if "BANKNIFTY" in st_upper: return 15
                if "NIFTY" in st_upper: return 65
                if "SENSEX" in st_upper: return 20
                return 1
                
            df = df.with_columns(
                pl.col("stock").map_elements(extract_lot, return_dtype=pl.Int64).alias("lot_size")
            )

    if "dateTime" in df.columns:
        df = df.with_columns(pl.col("dateTime").cast(pl.Utf8))
        
    preview_data = df.head(50).to_dicts()

    return {
        "min_date": min_date,
        "max_date": max_date,
        "min_time": min_time,
        "max_time": max_time,
        "unique_dates": unique_dates,
        "unique_times": unique_times,
        "preview": preview_data,
        "total_rows_after_filter": len(df)
    }
