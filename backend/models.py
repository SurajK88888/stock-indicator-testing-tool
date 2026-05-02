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
    date: Optional[str] = None   # Derived from dateTime as YYYY-MM-DD string
    time: Optional[str] = None   # Derived from dateTime as HH:MM:SS string
    open: int                    # price x 100
    high: int                    # price x 100
    low: int                     # price x 100
    close: int                   # price x 100
    volume: int
    exchange: str                # "NSE", "BSE"
    stock: str                   # "NIFTY", "BANKNIFTY"
    script: Optional[str] = None # Strike script name, e.g. "NIFTY_19500_CE"
    type: Optional[str] = None   # "Call" or "Put"
    expiry: Optional[str] = None # Expiry date as string, e.g. "2026-03-20"
    strike: Optional[int] = None # Extracted numeric strike (e.g., 24000)
    lot_size: Optional[int] = None # Extracted lot size (e.g., 65, 20, 15)
    updatedBy: Optional[str] = None # User who updated/ingested
    updated_on: datetime = Field(default_factory=datetime.utcnow)




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
    date: Optional[str] = None   # Derived from dateTime as YYYY-MM-DD string
    time: Optional[str] = None   # Derived from dateTime as HH:MM:SS string
    open: Optional[int] = None   # price x 100
    high: Optional[int] = None   # price x 100
    low: Optional[int] = None    # price x 100
    close: Optional[int] = None  # price x 100
    volume: Optional[int] = None
    exchange: Optional[str] = None
    stock: str
    buySignal: int = Field(default=0)   # 1 = signal active, 0 = no signal
    sellSignal: int = Field(default=0)  # 1 = signal active, 0 = no signal
    updatedBy: Optional[str] = None     # Login Username (if available)
    timeframe: Optional[str] = Field(default="1m")
    updated_on: datetime = Field(default_factory=datetime.utcnow)




# ---------------------------------------------------------------------------
# Validation Report — Persisted results of each backtest run.
# config and trades are stored as JSON strings for flexible schema.
# Summary fields (indicatorName, stock, etc.) stored directly for fast listing.
# REUSABLE: This pattern (JSON blob + indexed summary cols) balances flexibility
#           with query performance for report history dashboards.
# ---------------------------------------------------------------------------
class ValidationReport(SQLModel, table=True):
    id: str = Field(
        default_factory=lambda: str(uuid.uuid4()),
        primary_key=True
    )
    testDate: datetime = Field(default_factory=datetime.utcnow)
    config: str                            # JSON string of the validator config used
    totalProfit: int                       # Stored as integer (profit x 100)
    winRate: float
    trades: str                            # JSON string of individual trade records
    # --- Summary columns (indexed for fast listing, avoids JSON parsing on list view) ---
    indicatorName: Optional[str] = None   # e.g. "RSI", "MACD"
    stock: Optional[str] = None           # e.g. "NIFTY"
    maxDrawdown: Optional[float] = None   # Largest peak-to-valley % drop
    profitFactor: Optional[float] = None  # GrossProfit / |GrossLoss|
    avgTrade: Optional[float] = None      # Average points per trade
    totalTrades: Optional[int] = None     # Total count of closed trades


# ---------------------------------------------------------------------------
# Backtest Trade — Individual trade rows for Phase 4 reporting and export.
# ---------------------------------------------------------------------------
class BacktestTrade(SQLModel, table=True):
    id: str = Field(
        default_factory=lambda: str(uuid.uuid4()),
        primary_key=True
    )
    report_id: str = Field(foreign_key="validationreport.id")
    trade_id: int
    stock: str
    script: str
    entry_type: str                  # "Buy" or "Sell"
    entry_time: datetime
    exit_time: datetime
    duration: int                    # Duration in minutes or seconds
    entry_price: int                 # price x 100
    exit_price: int                  # price x 100
    quantity: float                  # Number of lots (can be float if partials are allowed, else int)
    exit_reason: str                 # "Signal Exit" or "Time-Stop Exit"
    trade_value: float               # Monetary value
    net_points: float                # Difference between exit and entry
    net_pnl: float                   # Actual P&L amount
    derived_atm: Optional[int] = None # The derived anchor strike used

