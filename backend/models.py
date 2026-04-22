"""
models.py — SQLModel table definitions for the Stock Indicator Testing Tool.
REUSABLE PATTERN: All models use UUID primary keys auto-generated at insert time
via `default_factory=lambda: str(uuid.uuid4())`. This prevents primary key
constraint violations during bulk inserts when source data has no 'id' column.
Prices are stored as integers (value × 100) to avoid floating-point precision errors.
"""

import uuid
from sqlmodel import SQLModel, Field
from typing import Optional
from datetime import datetime, date


# ---------------------------------------------------------------------------
# Spot Price Data — Anchor table for ATM strike calculation.
# Stores the Index/Spot price (e.g. NIFTY cash index) at each candle.
# Required: Without this table, the ATM validator cannot function.
# ---------------------------------------------------------------------------
class SpotData(SQLModel, table=True):
    id: str = Field(
        default_factory=lambda: str(uuid.uuid4()),
        primary_key=True
    )
    stock: str                   # e.g. "NIFTY", "BANKNIFTY"
    dateTime: datetime
    date: date
    time: str
    price: int                   # Stored as integer (price × 100) for precision


# ---------------------------------------------------------------------------
# Options / Equity OHLCV Data — Core price data for backtesting.
# The 'script' field must follow a searchable naming convention,
# e.g. "NIFTY_19500_CE" to allow partial-match strike lookup.
# ---------------------------------------------------------------------------
class OptionsData(SQLModel, table=True):
    id: str = Field(
        default_factory=lambda: str(uuid.uuid4()),
        primary_key=True
    )
    dateTime: datetime
    date: date
    time: str
    open: int                    # price × 100
    high: int                    # price × 100
    low: int                     # price × 100
    close: int                   # price × 100
    volume: int
    exchange: str                # "NSE", "BSE"
    stock: str                   # "NIFTY", "BANKNIFTY"
    script: str                  # Strike script name, e.g. "NIFTY_19500_CE"
    type: str                    # "Call" or "Put"
    expiry: date


# ---------------------------------------------------------------------------
# Indicator Signal Data — Buy/Sell signals from user's indicator system.
# buySignal=1 means a buy event; sellSignal=1 means a sell/exit event.
# ---------------------------------------------------------------------------
class IndicatorData(SQLModel, table=True):
    id: str = Field(
        default_factory=lambda: str(uuid.uuid4()),
        primary_key=True
    )
    indicatorName: str           # e.g. "RSI", "MACD"
    dateTime: datetime
    buySignal: int = Field(default=0)   # 1 = signal active, 0 = no signal
    sellSignal: int = Field(default=0)  # 1 = signal active, 0 = no signal
    stock: str


# ---------------------------------------------------------------------------
# Validation Report — Persisted results of each backtest run.
# config and trades are stored as JSON strings for flexible schema.
# ---------------------------------------------------------------------------
class ValidationReport(SQLModel, table=True):
    id: str = Field(
        default_factory=lambda: str(uuid.uuid4()),
        primary_key=True
    )
    testDate: datetime = Field(default_factory=datetime.utcnow)
    config: str                  # JSON string of the validator config used
    totalProfit: int             # Stored as integer (profit × 100)
    winRate: float
    trades: str                  # JSON string of individual trade records
