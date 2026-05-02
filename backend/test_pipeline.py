"""
Automated end-to-end test for ingestion pipeline.
REUSABLE: Drop this file into any project using the same backend structure.
Run with: .\venv\Scripts\python.exe test_pipeline.py
"""

import requests
import json
import sys

CSV_PATH = r'D:\Project\Stock Indicator Testing Tool\Put-24000-Raw.csv'
BASE_URL = "http://127.0.0.1:8000"

# CSV headers: time, open, high, low, close, Volume
# Mapping: CSV column name -> DB field name
MAPPINGS = {
    "time":   "dateTime",
    "open":   "open",
    "high":   "high",
    "low":    "low",
    "close":  "close",
    "Volume": "volume",
}

PASS = "\033[92m[PASS]\033[0m"
FAIL = "\033[91m[FAIL]\033[0m"
INFO = "\033[94m[INFO]\033[0m"

all_passed = True

def check(condition, label, detail=""):
    global all_passed
    status = PASS if condition else FAIL
    if not condition:
        all_passed = False
    print(f"  {status} {label}", f"| {detail}" if detail else "")


# ─────────────────────────────────────────────────────────
# STEP 1: /api/preview
# ─────────────────────────────────────────────────────────
print("\n" + "="*55)
print("STEP 1: /api/preview")
print("="*55)

with open(CSV_PATH, "rb") as f:
    resp = requests.post(
        f"{BASE_URL}/api/preview",
        data={
            "dataType": "options",
            "mappings": json.dumps(MAPPINGS),
            "exchange": "NSE",
            "stock": "NIFTY",
        },
        files={"file": ("Put-24000-Raw.csv", f, "text/csv")},
    )

data = resp.json()

if data.get("error"):
    print(f"  {FAIL} Preview returned error: {data['error']}")
    sys.exit(1)

unique_dates = data.get("unique_dates", [])
unique_times = data.get("unique_times", [])
preview      = data.get("preview", [])

check(len(unique_dates) > 0, "unique_dates populated",  f"count={len(unique_dates)}, first={unique_dates[0] if unique_dates else 'N/A'}")
check(len(unique_times) > 0, "unique_times populated",  f"count={len(unique_times)}, first={unique_times[0] if unique_times else 'N/A'}")
check(bool(data.get("min_date")), "min_date returned",  data.get("min_date"))
check(bool(data.get("max_date")), "max_date returned",  data.get("max_date"))
check(bool(data.get("min_time")), "min_time returned",  data.get("min_time"))
check(bool(data.get("max_time")), "max_time returned",  data.get("max_time"))
check(len(preview) > 0,          "preview rows returned", f"count={len(preview)}")

if preview:
    row = preview[0]
    print(f"\n  {INFO} Preview row[0] keys: {list(row.keys())}")
    check("Calculated_Date" in row, "Calculated_Date in preview", row.get("Calculated_Date", "MISSING"))
    check("Calculated_Time" in row, "Calculated_Time in preview", row.get("Calculated_Time", "MISSING"))
    check(row.get("open")   is not None, "open mapped",   str(row.get("open")))
    check(row.get("high")   is not None, "high mapped",   str(row.get("high")))
    check(row.get("low")    is not None, "low mapped",    str(row.get("low")))
    check(row.get("close")  is not None, "close mapped",  str(row.get("close")))
    check(row.get("volume") is not None, "volume mapped", str(row.get("volume")))


# ─────────────────────────────────────────────────────────
# STEP 2: /api/ingest (with date range filter from preview)
# ─────────────────────────────────────────────────────────
print("\n" + "="*55)
print("STEP 2: /api/ingest")
print("="*55)

start_date = unique_dates[0]  if unique_dates else ""
end_date   = unique_dates[-1] if unique_dates else ""
start_time = unique_times[0]  if unique_times else ""
end_time   = unique_times[-1] if unique_times else ""

print(f"  {INFO} Using date range: {start_date} to {end_date}")
print(f"  {INFO} Using time range: {start_time} to {end_time}")

with open(CSV_PATH, "rb") as f:
    resp2 = requests.post(
        f"{BASE_URL}/api/ingest",
        data={
            "dataType":    "options",
            "mappings":    json.dumps(MAPPINGS),
            "exchange":    "NSE",
            "stock":       "NIFTY",
            "manualScript": "NIFTY24MAR24000PE",
            "startDate":   start_date,
            "endDate":     end_date,
            "startTime":   start_time,
            "endTime":     end_time,
        },
        files={"file": ("Put-24000-Raw.csv", f, "text/csv")},
    )

data2 = resp2.json()

if data2.get("error"):
    check(False, "Ingest succeeded", data2["error"])
else:
    check(True, "Ingest succeeded", data2.get("message", ""))


# ─────────────────────────────────────────────────────────
# SUMMARY
# ─────────────────────────────────────────────────────────
print("\n" + "="*55)
if all_passed:
    print("\033[92m  ALL TESTS PASSED\033[0m")
else:
    print("\033[91m  SOME TESTS FAILED — see above\033[0m")
print("="*55 + "\n")
