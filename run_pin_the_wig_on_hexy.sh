#!/bin/bash
# Serves "Pin the Wig on Hexy" as a local static site.
set -euo pipefail
cd "$(dirname "$0")"

# Keep the radio + voice-line manifests in sync with whatever is actually in
# assets/music/ and assets/voicelines/, so dropping in, renaming, or removing a
# track "just works" on the next launch instead of 404-stalling on a stale entry.
# Best-effort: a generator hiccup must never block the game from starting.
if [ -f scripts/build_audio_manifests.sh ]; then
  if ! bash scripts/build_audio_manifests.sh; then
    echo "warning: could not rebuild audio manifests; serving the existing ones." >&2
  fi
fi

PORT="${PORT:-8080}"
URL="http://localhost:${PORT}/"

# Use the Range-capable dev server (scripts/dev_server.py) so the radio player's
# seek-to-live-position works on large media -- stock `python -m http.server`
# ignores Range requests and forces playback to restart from 0.
if command -v python3 >/dev/null 2>&1; then
  SERVER=(python3 scripts/dev_server.py "$PORT")
elif command -v python >/dev/null 2>&1; then
  SERVER=(python scripts/dev_server.py "$PORT")
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
