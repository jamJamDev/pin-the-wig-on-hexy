#!/bin/bash
# Spin up a throwaway public trial via Cloudflare's TryCloudflare service: starts
# an isolated copy of the stack (api + caddy) and opens an ephemeral
# https://<random>.trycloudflare.com URL to it -- no Cloudflare account, token, or
# DNS needed. Runs in the foreground; the generated URL prints below and Ctrl+C
# ends the trial and tears its stack down.
#
# Zero arguments. Runs under a separate Compose project with its own volume, so it
# never touches the production stack or its leaderboard data.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "Need Docker (with the compose plugin) for the trial." >&2
  exit 1
fi

PROJECT=ptwoh-trial
NET="${PROJECT}_edge"
# Same pinned cloudflared image the production stack uses.
CF_IMAGE="cloudflare/cloudflared@sha256:12ff5c6992a9863db4da270746af7c244bcaee49353039af8104268a18d6c4f0"

cleaned=0
cleanup() {
  [ "$cleaned" = 1 ] && return
  cleaned=1
  echo
  echo "=== ending trial -- tearing down the trial stack ==="
  docker compose -p "$PROJECT" down >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

echo "=== starting the trial origin (api + caddy) ==="
docker compose -p "$PROJECT" up -d api caddy

echo "=== waiting for caddy to become healthy ==="
cid="$(docker compose -p "$PROJECT" ps -q caddy)"
status=starting
for _ in $(seq 1 60); do
  status="$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo starting)"
  [ "$status" = healthy ] && break
  sleep 1
done
if [ "$status" != healthy ]; then
  echo "caddy did not become healthy (status: $status). Recent logs:" >&2
  docker compose -p "$PROJECT" logs --tail 30 caddy >&2 || true
  exit 1
fi
echo "caddy: healthy"

echo
echo "=== opening TryCloudflare tunnel -- watch for your URL below ==="
echo "    https://<random>.trycloudflare.com  (Ctrl+C to end the trial)"
echo
# The quick tunnel joins the trial's edge network so it reaches caddy directly by
# name; that is the in-container address of the origin (the Dockerized equivalent
# of pointing it at localhost:8080). --init so Ctrl+C stops cloudflared cleanly.
docker run --rm --init --network "$NET" "$CF_IMAGE" \
  tunnel --no-autoupdate --url http://caddy:8080
