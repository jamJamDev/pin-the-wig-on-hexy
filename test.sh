#!/bin/bash
# Runs the unit suite for "Pin the Wig on Hexy": the Node pure-logic modules and
# the Python leaderboard store. Both must pass for the suite to be green.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Need Node.js (>=18) to run the test suite." >&2
  exit 1
fi

echo "=== node tests ==="
node --test tests/*.test.js

if ls tests/test_*.py >/dev/null 2>&1; then
  PY=python3
  command -v python3 >/dev/null 2>&1 || PY=python
  if command -v "$PY" >/dev/null 2>&1; then
    echo "=== python tests ==="
    "$PY" -m unittest discover -s tests -p 'test_*.py'
  else
    echo "Skipping python tests: no python interpreter found." >&2
  fi
fi
