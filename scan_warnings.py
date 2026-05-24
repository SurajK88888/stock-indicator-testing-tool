"""
scan_warnings.py - Scans all backend Python files for SyntaxWarnings and logic issues.
Run: python scan_warnings.py
"""
import os, subprocess, sys

root = r'd:\Project\Stock Indicator Testing Tool\backend'
found_any = False

for dirpath, dirnames, filenames in os.walk(root):
    dirnames[:] = [d for d in dirnames if d not in ('venv', '__pycache__')]
    for fname in filenames:
        if not fname.endswith('.py'):
            continue
        fpath = os.path.join(dirpath, fname)
        r = subprocess.run(
            [sys.executable, '-W', 'error::SyntaxWarning', '-m', 'py_compile', fpath],
            capture_output=True, text=True
        )
        if r.returncode != 0 or r.stderr.strip():
            print(f'ISSUE in {fpath}:')
            print(r.stderr[:500])
            found_any = True
        else:
            print(f'OK: {fname}')

if not found_any:
    print('\nAll Python files passed SyntaxWarning check.')
