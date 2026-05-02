import sqlite3

conn = sqlite3.connect("database.db")
cur = conn.cursor()

print("=" * 60)
print("INDICATORDATA - All unique values")
print("=" * 60)
cur.execute("SELECT DISTINCT indicatorName FROM indicatordata")
print("  indicatorName:", [r[0] for r in cur.fetchall()])

cur.execute("SELECT DISTINCT stock FROM indicatordata")
print("  stock:", [r[0] for r in cur.fetchall()])

cur.execute("SELECT MIN(dateTime), MAX(dateTime) FROM indicatordata")
mn, mx = cur.fetchone()
print(f"  dateTime range: {mn} to {mx}")

cur.execute("SELECT DISTINCT buySignal FROM indicatordata")
print("  buySignal values:", [r[0] for r in cur.fetchall()])

cur.execute("SELECT DISTINCT sellSignal FROM indicatordata")
print("  sellSignal values:", [r[0] for r in cur.fetchall()])

cur.execute("SELECT COUNT(*) FROM indicatordata WHERE buySignal != 0 AND buySignal != '0'")
print("  Rows with buySignal != 0:", cur.fetchone()[0])

cur.execute("SELECT COUNT(*) FROM indicatordata WHERE sellSignal != 0 AND sellSignal != '0'")
print("  Rows with sellSignal != 0:", cur.fetchone()[0])

cur.execute("SELECT indicatorName, dateTime, buySignal, sellSignal, stock FROM indicatordata ORDER BY dateTime")
rows = cur.fetchall()
print(f"\n  ALL {len(rows)} rows:")
for r in rows:
    print(f"    {r[0]} | {r[1]} | buy={r[2]} | sell={r[3]} | {r[4]}")

print("\n" + "=" * 60)
print("OPTIONSDATA - All unique values")
print("=" * 60)
cur.execute("SELECT DISTINCT stock FROM optionsdata")
print("  stock:", [r[0] for r in cur.fetchall()])

cur.execute("SELECT DISTINCT script FROM optionsdata")
print("  script:", [r[0] for r in cur.fetchall()])

cur.execute("SELECT DISTINCT type FROM optionsdata")
print("  type:", [r[0] for r in cur.fetchall()])

cur.execute("SELECT DISTINCT expiry FROM optionsdata")
print("  expiry:", [r[0] for r in cur.fetchall()])

cur.execute("SELECT MIN(dateTime), MAX(dateTime) FROM optionsdata")
mn, mx = cur.fetchone()
print(f"  dateTime range: {mn} to {mx}")

cur.execute("SELECT dateTime, open, high, low, close, script, type, expiry FROM optionsdata ORDER BY dateTime")
rows = cur.fetchall()
print(f"\n  ALL {len(rows)} rows:")
for r in rows:
    print(f"    {r[0]} | O={r[1]} H={r[2]} L={r[3]} C={r[4]} | script={r[5]} | {r[6]} | expiry={r[7]}")

print("\n" + "=" * 60)
print("SPOTDATA - All unique values")
print("=" * 60)
cur.execute("SELECT DISTINCT stock FROM spotdata")
print("  stock:", [r[0] for r in cur.fetchall()])

cur.execute("SELECT MIN(dateTime), MAX(dateTime) FROM spotdata")
mn, mx = cur.fetchone()
print(f"  dateTime range: {mn} to {mx}")

cur.execute("SELECT dateTime, price FROM spotdata ORDER BY dateTime")
rows = cur.fetchall()
print(f"\n  ALL {len(rows)} rows:")
for r in rows:
    print(f"    {r[0]} | price={r[1]/100:.2f}")

conn.close()
