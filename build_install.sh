#!/bin/bash
# Builds the production container stack: the leaderboard API image, plus the
# pinned edge images (Caddy, cloudflared). Zero arguments -- a bare run does the
# full build/pull. Run ./verify.sh next to smoke-test it locally.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "Need Docker (with the compose plugin) to build the stack." >&2
  exit 1
fi

echo "=== building the API image ==="
docker compose build

echo "=== pulling pinned edge images (Caddy, cloudflared) ==="
docker compose pull caddy cloudflared

echo
echo "Build complete."
echo "  1. cp .env.example .env  and paste your Cloudflare TUNNEL_TOKEN"
echo "  2. ./verify.sh           (local smoke test, no tunnel)"
echo "  3. ./run.sh              (start the stack + tunnel)"
