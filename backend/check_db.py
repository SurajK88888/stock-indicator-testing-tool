import sqlite3

db_path = "database.db"
conn = sqlite3.connect(db_path)
cursor = conn.cursor()

# List all tables with row counts
cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
tables = [t[0] for t in cursor.fetchall()]

print("=== DATABASE SUMMARY ===")
for name in tables:
    cursor.execute(f'SELECT COUNT(*) FROM "{name}"')
    count = cursor.fetchone()[0]
    print(f"\n  TABLE: {name}  ({count} rows)")
    if count > 0:
        # Show column names
        cursor.execute(f'PRAGMA table_info("{name}")')
        cols = [c[1] for c in cursor.fetchall()]
        print(f"  COLUMNS: {cols}")
        # Show first 3 rows
        cursor.execute(f'SELECT * FROM "{name}" LIMIT 3')
        rows = cursor.fetchall()
        for row in rows:
            print(f"  ROW: {row}")

conn.close()
