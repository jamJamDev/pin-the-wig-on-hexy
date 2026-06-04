#!/bin/bash
# Stops every server this repo can start: the production stack (run.sh /
# start_server.sh) and the throwaway trial stack (run_trial.sh), plus any leftover
# TryCloudflare quick-tunnel container. Named volumes (the leaderboard) are kept.
#
# Zero arguments. Safe to run when nothing is up -- it just reports nothing to stop.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "Need Docker (with the compose plugin) to stop the stack." >&2
  exit 1
fi

stopped_any=0

for project in ptwoh ptwoh-trial; do
  # Only act if the project actually has containers, so the output stays honest.
  if [ -n "$(docker compose -p "$project" ps -aq 2>/dev/null)" ]; then
    echo "=== stopping project: $project ==="
    docker compose -p "$project" down
    stopped_any=1
  fi
done

# Best-effort: a TryCloudflare quick tunnel from run_trial.sh runs as a standalone
# container (not compose-managed). Match it by its `--url` quick-tunnel command so
# the token-based production tunnel (which runs `tunnel ... run`) is never touched.
strays="$(docker ps --no-trunc --format '{{.ID}} {{.Command}}' 2>/dev/null \
  | grep -- '--url' | grep -i 'tunnel' | awk '{print $1}' || true)"
if [ -n "$strays" ]; then
  echo "=== stopping leftover quick-tunnel container(s) ==="
  docker stop $strays >/dev/null
  stopped_any=1
fi

echo
if [ "$stopped_any" = 1 ]; then
  echo "All servers stopped. Data volumes kept (leaderboard preserved)."
  echo "  Wipe trial data too:  docker compose -p ptwoh-trial down -v"
else
  echo "Nothing to stop -- no ptwoh servers are running."
fi
