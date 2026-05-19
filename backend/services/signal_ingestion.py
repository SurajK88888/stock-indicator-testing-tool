import uuid
import io
import json
import re
from datetime import datetime, timedelta, date

import polars as pl
from fastapi import APIRouter, UploadFile, File, Form, Depends
from sqlmodel import Session, select

from database import get_session
from models import SignalData
from services.ingestion import _try_parse_datetime

router = APIRouter(prefix="/api/signals", tags=["signals"])


def get_next_weekday(base_date: date, target_weekday: int) -> date:
    """
    Returns the date of the next occurrence of a target weekday (0=Mon, 1=Tue... 6=Sun)
    after or on the base_date.
    """
    days_ahead = target_weekday - base_date.weekday()
    if days_ahead < 0:
        days_ahead += 7
    return base_date + timedelta(days_ahead)


@router.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    """
    Reads the file, extracts headers and returns them plus top 10 rows.
    Reuses the exact same logic as indicator data upload.
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


@router.post("/ingest")
async def ingest_signals(
    file: UploadFile = File(...),
    mappings: str = Form(...),      # JSON: {"FileHeader": "dbField", ...}
    signal_provider: str = Form(...),
    exchange: str = Form(None),
    stock: str = Form(None),
    # date_format / time_format intentionally removed: backend auto-detects via DATETIME_FORMATS list.
    # The user only needs to map the Date and Time column headers; no manual format entry required.
    entry_type_static: str = Form("Buy At"),
    sl_type: str = Form("Points"),
    tp_type: str = Form("Points"),
    buy_value: str = Form(""),
    sell_value: str = Form(""),
    ce_value: str = Form(""),
    pe_value: str = Form(""),
    updatedBy: str = Form(None),
    session: Session = Depends(get_session)
):
    """
    Ingests Signal Data, with specific translation logic and fallback logic.
    """
    contents = await file.read()
    try:
        if file.filename.endswith(".csv"):
            df = pl.read_csv(io.BytesIO(contents), infer_schema_length=0)
        else:
            # infer_schema_length=0 forces ALL columns to be read as strings.
            # This is critical for Excel files where Date/Time cells would
            # otherwise be converted to native Python datetime/time objects with
            # the Excel epoch (1899-12-31) embedded. Reading as strings gives us
            # consistent text values that our _try_parse_datetime handles.
            df = pl.read_excel(io.BytesIO(contents), infer_schema_length=0)
    except Exception as e:
        return {"error": f"Could not read file: {str(e)}"}

    ingestion_time = datetime.now()

    # Step 1: Header Mapping
    mapping_dict = json.loads(mappings)
    rename_map = {k: v for k, v in mapping_dict.items() if k in df.columns and v}
    
    # Drop conflicts
    target_names = set(rename_map.values())
    cols_to_drop = [c for c in df.columns if c in target_names and c not in rename_map.keys()]
    if cols_to_drop:
        df = df.drop(cols_to_drop)

    df = df.rename(rename_map)

    # Step 2: DateTime Merge & Parsing
    # ---------------------------------------------------------------------------
    # KNOWN BUG FIXED: When Polars reads an Excel file, time-only cells are
    # returned as '1899-12-31 HH:MM:SS' (Excel's internal serial origin date).
    # Similarly, date-only cells arrive as '2026-04-01 00:00:00'.
    # Naively concatenating these produces an unparseable string like:
    #   "2026-04-01 00:00:00 1899-12-31 09:15:00"
    # Fix: extract only the date part from the 'date' column and only the time
    # part from the 'time' column before merging, then parse the clean combo.
    # REUSABLE: Use this pattern for any Excel file with separate date/time cols.
    # ---------------------------------------------------------------------------
    if "date" in df.columns and "time" in df.columns and "dateTime" not in df.columns:
        # Extract only the date portion (first 10 chars: YYYY-MM-DD)
        # Works whether the value is '2026-04-01' or '2026-04-01 00:00:00'
        date_clean = pl.col("date").cast(pl.Utf8).str.slice(0, 10)
        # Strip Excel epoch-date prefix from time values.
        # When Polars reads an Excel file with infer_schema_length=0, time-only
        # cells become '1899-12-31 09:15:00' (or '1899-12-31T09:15:00').
        # We remove the '1899-12-31 ' or '1899-12-31T' prefix if present.
        # Falls back to the original string for plain CSV 'HH:MM' / 'HH:MM:SS'.
        time_clean = (
            pl.col("time").cast(pl.Utf8)
            .str.replace(r"^1899-12-31[T ]?", "", literal=False)
        )
        df = df.with_columns(
            pl.concat_str([date_clean, time_clean], separator=" ").alias("dateTime")
        )

    if "dateTime" in df.columns:
        df = df.with_columns(
            _try_parse_datetime(df["dateTime"].cast(pl.Utf8)).alias("dateTime")
        )
        
        # Verify that parsing actually succeeded for at least one format
        if df["dateTime"].dtype not in (pl.Datetime, pl.Date):
            return {"error": "All rows failed datetime parsing. Check that the Date/Time formats are correct."}

        # Drop rows where dateTime failed
        df = df.filter(pl.col("dateTime").is_not_null())
        if df.is_empty():
            return {"error": "All rows failed datetime parsing. Check that the Date/Time formats are correct."}

        # Ensure separate date and time columns exist (always overwrite from the
        # parsed dateTime so they are clean YYYY-MM-DD / HH:MM:SS strings)
        df = df.with_columns([
            pl.col("dateTime").dt.strftime("%Y-%m-%d").alias("date"),
            pl.col("dateTime").dt.strftime("%H:%M:%S").alias("time"),
        ])
    else:
        return {"error": "Missing DateTime or Date+Time mapping. Cannot ingest signals without a timeline."}


    # Step 3: Type Casting for Numerics
    numeric_cols = ["script", "entry_price", "sl", "target_1", "target_2", "target_3", "target_4", "target_5", "target_6", "target_7", "target_8", "target_9", "target_10"]
    for col in numeric_cols:
        if col in df.columns:
            dtype = pl.Int64 if col == "script" else pl.Float64
            df = df.with_columns(
                pl.col(col).cast(dtype, strict=False).alias(col)
            )

    # Drop rows where mandatory numerics failed
    for m_col in ["script", "entry_price", "sl", "target_1"]:
        if m_col in df.columns:
            df = df.filter(pl.col(m_col).is_not_null())

    if df.is_empty():
        return {"error": "All rows failed numeric parsing (check script, entry_price, sl, target_1)."}

    # Step 4: Translation Engine (Signal and Option Type)
    if "signal" in df.columns:
        # Map user's buy/sell text to standard Buy/Sell
        df = df.with_columns(
            pl.when(pl.col("signal").str.to_lowercase() == str(buy_value).lower()).then(pl.lit("Buy"))
            .when(pl.col("signal").str.to_lowercase() == str(sell_value).lower()).then(pl.lit("Sell"))
            .otherwise(pl.col("signal"))
            .alias("signal")
        )

    if "type" in df.columns:
        df = df.with_columns(
            pl.when(pl.col("type").str.to_lowercase() == str(ce_value).lower()).then(pl.lit("Call"))
            .when(pl.col("type").str.to_lowercase() == str(pe_value).lower()).then(pl.lit("Put"))
            .otherwise(pl.col("type"))
            .alias("type")
        )

    # Step 4b: Normalise Exchange & Stock column values
    # ---------------------------------------------------------------------------
    # Problem: Excel files often have mixed casing ('Nifty', 'NIFTY', 'nifty')
    # and non-breaking spaces (U+00A0, '\xa0') in text cells, e.g. 'NIFTY\xa0'.
    # Normalisation ensures all values are stored in a consistent format so that
    # filtering, deduplication, and downstream queries work reliably.
    # Strategy:
    #   1. Cast to string (handles any residual typed columns)
    #   2. Replace Unicode non-breaking spaces (U+00A0) with regular spaces
    #   3. Strip all leading/trailing whitespace
    #   4. Convert to UPPERCASE for canonical storage
    # REUSABLE: Apply this pattern to any categorical text column before storage.
    # ---------------------------------------------------------------------------
    def _normalise_text_col(col_name: str, df):
        """Strip whitespace (incl. NBSP) and uppercase a string column in-place."""
        return df.with_columns(
            pl.col(col_name).cast(pl.Utf8)
            .str.replace_all("\u00A0", " ", literal=True)  # NBSP → regular space
            .str.strip_chars()                              # strip leading/trailing ws
            .str.to_uppercase()                             # canonical uppercase
            .alias(col_name)
        )

    if "exchange" in df.columns:
        df = _normalise_text_col("exchange", df)
    if "stock" in df.columns:
        df = _normalise_text_col("stock", df)

    # Step 5: Exchange & Stock — Filter-or-Fallback Pattern
    # ---------------------------------------------------------------------------
    # DESIGN: The Exchange and Stock UI dropdowns serve a DUAL purpose:
    #   - If the file has an Exchange/Stock column (mapped via header) →
    #     use the file's own values (no override). The dropdown value acts as
    #     a ROW FILTER: only rows matching the selected exchange/stock are imported.
    #   - If the file has NO Exchange/Stock column →
    #     the dropdown value is injected as a constant fallback for all rows.
    # After Step 4b normalisation both the column values and the filter strings
    # are uppercase+stripped, so comparison is a direct equality check.
    # REUSABLE: Apply this filter-or-fallback pattern to any similar metadata field.
    # ---------------------------------------------------------------------------
    if "exchange" in df.columns:
        # File has exchange data — filter rows matching the selected exchange
        if exchange:
            df = df.filter(pl.col("exchange") == exchange.strip().upper())
    else:
        # No exchange column — inject selected value as constant fallback
        if exchange:
            df = df.with_columns(pl.lit(exchange.strip().upper()).alias("exchange"))

    if "stock" in df.columns:
        # File has stock data — filter rows matching the selected stock
        if stock:
            df = df.filter(pl.col("stock") == stock.strip().upper())
    else:
        # No stock column — inject selected value as constant fallback
        if stock:
            df = df.with_columns(pl.lit(stock.strip().upper()).alias("stock"))
        
    df = df.with_columns([
        pl.lit(signal_provider).alias("signal_provider"),
        pl.lit(sl_type).alias("sl_type"),
        pl.lit(tp_type).alias("tp_type")
    ])

    if updatedBy and "updatedBy" not in df.columns:
        df = df.with_columns(pl.lit(updatedBy).alias("updatedBy"))

    # Convert to dicts for row-level logic and DB insertion
    records = df.to_dicts()

    # Bulk duplicate check: (signal_provider, dateTime, stock, script, type, expiry)
    min_dt = min(r["dateTime"] for r in records)
    max_dt = max(r["dateTime"] for r in records)
    statement = select(SignalData.signal_provider, SignalData.dateTime, SignalData.stock, SignalData.script, SignalData.type, SignalData.expiry).where(
        SignalData.dateTime >= min_dt, SignalData.dateTime <= max_dt
    )
    existing_records = session.exec(statement).all()
    existing_keys = {(r[0], r[1], r[2], r[3], r[4], r[5]) for r in existing_records}

    instances = []
    skipped_count = 0

    for record in records:
        # ROW-LEVEL DEFAULT LOGIC
        
        # 1. Entry Type Fallback
        if not record.get("entry_type"):
            record["entry_type"] = entry_type_static

        # 2. Trade Type Fallback
        if not record.get("trade_type"):
            record["trade_type"] = "Intraday"
            
        # 3. Expiry Fallback (Smart Weekday Calculation)
        if not record.get("expiry"):
            row_date = record.get("dateTime").date()
            exch = str(record.get("exchange")).upper()
            if exch == "NSE":
                # Tuesday = 1
                next_tue = get_next_weekday(row_date, 1)
                record["expiry"] = next_tue.strftime("%Y-%m-%d")
            elif exch == "BSE":
                # Thursday = 3
                next_thu = get_next_weekday(row_date, 3)
                record["expiry"] = next_thu.strftime("%Y-%m-%d")
            else:
                record["expiry"] = None

        key = (
            record.get("signal_provider"),
            record.get("dateTime"),
            record.get("stock"),
            record.get("script"),
            record.get("type"),
            record.get("expiry")
        )

        if key in existing_keys:
            skipped_count += 1
            continue

        record["id"] = str(uuid.uuid4())
        record["updated_on"] = ingestion_time

        try:
            instances.append(SignalData(**{
                k: v for k, v in record.items()
                if k in SignalData.__fields__
            }))
        except Exception as e:
            continue

    if instances:
        try:
            session.add_all(instances)
            session.commit()
        except Exception as e:
            session.rollback()
            return {"error": f"Database insert failed: {str(e)}"}

    msg = f"Successfully ingested {len(instances)} signals."
    if skipped_count > 0:
        msg += f" (Skipped {skipped_count} duplicate signals)"

    return {
        "message": msg,
        "count": len(instances)
    }


@router.get("/providers")
def get_signal_providers(session: Session = Depends(get_session)):
    """
    Returns distinct signal_provider values.
    """
    statement = select(SignalData.signal_provider).distinct()
    results = session.exec(statement).all()
    unique_names = sorted([name for name in results if name])
    return {"providers": unique_names}
