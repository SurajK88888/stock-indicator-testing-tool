"""
Simulates the exact validator query using SQLModel/SQLAlchemy
to debug why 'No signals found' is still returned.
"""
import sys
sys.path.insert(0, ".")

from datetime import datetime
from sqlmodel import Session, create_engine, select
from models import IndicatorData

engine = create_engine("sqlite:///database.db", connect_args={"check_same_thread": False})

# Test params — matching what user entered in the form
stock = "NIFTY"
indicatorName = "RSI"
entrySignal = "Sell"       # user set Entry Signal = Sell
startDate = "2026-03-11"
endDate = "2026-03-12"

with Session(engine) as session:
    buy_col = IndicatorData.buySignal if entrySignal == "Buy" else IndicatorData.sellSignal

    signal_stmt = select(IndicatorData).where(
        IndicatorData.stock == stock,
        IndicatorData.indicatorName == indicatorName,
        buy_col == 1
    ).order_by(IndicatorData.dateTime)

    print(f"stock={stock!r}, indicatorName={indicatorName!r}, entrySignal={entrySignal!r}")
    print(f"Querying column: {'buySignal' if entrySignal == 'Buy' else 'sellSignal'} == 1")

    # Without date filter
    all_signals = session.exec(signal_stmt).all()
    print(f"\nSignals WITHOUT date filter: {len(all_signals)}")
    for s in all_signals:
        print(f"  {s.dateTime} | buy={s.buySignal} | sell={s.sellSignal} | stock={s.stock}")

    # With date filter (fixed)
    start_dt = datetime.strptime(startDate, "%Y-%m-%d")
    end_dt = datetime.strptime(endDate + " 23:59:59", "%Y-%m-%d %H:%M:%S")
    print(f"\nDate filter: {start_dt} to {end_dt}")

    filtered_stmt = signal_stmt.where(
        IndicatorData.dateTime >= start_dt,
        IndicatorData.dateTime <= end_dt
    )
    filtered_signals = session.exec(filtered_stmt).all()
    print(f"Signals WITH date filter: {len(filtered_signals)}")
    for s in filtered_signals:
        print(f"  {s.dateTime} | buy={s.buySignal} | sell={s.sellSignal}")

    # Also check what stock values exist
    all_rows = session.exec(select(IndicatorData)).all()
    stocks = set(r.stock for r in all_rows)
    indicators = set(r.indicatorName for r in all_rows)
    print(f"\nAll stocks in DB: {stocks}")
    print(f"All indicatorNames in DB: {indicators}")
    print(f"Total rows in indicatordata: {len(all_rows)}")
