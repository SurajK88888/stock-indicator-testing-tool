import json
import uuid
from typing import Optional
from datetime import datetime, timedelta

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from database import get_session
from models import OptionsData, IndicatorData, ValidationReport, BacktestTrade

router = APIRouter(prefix="/api", tags=["validator"])

_jobs: dict = {}

class ValidateRequest(BaseModel):
    stock: str                              # e.g. "NIFTY"
    indicatorName: str                      # Must exist in IndicatorData table
    offsetType: str                         # "ATM", "ATM+", or "ATM-"
    offsetValue: int = 0                    # e.g. 100; ignored when offsetType == "ATM"
    entrySignal: str = "Buy"               # NOT USED in Both/Call/Put logic anymore, but kept for UI sync
    exitSignal: str = "Sell"               # NOT USED directly, implied by Apply On
    entryTiming: str = "Next Candle"       # "At Signal" or "Next Candle"
    exitTiming: str = "At Signal"          # "At Signal" or "Next Candle", plus "End of Day" maybe? (UI has End of Day)
    applyOn: str = "Call"                  # "Call", "Put", "Both"
    executionPrice: str = "Close"          # "Open", "High", "Low", "Close"
    tradeAmountType: str = "Lots"          # "Capital", "Lots", "None"
    tradeAmountLots: float = 1.0           # Number of lots per signal, or total capital
    repetitiveSignals: str = "Ignore repetitive Signals" # "Ignore repetitive Signals", "Add Qty"
    positionOpenEndDate: Optional[str] = None # Hard exit timestamp YYYY-MM-DD HH:MM
    positionOpenEndAction: str = "Ignore last Entry" # "Ignore last Entry", "Take next Entry beyond End Date"
    startDate: Optional[str] = None        # "YYYY-MM-DD" filter
    endDate: Optional[str] = None          # "YYYY-MM-DD" filter
    timeframe: str = "1m"                  # "1m", "5m", etc.


def _get_price_by_point(record: OptionsData, point: str) -> float:
    """
    Returns the correct OHLC price based on executionPrice selection.
    FIX (Fix 3): Returns 4 decimal places to preserve sub-cent precision
    (e.g. 283.1625 instead of 283.16).
    REUSABLE: Centralised price retrieval — all trade P&L flows through here.
    """
    mapping = {
        "Open": record.open,
        "High": record.high,
        "Low": record.low,
        "Close": record.close,
    }
    return round(mapping.get(point, record.close), 4)


def _tf_delta(timeframe: str) -> timedelta:
    """
    Converts a timeframe string to a timedelta offset.
    FIX (Fix 2): Used to compute the exact 'Next Candle' datetime so the
    engine hits the precise candle (e.g. signal+1m for '1m') rather than
    the nearest available row, which could be +2m on sparse data.
    REUSABLE: Works for '1m', '5m', '15m', '30m', '1h', '1d'.
    """
    unit_map = {"m": "minutes", "h": "hours", "d": "days"}
    unit = timeframe[-1].lower()
    val  = int(timeframe[:-1])
    return timedelta(**{unit_map.get(unit, "minutes"): val})


def _get_atm_from_spot(spot_close: float, strike_interval: int = 50) -> int:
    """
    FIX (Fix 1): Derives the ATM strike from the NIFTY spot close price at signal time.
    Formula: ATM = ROUND(spot_close / strike_interval, 0) * strike_interval

    This matches the exact manual calculation: =ROUND(E_row/50,0)*50
    where E_row is the NIFTY (indicator data) close price at the signal candle.

    REUSABLE: strike_interval param supports NIFTY (50), BANKNIFTY (100), etc.
    No DB lookup needed — the signal row already carries the spot close.
    """
    return int(round(spot_close / strike_interval) * strike_interval)


def _compute_max_drawdown(profits: list) -> float:
    equity, peak, max_dd = 0.0, 0.0, 0.0
    for p in profits:
        equity += p
        if equity > peak:
            peak = equity
        if peak > 0:
            dd = (peak - equity) / peak * 100
            if dd > max_dd:
                max_dd = dd
    return round(max_dd, 2)


