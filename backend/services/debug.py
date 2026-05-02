"""
services/debug.py — Read-only diagnostic endpoints for the Stock Indicator Testing Tool.

PURPOSE:
- Helps diagnose data mismatches between OptionsData and IndicatorData tables.
- Purely additive: no writes, no changes to existing logic.
- REUSABLE: This pattern (data overlap check) is useful in any system where two tables
  must share matching timestamps for a join/lookup to succeed.

REMOVE in production if not needed, or guard behind an auth check.
"""

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlmodel import Session, select, func

from database import get_session
from models import OptionsData, IndicatorData

router = APIRouter(prefix="/api/debug", tags=["debug"])


@router.get("/data-check")
def check_data_overlap(
    stock: str = Query(..., description="e.g. NIFTY"),
    indicator_name: str = Query(..., description="e.g. TEST01"),
    start_date: str = Query(None, description="YYYY-MM-DD"),
    end_date: str = Query(None, description="YYYY-MM-DD"),
    session: Session = Depends(get_session),
):
    """
    Diagnostic endpoint: checks how many rows exist in OptionsData and IndicatorData
    for the given stock/indicator/date range, and finds signal timestamps that have
    NO matching options row — the root cause of 'missing_options_data' data gaps.

    REUSABLE: Adapt this pattern for any two-table timestamp alignment check.
    """
    start_dt = datetime.strptime(start_date, "%Y-%m-%d") if start_date else None
    end_dt = datetime.strptime(end_date + " 23:59:59", "%Y-%m-%d %H:%M:%S") if end_date else None

    # ── Options Data summary ─────────────────────────────────────────────────
    opt_stmt = select(OptionsData).where(OptionsData.stock == stock)
    if start_dt:
        opt_stmt = opt_stmt.where(OptionsData.dateTime >= start_dt)
    if end_dt:
        opt_stmt = opt_stmt.where(OptionsData.dateTime <= end_dt)
    opt_records = session.exec(opt_stmt).all()

    opt_with_strike = [r for r in opt_records if r.strike is not None]
    opt_sample_times = sorted(set(r.dateTime.isoformat() for r in opt_records[:5]))
    opt_sample_scripts = list(set(r.script for r in opt_records[:20] if r.script))[:5]
    opt_sample_types = list(set(r.type for r in opt_records if r.type))

    # ── Indicator Signal Data summary ────────────────────────────────────────
    ind_stmt = select(IndicatorData).where(
        IndicatorData.stock == stock,
        IndicatorData.indicatorName == indicator_name,
        ((IndicatorData.buySignal == 1) | (IndicatorData.sellSignal == 1))
    )
    if start_dt:
        ind_stmt = ind_stmt.where(IndicatorData.dateTime >= start_dt)
    if end_dt:
        ind_stmt = ind_stmt.where(IndicatorData.dateTime <= end_dt)
    ind_records = session.exec(ind_stmt.order_by(IndicatorData.dateTime)).all()

    ind_sample_times = [r.dateTime.isoformat() for r in ind_records[:5]]

    # ── Overlap check: which signal times have NO options row? ───────────────
    opt_datetimes = set(r.dateTime for r in opt_records)
    opt_datetimes_with_strike = set(r.dateTime for r in opt_with_strike)

    gaps = []
    for sig in ind_records:
        if sig.dateTime not in opt_datetimes_with_strike:
            gaps.append({
                "signal_time": sig.dateTime.isoformat(),
                "has_any_options_row": sig.dateTime in opt_datetimes,
                "has_options_with_strike": False,
            })

    return {
        "options_data": {
            "total_rows": len(opt_records),
            "rows_with_strike": len(opt_with_strike),
            "rows_without_strike": len(opt_records) - len(opt_with_strike),
            "sample_timestamps": opt_sample_times,
            "sample_scripts": opt_sample_scripts,
            "types_found": opt_sample_types,
        },
        "indicator_data": {
            "total_signal_rows": len(ind_records),
            "sample_timestamps": ind_sample_times,
        },
        "gap_analysis": {
            "signals_with_no_matching_options": len(gaps),
            "first_10_gaps": gaps[:10],
        },
        "diagnosis": (
            "All signal timestamps match options data." if not gaps
            else f"{len(gaps)} signal(s) have no matching options row with a valid strike. "
                 "Check that both files use the same timestamp format and time range."
        )
    }
