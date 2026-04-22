# Sovereign Ledger Terminal — Stock Indicator Testing Tool

A high-performance, full-stack stock backtesting engine designed for Indian markets. This tool allows users to ingest Options, Indicator, and Spot data, calculate ATM (At-The-Money) strikes using custom rounding logic, and validate indicator performance via an asynchronous validation engine.

---

## 🚀 Key Features

### 1. Robust Data Ingestion
- **Multi-Format Datetime Parsing:** Automatically handles over 10 different Indian market CSV/Excel datetime formats.
- **Dynamic Header Mapping:** Map custom CSV headers to database fields in real-time.
- **Smart Data Filters:** Pre-storage date/time range filtering to keep the database optimized.
- **Unified 3-Tier Data Pipeline:** Separate specialized ingestion for:
  - **Spot/Index Data:** (The anchor for ATM calculations)
  - **Options/Equity Data:** (Strike-specific OHLCV)
  - **Indicator Data:** (Buy/Sell signals generated from external tools)

### 2. Advanced ATM Calculation Engine
- **Anchor & Offset Logic:** Uses Spot/Index prices as a base to calculate ATM, OTM, and ITM strikes.
- **Configurable Rounding:** Support for **Closest**, **Floor**, and **Ceiling** rounding methods.
- **Strike Intervals:** Configurable strike spacing (e.g., 50 for NIFTY, 100 for BANKNIFTY).
- **Price Point Selection:** Select entry/exit prices based on Open, High, Low, or Close of the candle.

### 3. Asynchronous Validation Engine
- **Background Processing:** Long-running backtests run in the background to prevent UI timeouts.
- **Job Polling:** Real-time status updates via unique `jobId`.
- **Data Gap Reporting:** Automatically identifies and reports missing data points (e.g., missing spot prices for a signal date).
- **"Next Candle" Execution:** Implements realistic trade execution logic (Signal at T, Entry at T+1).

---

## 📂 Project Structure

```text
├── backend/                # FastAPI Python Backend
│   ├── main.py             # App entry, CORS, and Lifespan (DB init)
│   ├── models.py           # SQLModel Table Definitions (UUID based)
│   ├── database.py         # DB Engine & Session Management
│   ├── services/
│   │   ├── ingestion.py    # CSV Parsing, Header Mapping, DB Persistence
│   │   └── validator.py    # ATM Logic, P&L Calc, Background Tasks
│   └── venv/               # Virtual Environment
├── frontend/               # Next.js React Frontend
│   ├── app/
│   │   ├── dashboard/      # Main UI with Ingestion/Validator/Results
│   │   └── page.tsx        # Landing Page
│   └── components/         # Reusable UI Components
└── database.db             # Local SQLite Database (Auto-generated)
```

---

## 🔄 Working Flow

1. **Ingest Spot Data:** Upload the Index/Spot CSV. This provides the "Anchor" price for every minute.
2. **Ingest Options Data:** Upload the Strike prices CSV. This provides the "Execution" prices.
3. **Ingest Indicator Data:** Upload signals (1 for Buy, 1 for Sell).
4. **Validate:** 
   - The system finds a Signal at time `T`.
   - It looks up the Spot Price at `T`.
   - It rounds the Spot Price to the nearest `ATM` strike using the configured `Interval` and `Rounding Method`.
   - It finds the price for that `ATM` script in the Options table.
   - It calculates P&L from Entry to Exit.

---

## 🛠️ Setup Instructions

### Prerequisites
- **Python 3.10+**
- **Node.js 18+**
- **Git**

### Backend Setup
1. Navigate to the backend folder:
   ```bash
   cd backend
   ```
2. Create and activate a virtual environment:
   ```bash
   python -m venv venv
   # Windows:
   .\venv\Scripts\activate
   # Mac/Linux:
   source venv/bin/activate
   ```
3. Install dependencies:
   ```bash
   pip install fastapi uvicorn sqlmodel pandas polars
   ```
4. Start the backend:
   ```bash
   uvicorn main:app --reload
   ```

### Frontend Setup
1. Navigate to the frontend folder:
   ```bash
   cd ../frontend
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the dev server:
   ```bash
   npm run dev
   ```

### Accessing the Tool
- **UI:** [http://localhost:3000](http://localhost:3000) (or 3001)
- **API Docs:** [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs)

---

## 📝 Technical Reusable Patterns
- **Integer Scaling:** All financial prices are stored as `int(price * 100)` to ensure zero precision loss in SQLite.
- **Absolute Imports:** Backend uses package-level absolute imports for stability.
- **UUID Keys:** All records use auto-generated UUIDs to prevent primary key collisions during massive data imports.
