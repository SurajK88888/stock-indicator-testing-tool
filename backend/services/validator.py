"""
services/validator.py — Backtesting validation engine.

ARCHITECTURE:
- Accepts a JSON body (Pydantic model) — NOT query params — for POST endpoint compatibility.
- Uses FastAPI BackgroundTasks to run heavy computation without blocking the request.
  The endpoint returns immediately with a jobId; client polls /api/validate/status/{jobId}.
- Implements the "Anchor & Offset" ATM algorithm from the spec:
    1. Find buy signal in IndicatorData.
    2. Query SpotData for the index price at that exact dateTime.
    3. Round spot price to nearest interval (configurable: Closest/Floor/Ceiling).
    4. Apply ATM offset (ATM+ adds, ATM- subtracts).
    5. Look up OptionsData for the target strike at that time.
    6. Find the next sell signal and compute P&L.

REUSABLE PATTERNS:
- Pydantic request body with defaults: clean, self-documenting API contracts.
- In-memory job store (jobs dict): lightweight async result tracking without Redis.
  Replace with Redis/Celery for production scaling.
- "Data Gap" detection: missing strikes are reported as errors, not silent skips.
- "Next Candle" logic: uses >= dateTime and .first() to find the chronologically
  next available record, handling gaps in data correctly.

KNOWN BUG AVOIDED: Do not use router.post() with plain positional query params for
a POST endpoint — FastAPI expects a request body (Pydantic model) or Form fields.
Using plain function params on a POST causes 422 Unprocessable Entity errors.
"""

import json
import uuid
from enum import Enum
from typing import Optional
from datetime import datetime

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from database import get_session
from models import SpotData, OptionsData, IndicatorData, ValidationReport

router = APIRouter(prefix="/api", tags=["validator"])

# ---------------------------------------------------------------------------
# In-memory job store for async validation results.
# Key: jobId (str), Value: {"status": "pending"|"done"|"error", "result": {...}}
# REUSABLE: This pattern works for any long-running background API task.
# ---------------------------------------------------------------------------
_jobs: dict = {}


class RoundingMethod(str, Enum):
    """
    ATM rounding strategy for identifying the base ATM strike.
    - closest: Round to nearest interval (standard).
    - floor: Always round down (In-The-Money bias for Calls).
    - ceiling: Always round up.
    """
    closest = "closest"
    floor = "floor"
    ceiling = "ceiling"


class ValidateRequest(BaseModel):
    """
    Request body for POST /api/validate.
    All fields map directly to the Indicator Validator form in the frontend.
    """
    stock: str                              # e.g. "NIFTY"
    indicatorName: str                      # Must exist in IndicatorData table
    offsetType: str                         # "ATM", "ATM+", or "ATM-"
    offsetValue: int = 0                    # e.g. 100; ignored when offsetType == "ATM"
    interval: int = 50                      # 50 for NIFTY, 100 for BANKNIFTY
    roundingMethod: RoundingMethod = RoundingMethod.closest
    entrySignal: str = "Buy"               # "Buy" or "Sell"
    exitSignal: str = "Sell"               # "Buy" or "Sell"
    entryTiming: str = "Next Candle"       # "At Signal" or "Next Candle"
    exitTiming: str = "At Signal"          # "At Signal" or "Next Candle"
    entryPoint: str = "Open"              # "Open", "High", "Low", "Close"
    exitPoint: str = "Close"              # "Open", "High", "Low", "Close"
    startDate: Optional[str] = None        # "YYYY-MM-DD" filter
    endDate: Optional[str] = None          # "YYYY-MM-DD" filter


def _get_price_by_point(record: OptionsData, point: str) -> int:
    """Returns the correct OHLC price field based on the user's 'entryPoint'/'exitPoint' selection."""
    mapping = {
        "Open": record.open,
        "High": record.high,
        "Low": record.low,
        "Close": record.close,
    }
    return mapping.get(point, record.close)


