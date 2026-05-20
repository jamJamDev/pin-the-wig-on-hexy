#!/bin/bash
# Serves "Pin the Wig on Hexy" as a local static site.
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8080}"
URL="http://localhost:${PORT}/"

if command -v python3 >/dev/null 2>&1; then
  SERVER=(python3 -m http.server "$PORT")
elif command -v python >/dev/null 2>&1; then
  SERVER=(python -m http.server "$PORT")
else
  echo "Need python3 (or python) to serve the game. Install Python or open index.html directly." >&2
  exit 1
fi

echo "Pin the Wig on Hexy -> ${URL}"
echo "Drop your art at assets/bald.png and assets/wig.png to use the real Hexy."
echo "Press Ctrl+C to stop."

( sleep 1
  if command -v open >/dev/null 2>&1; then open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
  fi ) >/dev/null 2>&1 &

exec "${SERVER[@]}"
