import json
import uuid
from typing import Optional
from datetime import datetime

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
    """Returns the correct OHLC price based on executionPrice selection, divided by 100."""
    mapping = {
        "Open": record.open,
        "High": record.high,
        "Low": record.low,
        "Close": record.close,
    }
    return mapping.get(point, record.close) / 100.0


def _get_derived_anchor(session: Session, stock: str, dt: datetime):
    stmt = select(OptionsData.strike, OptionsData.type, OptionsData.close).where(
        OptionsData.stock == stock,
        OptionsData.dateTime == dt,
        OptionsData.strike.is_not(None)
    )
    records = session.exec(stmt).all()
    if not records:
        # CRITICAL: Always return a tuple so callers can unpack (base_atm, is_single_strike) safely.
        # Returning bare None causes "cannot unpack non-iterable NoneType" crash.
        return None, False
        
    strike_prices = {}
    for r in records:
        strike, typ, close = r
        if strike not in strike_prices:
            strike_prices[strike] = {"Call": None, "Put": None}
        if typ and typ.lower() in ("call", "ce"):
            strike_prices[strike]["Call"] = close
        elif typ and typ.lower() in ("put", "pe"):
            strike_prices[strike]["Put"] = close
            
    min_diff = float('inf')
    atm_strike = None
    
    if len(strike_prices) == 1:
        return list(strike_prices.keys())[0], True
        
    for strike, prices in strike_prices.items():
        if prices["Call"] is not None and prices["Put"] is not None:
            diff = abs(prices["Call"] - prices["Put"])
            if diff < min_diff:
                min_diff = diff
                atm_strike = strike
                
    return atm_strike, False


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
            def fetch_opt_record(script_or_target, dt, timing, is_entry=True):
                # Ensure float target strikes (e.g. 23500.0) are treated correctly
                if isinstance(script_or_target, (int, float)):
                    script_or_target = int(script_or_target)
                if timing == "At Signal":
                    stmt = select(OptionsData).where(
                        OptionsData.stock == req.stock,
                        OptionsData.script.contains(str(script_or_target)) if type(script_or_target) == int else OptionsData.script == script_or_target,
                        OptionsData.dateTime == dt
                    )
                else:
                    stmt = select(OptionsData).where(
                        OptionsData.stock == req.stock,
                        OptionsData.script.contains(str(script_or_target)) if type(script_or_target) == int else OptionsData.script == script_or_target,
                        OptionsData.dateTime > dt
                    ).order_by(OptionsData.dateTime)
                return session.exec(stmt).first()
                
            def close_position(pos_type, exit_signal_dt, reason="Signal Exit", force_exit_opt=None):
                pos = open_positions[pos_type]
                if not pos: return None
                
                # Find exit record
                if force_exit_opt:
                    exit_record = force_exit_opt
                else:
                    exit_record = fetch_opt_record(pos["script"], exit_signal_dt, req.exitTiming, is_entry=False)
                    
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
                exit_price = _get_price_by_point(exit_record, req.executionPrice)
                avg_entry_price = pos["entryPriceTotal"] / pos["totalQuantity"]
                profit_points = exit_price - avg_entry_price
                
                pnl_amount = profit_points * pos["totalQuantity"]
                trade_value = avg_entry_price * pos["totalQuantity"]
                sell_amount = exit_price * pos["totalQuantity"]
                
                nonlocal total_profit, wins
                total_profit += pnl_amount
                if pnl_amount > 0: wins += 1
                
                pnl_pct = round((profit_points / avg_entry_price) * 100, 2) if avg_entry_price != 0 else 0.0

                # Highest / Lowest values between the two signals and their % vs entry
                # REUSABLE: Query OHLC between two timestamps to find price extremes.
                # Produces 4 separate fields: raw value + pct for both high and low.
                highest_high     = None
                highest_high_pct = None
                lowest_low       = None
                lowest_low_pct   = None
                try:
                    hl_rows = session.exec(
                        select(OptionsData.high, OptionsData.low).where(
                            OptionsData.script == pos["script"],
                            OptionsData.dateTime >= pos["entryTime"],
                            OptionsData.dateTime <= exit_record.dateTime
                        )
                    ).all()
                    if hl_rows and avg_entry_price > 0:
                        highest_high     = round(max(r[0] / 100.0 for r in hl_rows), 2)
                        lowest_low       = round(min(r[1] / 100.0 for r in hl_rows), 2)
                        highest_high_pct = round(highest_high / avg_entry_price, 4)
                        lowest_low_pct   = round(lowest_low  / avg_entry_price, 4)
                except Exception:
                    pass

                # Sell Amount: only applicable when tradeAmountType == "Lots"
                # Formula: lots_count × lot_size × exit_price (total exit value in Rs)
                # REUSABLE: Adapt formula to other trade-amount modes as needed.
                lots_count = pos.get("lotsCount", 0)
                lot_size   = pos.get("lotSize", 1)
                if req.tradeAmountType == "Lots" and lots_count > 0:
                    sell_amount_val = round(lots_count * lot_size * exit_price, 2)
                else:
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
                    "points":           round(profit_points, 2),
                    "pnlPct":           pnl_pct,
                    "strike":           pos["targetStrike"],
                    "profit":           round(pnl_amount, 2),
                    "quantity":         pos["totalQuantity"],
                    "tradeValue":       round(trade_value, 2),
                    "exitReason":       reason,
                    # --- Report Table & Excel Export fields ---
                    "optionType":       pos.get("optionType", ""),  # Call / Put
                    "expiry":           pos.get("expiry", ""),       # Expiry date string
                    "sellAmount":       sell_amount_val,              # Rs value if Lots, else "-"
                    # Highest High between entry & exit signals
                    "highestHigh":      highest_high,                # Raw max high value
                    "highestHighPct":   highest_high_pct,            # highestHigh / entryPrice
                    # Lowest Low between entry & exit signals
                    "lowestLow":        lowest_low,                  # Raw min low value
                    "lowestLowPct":     lowest_low_pct,              # lowestLow / entryPrice
                }
                trades.append(trade)
                open_positions[pos_type] = None
                return trade

            def open_position(pos_type, entry_signal_dt, entry_signal_type):
                pos = open_positions[pos_type]
                if pos:
                    if req.repetitiveSignals == "Ignore repetitive Signals":
                        return # Pyramiding off
                    add_record = fetch_opt_record(pos["script"], entry_signal_dt, req.entryTiming, is_entry=True)
                    if add_record:
                        add_price = _get_price_by_point(add_record, req.executionPrice)
                        add_qty = 1 * (add_record.lot_size or 1)
                        if req.tradeAmountType == "Capital":
                            capital = req.tradeAmountLots
                            qty_lots = int(capital / (add_price * (add_record.lot_size or 1))) if add_price > 0 else 0
                            if qty_lots < 1: return
                            add_qty = qty_lots * (add_record.lot_size or 1)
                        elif req.tradeAmountType == "Lots":
                            add_qty = int(req.tradeAmountLots) * (add_record.lot_size or 1)
                            
                        pos["entryPriceTotal"] += (add_price * add_qty)
                        pos["totalQuantity"] += add_qty
                    return

                # Open NEW position
                base_atm, is_single_strike = _get_derived_anchor(session, req.stock, entry_signal_dt)
                if not base_atm:
                    data_gaps.append({"type": "missing_options_data", "dateTime": entry_signal_dt.isoformat()})
                    return
                    
                if req.offsetType == "ATM+":
                    target_strike = base_atm + req.offsetValue if pos_type == "Call" else base_atm - req.offsetValue
                elif req.offsetType == "ATM-":
                    target_strike = base_atm - req.offsetValue if pos_type == "Call" else base_atm + req.offsetValue
                else:
                    target_strike = base_atm
                    
                entry_record = fetch_opt_record(int(target_strike), entry_signal_dt, req.entryTiming, is_entry=True)
                if not entry_record:
                    data_gaps.append({"type": "missing_strike_in_options", "targetStrike": target_strike, "signalDateTime": entry_signal_dt.isoformat(), "note": f"Script near '{int(target_strike)}' not found."})
                    return
                    
                entry_price = _get_price_by_point(entry_record, req.executionPrice)
                
                qty = 1 * (entry_record.lot_size or 1)
                if req.tradeAmountType == "Capital":
                    capital = req.tradeAmountLots
                    qty_lots = int(capital / (entry_price * (entry_record.lot_size or 1))) if entry_price > 0 else 0
                    if qty_lots < 1:
                        data_gaps.append({"type": "insufficient_capital", "signalDateTime": entry_signal_dt.isoformat(), "note": f"Capital {capital} insufficient for 1 lot at price {entry_price}."})
                        return
                    qty = qty_lots * (entry_record.lot_size or 1)
                elif req.tradeAmountType == "Lots":
                    qty = int(req.tradeAmountLots) * (entry_record.lot_size or 1)
                    
                atm_proof = f"Derived ATM: {base_atm} → Target: {target_strike}"
                if is_single_strike:
                    atm_proof += " (Derived from single strike)"
                    
                # Derive Option Type from DB field; fall back to script name if NULL.
                # REUSABLE: CE/PE suffix convention works for NSE option scripts.
                raw_type = entry_record.type or ""
                if not raw_type:
                    script_upper = (entry_record.script or "").upper()
                    if script_upper.endswith("CE"):
                        raw_type = "Call"
                    elif script_upper.endswith("PE"):
                        raw_type = "Put"

                # lotsCount and lotSize are stored separately so close_position
                # can compute sell_amount = lotsCount × lotSize × exit_price.
                raw_lots_count = int(req.tradeAmountLots) if req.tradeAmountType == "Lots" else 0
                raw_lot_size   = entry_record.lot_size or 1

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
                    "lotsCount":      raw_lots_count,    # For sell_amount calculation
                    "lotSize":        raw_lot_size,      # For sell_amount calculation
                }

            # MAIN SIGNAL LOOP
            for signal in signals:
                dt = signal.dateTime
                
                if end_date_dt and dt > end_date_dt:
                    break
                    
                is_primary = (signal.buySignal == 1) if req.entrySignal == "Buy" else (signal.sellSignal == 1)
                is_secondary = (signal.sellSignal == 1) if req.exitSignal == "Sell" else (signal.buySignal == 1)
                
                if is_primary:
                    close_position("Put", dt, "Signal Exit")
                    if req.applyOn in ["Call", "Both"]:
                        open_position("Call", dt, req.entrySignal)
                        
                if is_secondary:
                    close_position("Call", dt, "Signal Exit")
                    if req.applyOn in ["Put", "Both"]:
                        open_position("Put", dt, req.exitSignal)

            for pos_type in ["Call", "Put"]:
                if open_positions[pos_type]:
                    if req.positionOpenEndAction == "Ignore last Entry":
                        pass
                    else:
                        if pos_type == "Call":
                            cond = (IndicatorData.sellSignal == 1) if req.exitSignal == "Sell" else (IndicatorData.buySignal == 1)
                        else:
                            cond = (IndicatorData.buySignal == 1) if req.entrySignal == "Buy" else (IndicatorData.sellSignal == 1)
                            
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