def _round_atm(spot_price: float, interval: int, method: RoundingMethod) -> int:
    """
    Calculates the base ATM strike from the spot price.
    REUSABLE: This is the core of the 'Anchor & Offset' algorithm.
    - closest: Standard rounding to nearest interval.
    - floor: Largest multiple of interval ≤ spot (ITM bias for Calls).
    - ceiling: Smallest multiple of interval ≥ spot.
    """
    if method == RoundingMethod.floor:
        return int((spot_price // interval) * interval)
    elif method == RoundingMethod.ceiling:
        import math
        return int(math.ceil(spot_price / interval) * interval)
    else:  # closest (default)
        return int(round(spot_price / interval) * interval)


def _run_validation(job_id: str, req: ValidateRequest, db_url: str):
    """
    Core validation engine — runs as a background task.
    Uses its own database session (BackgroundTasks run outside the request lifecycle).
    """
    from sqlmodel import create_engine
    from sqlalchemy import event

    engine = create_engine(db_url, connect_args={"check_same_thread": False})
    with Session(engine) as session:
        _jobs[job_id]["status"] = "running"

        # Build signal query (buy or sell entry)
        buy_col = IndicatorData.buySignal if req.entrySignal == "Buy" else IndicatorData.sellSignal
        signal_stmt = select(IndicatorData).where(
            IndicatorData.stock == req.stock,
            IndicatorData.indicatorName == req.indicatorName,
            buy_col == 1
        ).order_by(IndicatorData.dateTime)

        # Optional date filter
        if req.startDate and req.endDate:
            try:
                start_dt = datetime.strptime(req.startDate, "%Y-%m-%d")
                end_dt = datetime.strptime(req.endDate, "%Y-%m-%d")
                signal_stmt = signal_stmt.where(
                    IndicatorData.dateTime >= start_dt,
                    IndicatorData.dateTime <= end_dt
                )
            except ValueError:
                pass

        signals = session.exec(signal_stmt).all()

        if not signals:
            _jobs[job_id] = {
                "status": "error",
                "result": {"error": "No signals found for the given criteria. Verify indicatorName and stock."}
            }
            return

        trades = []
        data_gaps = []
        total_profit = 0.0
        wins = 0

        for signal in signals:
            # ---------------------------------------------------------------
            # Step 1: Get Spot Price at signal dateTime
            # ---------------------------------------------------------------
            spot_stmt = select(SpotData).where(
                SpotData.stock == req.stock,
                SpotData.dateTime == signal.dateTime
            )
            spot_record = session.exec(spot_stmt).first()

            if not spot_record:
                # "Data Gap" — spec: report this rather than silently skipping
                data_gaps.append({
                    "type": "missing_spot_price",
                    "dateTime": signal.dateTime.isoformat()
                })
                continue

            spot_price = spot_record.price / 100.0

            # ---------------------------------------------------------------
            # Step 2: Calculate target strike using Anchor & Offset algorithm
            # ---------------------------------------------------------------
            base_atm = _round_atm(spot_price, req.interval, req.roundingMethod)

            if req.offsetType == "ATM+":
                target_strike = base_atm + req.offsetValue
            elif req.offsetType == "ATM-":
                target_strike = base_atm - req.offsetValue
            else:  # "ATM" — strict ATM, no offset
                target_strike = base_atm

            # ---------------------------------------------------------------
            # Step 3: Find Entry record in OptionsData
            # "At Signal": use == dateTime; "Next Candle": use >= dateTime and .first()
            # This handles data gaps correctly — always takes the next AVAILABLE record.
            # ---------------------------------------------------------------
            if req.entryTiming == "At Signal":
                option_stmt = select(OptionsData).where(
                    OptionsData.stock == req.stock,
                    OptionsData.script.contains(str(int(target_strike))),
                    OptionsData.dateTime == signal.dateTime
                )
            else:  # Next Candle
                option_stmt = select(OptionsData).where(
                    OptionsData.stock == req.stock,
                    OptionsData.script.contains(str(int(target_strike))),
                    OptionsData.dateTime > signal.dateTime
                ).order_by(OptionsData.dateTime)

            entry_record = session.exec(option_stmt).first()

            if not entry_record:
                # "Data Gap" — spec: report missing strike rather than calculating wrong P&L
                data_gaps.append({
                    "type": "missing_strike_in_options",
                    "targetStrike": target_strike,
                    "signalDateTime": signal.dateTime.isoformat(),
                    "note": f"Script containing '{int(target_strike)}' not found near this time."
                })
                continue

            # ---------------------------------------------------------------
            # Step 4: Find Exit signal
            # ---------------------------------------------------------------
            exit_buy_col = IndicatorData.sellSignal if req.exitSignal == "Sell" else IndicatorData.buySignal
            exit_signal_stmt = select(IndicatorData).where(
                IndicatorData.stock == req.stock,
                IndicatorData.indicatorName == req.indicatorName,
                exit_buy_col == 1,
                IndicatorData.dateTime > entry_record.dateTime
            ).order_by(IndicatorData.dateTime)

            exit_signal = session.exec(exit_signal_stmt).first()

            if not exit_signal:
                continue  # No exit found for this trade — open trade, skip

            # ---------------------------------------------------------------
            # Step 5: Find Exit record in OptionsData (same script as entry)
            # ---------------------------------------------------------------
            if req.exitTiming == "At Signal":
                exit_opt_stmt = select(OptionsData).where(
                    OptionsData.script == entry_record.script,
                    OptionsData.dateTime == exit_signal.dateTime
                )
            else:  # Next Candle
                exit_opt_stmt = select(OptionsData).where(
                    OptionsData.script == entry_record.script,
                    OptionsData.dateTime > exit_signal.dateTime
                ).order_by(OptionsData.dateTime)

            exit_record = session.exec(exit_opt_stmt).first()

            if not exit_record:
                data_gaps.append({
                    "type": "missing_exit_record",
                    "script": entry_record.script,
                    "exitSignalTime": exit_signal.dateTime.isoformat()
                })
                continue

            # ---------------------------------------------------------------
            # Step 6: Calculate P&L using the selected entry/exit price points
            # ---------------------------------------------------------------
            entry_price = _get_price_by_point(entry_record, req.entryPoint) / 100.0
            exit_price = _get_price_by_point(exit_record, req.exitPoint) / 100.0
            profit = exit_price - entry_price

            total_profit += profit
            if profit > 0:
                wins += 1

            trades.append({
                "entryTime": entry_record.dateTime.isoformat(),
                "exitTime": exit_record.dateTime.isoformat(),
                "strike": target_strike,
                "entryPrice": entry_price,
                "exitPrice": exit_price,
                "profit": round(profit, 2)
            })

        win_rate = (wins / len(trades)) * 100 if trades else 0.0

        # Persist the report
        config_dict = {
            "stock": req.stock,
            "indicatorName": req.indicatorName,
            "offsetType": req.offsetType,
            "offsetValue": req.offsetValue,
            "interval": req.interval,
            "roundingMethod": req.roundingMethod,
        }
        report = ValidationReport(
            config=json.dumps(config_dict),
            totalProfit=int(total_profit * 100),
            winRate=win_rate,
            trades=json.dumps(trades)
        )
        session.add(report)
        session.commit()
        session.refresh(report)

        _jobs[job_id] = {
            "status": "done",
            "result": {
                "reportId": report.id,
                "totalProfit": round(total_profit, 2),
                "winRate": round(win_rate, 2),
                "totalTrades": len(trades),
                "trades": trades,
                "dataGaps": data_gaps  # Spec: return data gaps instead of silent skips
            }
        }


# ---------------------------------------------------------------------------
# Endpoint: POST /api/validate — Accepts JSON body, dispatches background task.
# Returns immediately with a jobId. Client polls GET /api/validate/status/{jobId}.
# This prevents frontend timeouts on large datasets (requirement: background tasks).
# ---------------------------------------------------------------------------
@router.post("/validate")
def start_validation(
    req: ValidateRequest,
    background_tasks: BackgroundTasks,
    session: Session = Depends(get_session)
):
    """
    Kicks off the validation engine as a background task.
    Returns a jobId immediately so the frontend does not time out.
    """
    from database import sqlite_url  # import the configured URL

    job_id = str(uuid.uuid4())
    _jobs[job_id] = {"status": "pending", "result": None}

    background_tasks.add_task(_run_validation, job_id, req, sqlite_url)

    return {"jobId": job_id, "status": "pending"}


# ---------------------------------------------------------------------------
# Endpoint: GET /api/validate/status/{job_id} — Poll for validation results.
# ---------------------------------------------------------------------------
@router.get("/validate/status/{job_id}")
def get_validation_status(job_id: str):
    """
    Returns the current status and result of a validation job.
    status values: "pending" | "running" | "done" | "error"
    """
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found.")
    return job
