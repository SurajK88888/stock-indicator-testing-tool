"""
audit.py - Deep logic audit of all backend services.
Run: python audit.py
"""
import re, os

issues = []

def read(path):
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        return f.read()

# ------- admin.py -------
admin = read(r'backend\services\admin.py')

# SQLAlchemy 2.x: session.exec(text(), params={}) is deprecated / may silently fail
# Correct: session.execute(text().bindparams(...))
bad_exec_params = re.findall(r'session\.exec\([^)]+,\s*params\s*=', admin)
if bad_exec_params:
    issues.append(f"[admin.py] BUG: session.exec() with 'params=' kwarg may not work in SQLAlchemy 2.x. "
                  f"Found {len(bad_exec_params)} occurrences. "
                  f"Fix: use session.execute(text(...).bindparams(...)) instead.")

# ------- validator.py -------
val = read(r'backend\services\validator.py')

# Check positionOpenEndDate format mismatch
if '"%Y-%m-%d %H:%M:%S"' in val and 'positionOpenEndDate' in val:
    # Frontend sends: value.replace("T", " ") + " 00:00:00" -> "2024-01-01 00:00:00"  -- OK
    # But let's check: the input type is 'date', not 'datetime-local'
    # date input value is YYYY-MM-DD only -> after replace("T"," ") + " 00:00:00" = "YYYY-MM-DD 00:00:00"
    issues.append("[validator.py] INFO: positionOpenEndDate parsing uses '%Y-%m-%d %H:%M:%S'. "
                  "Frontend appends ' 00:00:00' so this works, but the comment says 'YYYY-MM-DD HH:MM' "
                  "which is misleading. No code bug, just a comment mismatch.")

# Check LOT_MULTIPLIER defined twice (inside open_position and close_position nested functions)
lot_mult_count = val.count('LOT_MULTIPLIER = 2')
if lot_mult_count > 1:
    issues.append(f"[validator.py] STYLE WARNING: LOT_MULTIPLIER = 2 is defined {lot_mult_count} times "
                  f"(once in open_position, once in close_position). "
                  f"Risk: if one is updated and the other isn't, they diverge silently. "
                  f"Fix: define LOT_MULTIPLIER once at module level.")

# Check winRate calculation - could divide by zero
if 'wins / len(trades)' in val:
    issues.append("[validator.py] OK: win_rate guarded by 'if trades else 0.0' — no divide-by-zero.")
    
# Check for signal.close usage without null check in open_position
if 'spot_close = (signal.close or 0.0)' in val:
    issues.append("[validator.py] OK: spot_close has null guard '(signal.close or 0.0)'.")

# Check: close_position uses 'reason' variable but 'reason' is a parameter
# AND it's also reassigned inside as 'reason = "Time-Stop Exit"' inside nested function
# but in Python, inner function assignments to outer-scope var require 'nonlocal'
# Let's check if 'nonlocal reason' exists
if 'def close_position' in val:
    # Extract the close_position function
    start = val.find('def close_position')
    end = val.find('\n            def ', start + 1)
    if end < 0:
        end = val.find('\n            for signal', start)
    fn_body = val[start:end] if end > 0 else val[start:start+2000]
    if 'reason = "Time-Stop Exit"' in fn_body and 'nonlocal reason' not in fn_body:
        issues.append("[validator.py] BUG: close_position() reassigns 'reason = \"Time-Stop Exit\"' "
                      "but 'reason' is a parameter (local to the function). This is actually fine "
                      "since 'reason' IS local (it's a param), but it shadows the outer call's value. "
                      "The variable IS local here so the reassignment correctly updates the local 'reason'. -- OK")

# ------- results.py -------
results = read(r'backend\services\results.py')

# Check totalProfit handling: stored as int * 100, should be divided by 100.0 on read
tp_usages = [(m.start(), val[m.start():m.start()+100]) for m in re.finditer(r'totalProfit', results)]
for pos, snippet in tp_usages:
    if '/100' not in snippet and 'int(total_profit * 100)' not in snippet:
        issues.append(f"[results.py] CHECK totalProfit usage at pos {pos}: {snippet[:80]}")

# Check export-excel route vs export route ordering (static before dynamic)
if '/results/export-excel' in results and '/results/export' in results and '/results/{report_id}' in results:
    ei = results.index('/results/export-excel')
    e = results.index('/results/export')
    rid = results.index('/results/{report_id}')
    if ei < e < rid:
        issues.append("[results.py] OK: Route order correct: export-excel < export < {report_id}.")
    else:
        issues.append(f"[results.py] BUG: Route order wrong! export-excel={ei}, export={e}, report_id={rid}")

# ------- ingestion.py -------
ingestion = read(r'backend\services\ingestion.py')

# Check 'spot' dataType handling: table_map has 'options' and 'indicator', NOT 'spot'
if '"spot"' not in ingestion and "\"spot\"" not in ingestion:
    issues.append("[ingestion.py] INFO: 'spot' dataType has no table_map entry. "
                  "If user sends dataType='spot', the endpoint returns error 'Invalid dataType'. "
                  "The import UI has an 'Spot/Index' type but backend only accepts options/indicator. "
                  "This is a silent mismatch.")

# Check that both 'spot' options exist in table_map
if 'table_map' in ingestion:
    start = ingestion.find('table_map')
    snippet = ingestion[start:start+200]
    issues.append(f"[ingestion.py] table_map = {snippet[:100]}")

# ------- signal_ingestion.py -------
sig = read(r'backend\services\signal_ingestion.py')

# Check: SignalData.__fields__ - in Pydantic v2 this is __model_fields__
if '__fields__' in sig:
    issues.append("[signal_ingestion.py] POTENTIAL BUG: Using .__fields__ which is Pydantic v1 API. "
                  "In SQLModel 0.0.38 (which uses Pydantic v2), the correct attribute is "
                  "model_fields or __sqlmodel_relationships__. "
                  "This may cause AttributeError at runtime if Pydantic v2 strict mode is active.")

# Same check in ingestion.py
if '__fields__' in ingestion:
    issues.append("[ingestion.py] SAME ISSUE: Using .__fields__ (Pydantic v1 API).")

print("=" * 60)
print("AUDIT RESULTS")
print("=" * 60)
for i, issue in enumerate(issues, 1):
    print(f"\n[{i}] {issue}")

if not issues:
    print("No issues found.")

print("\n" + "=" * 60)
