#!/bin/bash
# Runs the unit suite for "Pin the Wig on Hexy" (Node built-in test runner).
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Need Node.js (>=18) to run the test suite." >&2
  exit 1
fi

exec node --test tests/*.test.js
