import sqlite3
import os

# Set DB path relative to script
db_path = os.path.join(os.path.dirname(__file__), "database.db")
print(f"Connecting to: {db_path}")

conn = sqlite3.connect(db_path)
cursor = conn.cursor()

tables_to_update = ["spotdata", "optionsdata", "indicatordata"]

for table in tables_to_update:
    try:
        # Check if column already exists
        cursor.execute(f'PRAGMA table_info("{table}")')
        cols = [c[1] for c in cursor.fetchall()]
        
        if "updated_on" not in cols:
            print(f"Adding 'updated_on' column to '{table}'...")
            # In SQLite, we can add a column with a default value
            # Since we want it to be NULL for old data (or current time), 
            # we'll just add it.
            cursor.execute(f'ALTER TABLE "{table}" ADD COLUMN updated_on DATETIME')
            print(f"✓ Added to {table}")
        else:
            print(f"Column 'updated_on' already exists in '{table}'")
    except Exception as e:
        print(f"Error updating {table}: {e}")

conn.commit()
conn.close()
print("\nMigration complete.")