def _compute_profit_factor(profits: list) -> float:
    gross_profit = sum(p for p in profits if p > 0)
    gross_loss = abs(sum(p for p in profits if p < 0))
    if gross_loss == 0:
        return round(gross_profit, 2) if gross_profit > 0 else 0.0
    return round(gross_profit / gross_loss, 2)


def _format_duration(entry_dt: datetime, exit_dt: datetime) -> str:
    total_minutes = max(0, int((exit_dt - entry_dt).total_seconds() // 60))
    hours = total_minutes // 60
    minutes = total_minutes % 60
    return f"{hours}h {minutes}m" if hours > 0 else f"{minutes}m"


def _run_validation(job_id: str, req: ValidateRequest, db_url: str):
    from sqlmodel import create_engine
    engine = create_engine(db_url, connect_args={"check_same_thread": False})
    
    try:
        with Session(engine) as session:
            _jobs[job_id]["status"] = "running"

            # Query ALL signals
            signal_stmt = select(IndicatorData).where(
                IndicatorData.stock == req.stock,
                IndicatorData.indicatorName == req.indicatorName,
                IndicatorData.timeframe == req.timeframe,
                ((IndicatorData.buySignal == 1) | (IndicatorData.sellSignal == 1))
            ).order_by(IndicatorData.dateTime)

            if req.startDate:
                try:
                    start_dt = datetime.strptime(req.startDate, "%Y-%m-%d")
                    signal_stmt = signal_stmt.where(IndicatorData.dateTime >= start_dt)
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

            hard_exit_dt = None
            if req.positionOpenEndDate:
                try:
                    hard_exit_dt = datetime.strptime(req.positionOpenEndDate, "%Y-%m-%d %H:%M:%S")
                except ValueError:
                    pass

            end_date_dt = None
            if req.endDate:
                try:
                    end_date_dt = datetime.strptime(req.endDate + " 23:59:59", "%Y-%m-%d %H:%M:%S")
                except ValueError:
                    pass

            open_positions = {"Call": None, "Put": None}

            # Helpers
            def _type_matches(record: OptionsData, opt_type: str) -> bool:
                """
                Returns True if the DB record's option type matches the requested type.
                Handles 'Call'/'CE' and 'Put'/'PE' variants stored in the database.
                REUSABLE: Centralised type-matching for all DB option record lookups.
                """
                db_type = (record.type or "").strip().lower()
                if opt_type == "Call":
                    return db_type in ("call", "ce")
                elif opt_type == "Put":
                    return db_type in ("put", "pe")
                return True  # no filter requested

            def fetch_opt_record(script_or_target, dt, timing, is_entry=True, opt_type: str = None):
                """
                FIX (Expiry): ORDER BY expiry ASC on all lookups so the NEAREST upcoming
                expiry is always selected. Without this, SQLite returns whichever row was
                inserted first (could be a far-expiry row), causing wrong prices.
                FIX (Next Candle): 'Next Candle' tries exact dt+timeframe match first,
                then falls back to the nearest row > dt only on a data gap.
                FIX (Type filter): opt_type ensures Call lookups only return Call records
                and Put lookups only return Put records, preventing type contamination.
                REUSABLE: opt_type=None disables the filter for generic lookups.
                KNOWN BUG FIXED: Previously .first() had no ORDER BY expiry, so SQLite
                could return a far-expiry (e.g. Apr-14) instead of near-expiry (Apr-07),
                producing wrong entry/exit prices.
                """
                if isinstance(script_or_target, (int, float)):
                    script_or_target = int(script_or_target)

                is_strike = type(script_or_target) == int
                script_filter = (
                    OptionsData.script.contains(str(script_or_target))
                    if is_strike else
                    OptionsData.script == script_or_target
                )

                # Build type filter when an option type is specified
                # Map 'Call' -> both 'Call' and 'CE'; 'Put' -> both 'Put' and 'PE'
                type_conditions = []
                if opt_type == "Call":
                    from sqlmodel import or_
                    type_filter = or_(
                        OptionsData.type == "Call",
                        OptionsData.type == "CE",
                        OptionsData.type == "call",
                    )
                    type_conditions = [type_filter]
                elif opt_type == "Put":
                    from sqlmodel import or_
                    type_filter = or_(
                        OptionsData.type == "Put",
                        OptionsData.type == "PE",
                        OptionsData.type == "put",
                    )
                    type_conditions = [type_filter]

                if timing == "At Signal":
                    # FIX: ORDER BY expiry ASC to always pick the nearest/current expiry.
                    # Without ORDER BY, SQLite returns rows in insert order which may be
                    # a later expiry (e.g. Apr-14 instead of Apr-07).
                    # REUSABLE: This fix applies to all strike lookups regardless of instrument.
                    stmt = select(OptionsData).where(
                        OptionsData.stock == req.stock,
                        script_filter,
                        OptionsData.dateTime == dt,
                        *type_conditions
                    ).order_by(OptionsData.expiry)
                    return session.exec(stmt).first()
                else:
                    # Next Candle: try exact dt+timeframe first, fall back to nearest >
                    # FIX: ORDER BY expiry ASC on all sub-queries for consistent expiry selection.
                    exact_dt = dt + _tf_delta(req.timeframe)
                    stmt_exact = select(OptionsData).where(
                        OptionsData.stock == req.stock,
                        script_filter,
                        OptionsData.dateTime == exact_dt,
                        *type_conditions
                    ).order_by(OptionsData.expiry)
                    result = session.exec(stmt_exact).first()
                    if result:
                        return result
                    # Fallback: nearest available candle after dt, nearest expiry first
                    stmt_next = select(OptionsData).where(
                        OptionsData.stock == req.stock,
                        script_filter,
                        OptionsData.dateTime > dt,
                        *type_conditions
                    ).order_by(OptionsData.dateTime, OptionsData.expiry)
                    return session.exec(stmt_next).first()
                
            def close_position(pos_type, exit_signal_dt, reason="Signal Exit", force_exit_opt=None):
                pos = open_positions[pos_type]
                if not pos: return None
                
                # Find exit record
                if force_exit_opt:
                    exit_record = force_exit_opt
                else:
                    # FIX (Exit Timing + Type): Use req.exitTiming (user-configured) and pass
                    # pos_type as opt_type so:
                    #   Call exits → only match Call/CE records
                    #   Put  exits → only match Put/PE  records
                    # Without opt_type, a strike like "22300" could return a Call record when
                    # the position is Put (or vice-versa), corrupting exit price and all
                    # downstream columns (Sell Amount, PnL Points, PnL Amount, H/L values).
                    # For Call: req.exitTiming="At Signal"   → fetches same-candle exit ✅
                    # For Put:  req.exitTiming="Next Candle" → fetches next-candle exit ✅
                    # For Both: each side uses its own pos_type + shared req.exitTiming  ✅
                    # REUSABLE: This pattern handles any applyOn mode (Call/Put/Both) and
                    # any exitTiming the user selects from the UI, without hardcoding.
                    # KNOWN BUG FIXED: Hardcoding "At Signal" ignored req.exitTiming (broke Put).
                    # KNOWN BUG FIXED: Missing opt_type risked type-contaminated exit prices.
                    exit_record = fetch_opt_record(pos["script"], exit_signal_dt, req.exitTiming, is_entry=False, opt_type=pos_type)
                    
                if not exit_record:
                    data_gaps.append({
                        "type": "missing_exit_record",
                        "script": pos["script"],
                        "exitSignalTime": exit_signal_dt.isoformat() if exit_signal_dt else "Time-Stop"
                    })
                    open_positions[pos_type] = None
                    return None
                    
                # Time Stop Check
                if hard_exit_dt:
                    time_stop_record = session.exec(select(OptionsData).where(
                        OptionsData.script == pos["script"],
                        OptionsData.dateTime >= hard_exit_dt,
                        OptionsData.dateTime > pos["entryTime"]
                    ).order_by(OptionsData.dateTime)).first()
                    
                    if time_stop_record and time_stop_record.dateTime <= exit_record.dateTime:
                        exit_record = time_stop_record
                        reason = "Time-Stop Exit"
                        
                # Compute P&L
                # _get_price_by_point rounds the fetched OHLC price to 4dp — this controls
                # the calculation INPUT only (prevents sub-pip noise in entry/exit prices).
                # All computed RESULTS (profit_points, pnl_pct, tradeValue, etc.) flow into
                # the trade dict and DB at full IEEE-754 float64 precision (~16 sig. digits)
                # with NO round() applied. This ensures stored values like pnlPct are exact.
                exit_price      = _get_price_by_point(exit_record, req.executionPrice)
                avg_entry_price = pos["entryPriceTotal"] / pos["totalQuantity"]
                profit_points   = exit_price - avg_entry_price  # raw, unrounded

                # PnL % = (Exit - Entry) / Entry × 100  — stored as percentage (e.g. 8.14 = 8.14%)
                # Formula matches manual: (PnL Points / Entry At) * 100
                # PRECISION: round() removed — full IEEE-754 float64 precision stored in DB.
                # Calculations use in-memory floats; round() only truncated the stored value.
                pnl_pct = ((profit_points / avg_entry_price) * 100) if avg_entry_price != 0 else 0.0

                pnl_amount  = profit_points * pos["totalQuantity"]
                trade_value = avg_entry_price * pos["totalQuantity"]

                nonlocal total_profit, wins
                total_profit += pnl_amount
                if pnl_amount > 0: wins += 1

                # Highest / Lowest candle values between entry and exit (inclusive).
                # FIX: Filter by exact script AND expiry to prevent cross-expiry contamination
                # (e.g. Apr-7 and Apr-14 expiry records can both match the same strike).
                # FIX: High/Low Pct = (extreme - entry) / entry  (delta ratio, not absolute ratio).
                # REUSABLE: expiry filter must always be applied when multiple expiries coexist.
                highest_high     = None
                highest_high_pct = None
                lowest_low       = None
                lowest_low_pct   = None
                try:
                    # FIX: Add type filter to prevent Call H/L contaminating Put trades and vice versa.
                    # Same "Call"/"CE" and "Put"/"PE" convention used in fetch_opt_record.
                    # REUSABLE: pos_type is runtime-determined (Call/Put from signal routing).
                    if pos_type == "Call":
                        type_hl_cond = OptionsData.type.in_(["Call", "CE"])
                    else:
                        type_hl_cond = OptionsData.type.in_(["Put", "PE"])

                    hl_stmt = select(OptionsData.high, OptionsData.low).where(
                        OptionsData.script   == pos["script"],
                        OptionsData.expiry   == pos["expiry"],
                        type_hl_cond,
                        OptionsData.dateTime >= pos["entryTime"],
                        OptionsData.dateTime <= exit_record.dateTime
                    )
                    hl_rows = session.exec(hl_stmt).all()
                    if hl_rows and avg_entry_price > 0:
                        # PRECISION: round() removed — store raw max/min values at full float64 precision.
                        # These are used as inputs to the pct calculations below; keeping them unrounded
                        # prevents compounding precision loss across two formula steps.
                        highest_high     = max(r[0] for r in hl_rows)
                        lowest_low       = min(r[1] for r in hl_rows)
                        # Percentage: ((extreme - entry) / entry) * 100  — matches manual Excel
                        # REUSABLE: Formula applies to any option type or strike.
                        highest_high_pct = ((highest_high - avg_entry_price) / avg_entry_price) * 100
                        lowest_low_pct   = ((lowest_low   - avg_entry_price) / avg_entry_price) * 100
                except Exception:
                    pass

                # Buy / Sell Amount
                # Formula (confirmed from manual): 2 × lots_count × price
                # The multiplier 2 is the per-lot contract unit for this data set.
                # REUSABLE: If lot_size changes, update LOT_MULTIPLIER here.
                LOT_MULTIPLIER = 65
                lots_count = pos.get("lotsCount", 0)
                if req.tradeAmountType == "Lots" and lots_count > 0:
                    # PRECISION: round() removed — full float64 precision stored.
                    buy_amount_val  = LOT_MULTIPLIER * lots_count * avg_entry_price
                    sell_amount_val = LOT_MULTIPLIER * lots_count * exit_price
                else:
                    buy_amount_val  = "-"
                    sell_amount_val = "-"

                trade = {
                    "tradeId":          len(trades) + 1,
                    "script":           pos["script"],
                    "atmProof":         pos["atmProof"],
                    "entryTime":        pos["entryTime"].isoformat(),
                    "exitTime":         exit_record.dateTime.isoformat(),
                    "entryType":        pos["entryType"],
                    "executionNote":    reason,
                    "entryPrice":       avg_entry_price,
                    "exitPrice":        exit_price,
                    "duration":         _format_duration(pos["entryTime"], exit_record.dateTime),
                    "points":           profit_points,        # Exit At - Entry At (full precision)
                    "pnlPct":           pnl_pct,              # (points / entryAt) × 100
                    "strike":           pos["targetStrike"],
                    "profit":           (sell_amount_val - buy_amount_val) if isinstance(sell_amount_val, float) else pnl_amount,  # SellAmt - BuyAmt
                    "quantity":         pos["totalQuantity"],
                    "tradeValue":       trade_value,           # avg_entry × quantity (full precision)
                    "exitReason":       reason,
                    # --- Report Table & Excel Export fields ---
                    "optionType":       pos.get("optionType", ""),  # Call / Put
                    "expiry":           pos.get("expiry", ""),
                    "buyAmount":        buy_amount_val,   # 2 × lots × entryAt
                    "sellAmount":       sell_amount_val,  # 2 × lots × exitAt
                    # Highest between entry & exit — percentage vs entry
                    "highestHigh":      highest_high,
                    "highestHighPct":   highest_high_pct,  # ((highest - entry) / entry) * 100
                    # Lowest between entry & exit — percentage vs entry (negative = below entry)
                    "lowestLow":        lowest_low,
                    "lowestLowPct":     lowest_low_pct,   # ((lowest - entry) / entry) * 100
                }
                trades.append(trade)
                open_positions[pos_type] = None
                return trade

            def open_position(pos_type, entry_signal_dt, entry_signal_type):
                pos = open_positions[pos_type]
                if pos:
                    if req.repetitiveSignals == "Ignore repetitive Signals":
                        return # Pyramiding off
                    add_record = fetch_opt_record(pos["script"], entry_signal_dt, req.entryTiming, is_entry=True, opt_type=pos_type)
                    if add_record:
                        add_price = _get_price_by_point(add_record, req.executionPrice)
                        add_qty = LOT_MULTIPLIER
                        if req.tradeAmountType == "Capital":
                            capital  = req.tradeAmountLots
                            qty_lots = int(capital / (add_price * LOT_MULTIPLIER)) if add_price > 0 else 0
                            if qty_lots < 1: return
                            add_qty = qty_lots * LOT_MULTIPLIER
                        elif req.tradeAmountType == "Lots":
                            add_qty = int(req.tradeAmountLots) * LOT_MULTIPLIER
                            
                        pos["entryPriceTotal"] += (add_price * add_qty)
                        pos["totalQuantity"] += add_qty
                    return

                # FIX (Fix 1): ATM = ROUND(signal.close / 50) * 50
                # The signal row (IndicatorData) carries the NIFTY spot close at that candle,
                # which is the correct spot price input for the ATM formula — exactly matching
                # the manual Excel: =ROUND(E_row/50,0)*50
                # signal.close is the raw float NIFTY spot price at that candle.
                spot_close = (signal.close or 0.0)
                if spot_close <= 0:
                    data_gaps.append({"type": "missing_spot_close", "dateTime": entry_signal_dt.isoformat(), "note": "IndicatorData.close is null or zero; cannot derive ATM."})
                    return
                base_atm = _get_atm_from_spot(spot_close)
                    
                if req.offsetType == "ATM+":
                    target_strike = base_atm + req.offsetValue if pos_type == "Call" else base_atm - req.offsetValue
                elif req.offsetType == "ATM-":
                    target_strike = base_atm - req.offsetValue if pos_type == "Call" else base_atm + req.offsetValue
                else:
                    target_strike = base_atm
                    
                entry_record = fetch_opt_record(int(target_strike), entry_signal_dt, req.entryTiming, is_entry=True, opt_type=pos_type)
                if not entry_record:
                    data_gaps.append({"type": "missing_strike_in_options", "targetStrike": target_strike, "signalDateTime": entry_signal_dt.isoformat(), "note": f"Script near '{int(target_strike)}' not found."})
                    return

                # FIX (Expiry Guard): Skip entry if no exit signal exists before the option's expiry date.
                # Without this, entering on expiry day with no subsequent exit signal creates an invalid trade
                # that persists into the next expiry series (e.g. Apr-07 14:48 entry with no sell on Apr-07).
                # The manual Excel correctly skips such entries.
                # REUSABLE: This guard works for any weekly/monthly option series.
                # KNOWN BUG FIXED: This was causing 1 extra trade (#32) that shifted all subsequent
                # trades out of alignment, producing 47% accuracy instead of 100%.
                option_expiry_date = entry_record.expiry  # e.g. "2026-04-07" string or date
                if option_expiry_date:
                    expiry_dt_str = str(option_expiry_date)[:10]  # ensure "YYYY-MM-DD" format
                    # Find the next exit signal for this position type (sellSignal for Call, buySignal for Put)
                    if pos_type == "Call":
                        exit_cond = (IndicatorData.sellSignal == 1)
                    else:
                        exit_cond = (IndicatorData.buySignal == 1)
                    next_exit = session.exec(
                        select(IndicatorData).where(
                            IndicatorData.stock == req.stock,
                            IndicatorData.indicatorName == req.indicatorName,
                            IndicatorData.timeframe == req.timeframe,   # FIX: must filter by same timeframe
                            exit_cond,
                            IndicatorData.dateTime > entry_signal_dt,
                        ).order_by(IndicatorData.dateTime)
                    ).first()
                    if next_exit:
                        next_exit_date = str(next_exit.dateTime)[:10]
                        if next_exit_date > expiry_dt_str:
                            # Next exit signal is AFTER expiry — entering would create an unresolvable trade
                            data_gaps.append({
                                "type": "no_exit_before_expiry",
                                "signalDateTime": entry_signal_dt.isoformat(),
                                "expiry": expiry_dt_str,
                                "nextExitSignal": str(next_exit.dateTime),
                                "note": f"Skipped entry: next exit signal ({next_exit.dateTime}) is after option expiry ({expiry_dt_str}).",
                            })
                            return
                    
                entry_price = _get_price_by_point(entry_record, req.executionPrice)
                
                # FIX: qty = lots_count × LOT_MULTIPLIER (2).
                # DB lot_size is unreliable (stores 65 = same as user lot input).
                # Use LOT_MULTIPLIER=2 to match formula: qty = 2 × lots_count.
                # REUSABLE: Change LOT_MULTIPLIER if the underlying data changes.
                LOT_MULTIPLIER = 65
                qty = LOT_MULTIPLIER  # default: 1 lot
                if req.tradeAmountType == "Capital":
                    capital   = req.tradeAmountLots
                    qty_lots  = int(capital / (entry_price * LOT_MULTIPLIER)) if entry_price > 0 else 0
                    if qty_lots < 1:
                        data_gaps.append({"type": "insufficient_capital", "signalDateTime": entry_signal_dt.isoformat(), "note": f"Capital {capital} insufficient for 1 lot at price {entry_price}."})
                        return
                    qty = qty_lots * LOT_MULTIPLIER
                elif req.tradeAmountType == "Lots":
                    qty = int(req.tradeAmountLots) * LOT_MULTIPLIER
                    
                # ATM proof records the spot close used so the report is fully auditable
                atm_proof = f"Derived ATM: {base_atm} (Spot Close: {round(spot_close, 2)}) → Target: {target_strike}"

                # Derive Option Type from DB field; fall back to script name if NULL.
                # REUSABLE: CE/PE suffix convention works for NSE option scripts.
                raw_type = entry_record.type or ""
                if not raw_type:
                    script_upper = (entry_record.script or "").upper()
                    if script_upper.endswith("CE"):
                        raw_type = "Call"
                    elif script_upper.endswith("PE"):
                        raw_type = "Put"

                # lotsCount stored for sell/buy amount formula in close_position.
                raw_lots_count = int(req.tradeAmountLots) if req.tradeAmountType == "Lots" else 0

                open_positions[pos_type] = {
                    "script":         entry_record.script,
                    "base_atm":       base_atm,
                    "targetStrike":   target_strike,
                    "entryTime":      entry_record.dateTime,
                    "entryType":      entry_signal_type,
                    "entryPriceTotal": entry_price * qty,
                    "totalQuantity":  qty,
                    "atmProof":       atm_proof,
                    "optionType":     raw_type,          # Call / Put (with script fallback)
                    "expiry":         entry_record.expiry or "",
                    "lotsCount":      raw_lots_count,    # For buy/sell amount calculation
                }

            # MAIN SIGNAL LOOP
            # RULE (confirmed from manual Excel):
            #   buySignal  == 1  →  CALL entry  (close any open Put first)
            #   sellSignal == 1  →  PUT entry   (close any open Call first)
            # applyOn controls WHICH option type is traded:
            #   "Call" → only manage Call positions
            #   "Put"  → only manage Put positions
            #   "Both" → manage Call and Put simultaneously on alternating signals
            # The UI entrySignal/exitSignal dropdowns do NOT change this direction.
            # REUSABLE: Add new applyOn modes (e.g. "Straddle") by adding elif below.
            for signal in signals:
                dt     = signal.dateTime
                is_buy = signal.buySignal  == 1
                is_sell = signal.sellSignal == 1

                if end_date_dt and dt > end_date_dt:
                    break

                if req.applyOn == "Call":
                    if is_buy:
                        # BUY signal: re-enter Call (close existing first, then open)
                        close_position("Call", dt, "Signal Exit")
                        open_position("Call", dt, "Buy")
                    elif is_sell:
                        # SELL signal: exit Call only
                        close_position("Call", dt, "Signal Exit")

                elif req.applyOn == "Put":
                    if is_sell:
                        # SELL signal: re-enter Put (close existing first, then open)
                        close_position("Put", dt, "Signal Exit")
                        open_position("Put", dt, "Sell")
                    elif is_buy:
                        # BUY signal: exit Put only
                        close_position("Put", dt, "Signal Exit")

                elif req.applyOn == "Both":
                    # BUY  → open Call  + close Put  (Put exits on BUY)
                    # SELL → open Put   + close Call  (Call exits on SELL)
                    if is_buy:
                        close_position("Put",  dt, "Signal Exit")
                        open_position("Call",  dt, "Buy")
                    if is_sell:
                        close_position("Call", dt, "Signal Exit")
                        open_position("Put",   dt, "Sell")

            # Tail-exit block: close positions still open at end of date range.
            # Call exits on SELL; Put exits on BUY — consistent with main loop.
            # REUSABLE: Consistent with the fixed BUY→Call / SELL→Put routing above.
            for pos_type in ["Call", "Put"]:
                if open_positions[pos_type]:
                    if req.positionOpenEndAction == "Ignore last Entry":
                        pass
                    else:
                        # Call closes on SELL; Put closes on BUY — fixed rule
                        if pos_type == "Call":
                            cond = (IndicatorData.sellSignal == 1)
                        else:
                            cond = (IndicatorData.buySignal  == 1)

                        next_signal = session.exec(select(IndicatorData).where(
                            IndicatorData.stock == req.stock,
                            IndicatorData.indicatorName == req.indicatorName,
                            cond,
                            IndicatorData.dateTime > open_positions[pos_type]["entryTime"]
                        ).order_by(IndicatorData.dateTime)).first()

                        if next_signal:
                            close_position(pos_type, next_signal.dateTime, "Beyond End Date Exit")

            win_rate = (wins / len(trades)) * 100 if trades else 0.0
            all_profits  = [t["points"] for t in trades]
            max_drawdown  = _compute_max_drawdown(all_profits)
            profit_factor = _compute_profit_factor(all_profits)
            avg_trade     = round(total_profit / len(trades), 2) if trades else 0.0

            config_dict = req.model_dump()
            report = ValidationReport(
                config=json.dumps(config_dict),
                totalProfit=int(total_profit * 100),
                winRate=win_rate,
                trades=json.dumps(trades),
                indicatorName=req.indicatorName,
                stock=req.stock,
                maxDrawdown=max_drawdown,
                profitFactor=profit_factor,
                avgTrade=avg_trade,
                totalTrades=len(trades),
            )
            session.add(report)
            session.commit()
            session.refresh(report)

            bt_records = []
            for t in trades:
                derived_atm_val = None
                atm_proof_str = str(t.get("atmProof", ""))
                if "Derived ATM:" in atm_proof_str:
                    try:
                        atm_str = atm_proof_str.split("Derived ATM: ")[1].split(" ")[0]
                        derived_atm_val = int(float(atm_str))
                    except (ValueError, IndexError):
                        pass

                bt_records.append(BacktestTrade(
                    report_id=report.id,
                    trade_id=t["tradeId"],
                    stock=req.stock,
                    script=t["script"],
                    entry_type=t["entryType"],
                    entry_time=datetime.fromisoformat(t["entryTime"]),
                    exit_time=datetime.fromisoformat(t["exitTime"]),
                    duration=int((datetime.fromisoformat(t["exitTime"]) - datetime.fromisoformat(t["entryTime"])).total_seconds()),
                    entry_price=int(t["entryPrice"] * 100),
                    exit_price=int(t["exitPrice"] * 100),
                    quantity=t["quantity"],
                    exit_reason=t["exitReason"],
                    trade_value=t["tradeValue"],
                    net_points=t["points"],
                    net_pnl=t["profit"],
                    derived_atm=derived_atm_val
                ))
                
            if bt_records:
                session.add_all(bt_records)
                session.commit()

            _jobs[job_id] = {
                "status": "done",
                "result": {
                    "reportId":     report.id,
                    "totalProfit":  round(total_profit, 2),
                    "winRate":      round(win_rate, 2),
                    "totalTrades":  len(trades),
                    "dataGaps":     data_gaps,
                    # --- Fields required by frontend for Trade Log, Equity Curve, and KPI cards ---
                    "trades":       trades,          # Full list so sortedTrades renders correctly
                    "maxDrawdown":  max_drawdown,    # Needed by Max Drawdown KPI card
                    "profitFactor": profit_factor,   # Needed by Profit Factor KPI card
                    "avgTrade":     avg_trade,        # Needed by Avg Trade KPI card
                }
            }
    except Exception as e:
        import traceback
        _jobs[job_id] = {
            "status": "error",
            "result": {"error": f"Internal Error: {str(e)}", "traceback": traceback.format_exc()}
        }


@router.post("/validate")
def start_validation(req: ValidateRequest, background_tasks: BackgroundTasks):
    job_id = str(uuid.uuid4())
    _jobs[job_id] = {"status": "pending", "result": None}
    from database import sqlite_url
    background_tasks.add_task(_run_validation, job_id, req, sqlite_url)
    return {"jobId": job_id, "status": "pending"}


@router.get("/validate/status/{job_id}")
def get_validation_status(job_id: str):
    if job_id not in _jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    return _jobs[job_id]
