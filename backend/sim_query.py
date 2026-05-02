import sqlite3
from datetime import datetime

conn = sqlite3.connect("database.db")
cur = conn.cursor()

# Simulate exact validator query
stock = "NIFTY"
indicatorName = "RSI"
startDate = "2026-03-11"
endDate = "2026-03-12"

start_dt = datetime.strptime(startDate, "%Y-%m-%d")
end_dt = datetime.strptime(endDate, "%Y-%m-%d")

print(f"Query filter: dateTime >= {start_dt} AND dateTime <= {end_dt}")
print()

# Buy signals in range
cur.execute("""
    SELECT indicatorName, dateTime, buySignal, sellSignal, stock
    FROM indicatordata
    WHERE stock = ? AND indicatorName = ? AND buySignal = 1
    AND dateTime >= ? AND dateTime <= ?
    ORDER BY dateTime
""", (stock, indicatorName, start_dt.isoformat(), end_dt.isoformat()))

buy_signals = cur.fetchall()
print(f"BUY signals found: {len(buy_signals)}")
for r in buy_signals:
    print(f"  {r}")

# The problem: end_dt is 2026-03-12 00:00:00 - signals at 12:13 on March 12 are cut off!
print()
print(f"NOTE: end_dt = {end_dt} = MIDNIGHT of March 12")
print("Any signal after midnight on March 12 is excluded!")
print()

# What signals exist on March 12?
cur.execute("""
    SELECT indicatorName, dateTime, buySignal, sellSignal
    FROM indicatordata
    WHERE stock = ? AND indicatorName = ? AND buySignal = 1
    AND date(dateTime) = '2026-03-12'
""", (stock, indicatorName))
mar12_signals = cur.fetchall()
print(f"March 12 buy signals (all day): {len(mar12_signals)}")
for r in mar12_signals:
    print(f"  {r}")

conn.close()
