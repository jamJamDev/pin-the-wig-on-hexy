#!/bin/bash
# Flash a short message over every connected player's screen (or clear it).
#
# This is the operator side of the broadcast feature: it POSTs to the game's
# /api/broadcast endpoint with the admin token. Every player's browser polls
# that endpoint a few times a minute and shows the message in large letters over
# the game, without covering or blocking gameplay (see src/js/broadcast.js).
#
# Run with NO arguments for an interactive menu (send / clear / change URL).
# Or drive it directly with flags:
#   ./scripts/broadcast.sh "PIN IT FASTER, HEXY IS WAITING"
#   ./scripts/broadcast.sh --seconds 30 "Stay on target for 30s"
#   ./scripts/broadcast.sh -s 999 "this stays up until you send the next one"
#   ./scripts/broadcast.sh --clear
#   ./scripts/broadcast.sh --url https://your-host "live now"
#
# Duration: -s/--seconds sets how long the message shows (default 12s, max 3600).
# Sending another message replaces the current one immediately; --clear takes it
# down. The admin token is read from $PTWOH_ADMIN_TOKEN, or from PTWOH_ADMIN_TOKEN
# in the root .env. The target base URL comes from $PTWOH_BROADCAST_URL (env or
# the root .env), falling back to https://hexy.obju.red; override per-run with
# --url. The message is sent as JSON built with jq, so quotes and special
# characters are escaped safely.
set -euo pipefail
cd "$(dirname "$0")/.."

for tool in curl jq; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Need $tool to send a broadcast." >&2; exit 1; }
done

DEFAULT_SECONDS=12
DEFAULT_URL="https://hexy.obju.red"
URL=""        # resolved below from env / .env / default; --url overrides
TTL=""        # display window in milliseconds (server clamps to [1s, 3600s])
SECS=""       # display window in seconds (operator-friendly; converted to TTL)
CLEAR=0
MSG=""

usage() {
  # Print the header comment block (everything up to the first `set` line).
  sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

# Admin token: prefer the environment, else the gitignored root .env. Echoes the
# token (empty when none is configured); callers decide how to treat "no token".
resolve_token() {
  if [ -n "${PTWOH_ADMIN_TOKEN:-}" ]; then
    printf '%s' "$PTWOH_ADMIN_TOKEN"
    return 0
  fi
  [ -f .env ] || return 0
  grep -E '^PTWOH_ADMIN_TOKEN=' .env 2>/dev/null | head -n1 | cut -d= -f2- || true
}

# Target base URL: prefer the environment, else PTWOH_BROADCAST_URL in the root
# .env, else DEFAULT_URL. An explicit --url overrides whatever this returns.
resolve_url() {
  local from_env
  if [ -n "${PTWOH_BROADCAST_URL:-}" ]; then
    printf '%s' "$PTWOH_BROADCAST_URL"
    return 0
  fi
  if [ -f .env ]; then
    from_env="$(grep -E '^PTWOH_BROADCAST_URL=' .env 2>/dev/null | head -n1 | cut -d= -f2- || true)"
    if [ -n "$from_env" ]; then
      printf '%s' "$from_env"
      return 0
    fi
  fi
  printf '%s' "$DEFAULT_URL"
}

# Convert a whole number of seconds into the millisecond TTL the server expects.
# Echoes the TTL; returns 1 (echoing nothing) on non-numeric input.
seconds_to_ttl() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
    *)           printf '%s' "$(( $1 * 1000 ))" ;;
  esac
}

# POST a prepared JSON body to the broadcast endpoint. Captures body + HTTP status
# together so a rejection surfaces the server's reason (fail loud) instead of curl
# swallowing it under -f. Returns non-zero (and prints why) on anything but 200.
post_broadcast() {
  local body="$1" token resp code payload err
  token="$(resolve_token)"
  if [ -z "$token" ]; then
    echo "No admin token. Set PTWOH_ADMIN_TOKEN (env or .env) -- see .env.example." >&2
    return 1
  fi
  resp="$(curl -sS -w $'\n%{http_code}' \
    -X POST "$URL/api/broadcast" \
    -H "Content-Type: application/json" \
    -H "X-Admin-Token: $token" \
    --data "$body")"
  code="${resp##*$'\n'}"
  payload="${resp%$'\n'*}"
  [ "$code" = "200" ] && return 0
  err="$(printf '%s' "$payload" | jq -r '.error // empty' 2>/dev/null || true)"
  echo "Broadcast failed (HTTP $code): ${err:-$payload}" >&2
  return 1
}

# Send one message. $2 is the millisecond TTL, or empty to let the server default.
send_message() {
  local msg="$1" ttl="$2" body
  if [ -n "$ttl" ]; then
    body="$(jq -nc --arg t "$msg" --argjson ttl "$ttl" '{text:$t, ttl_ms:$ttl}')"
  else
    body="$(jq -nc --arg t "$msg" '{text:$t}')"
  fi
  post_broadcast "$body" || return 1
  echo "Flashed to all players: $msg"
}

clear_message() {
  post_broadcast '{"clear":true}' || return 1
  echo "Cleared the broadcast."
}

# --- interactive menu (shown when run with no arguments on a terminal) ---

menu_send() {
  local msg secs ttl
  read -rp "Message: " msg || { echo; return 0; }
  if [ -z "$msg" ]; then
    echo "Nothing entered; not sending." >&2
    return 0
  fi
  read -rp "Show for how many seconds [$DEFAULT_SECONDS]: " secs || { echo; return 0; }
  secs="${secs:-$DEFAULT_SECONDS}"
  if ! ttl="$(seconds_to_ttl "$secs")"; then
    echo "Seconds must be a whole number; not sending." >&2
    return 0
  fi
  send_message "$msg" "$ttl" || true   # a failed send must not exit the menu
}

menu_set_url() {
  local new
  read -rp "Target base URL [$URL]: " new || { echo; return 0; }
  [ -n "$new" ] && URL="${new%/}"
}

interactive_menu() {
  local choice token_state
  while true; do
    if [ -n "$(resolve_token)" ]; then
      token_state="configured"
    else
      token_state="NOT SET -- sending will fail until PTWOH_ADMIN_TOKEN is set"
    fi
    cat <<MENU

=== Broadcast to Pin the Wig players ===
  Target : $URL
  Token  : $token_state

  1) Send a message
  2) Clear the current broadcast
  3) Change target URL
  q) Quit
MENU
    read -rp "Choose [1]: " choice || { echo; return 0; }
    case "${choice:-1}" in
      1)             menu_send ;;
      2)             clear_message || true ;;   # keep the menu alive on failure
      3)             menu_set_url ;;
      q|Q|quit|exit) return 0 ;;
      *)             echo "Unknown choice: $choice" >&2 ;;
    esac
  done
}

URL="$(resolve_url)"   # env / .env / default; --url below overrides this

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help)    usage 0 ;;
    --clear)      CLEAR=1; shift ;;
    --url)        URL="${2:?--url needs a value}"; shift 2 ;;
    -s|--seconds) SECS="${2:?--seconds needs a value}"; shift 2 ;;
    --ttl)        TTL="${2:?--ttl needs a value}"; shift 2 ;;
    --)           shift; MSG="$*"; break ;;
    -*)           echo "Unknown option: $1" >&2; usage 1 ;;
    *)            MSG="$*"; break ;;   # first non-flag arg onward is the message
  esac
done

URL="${URL%/}"   # drop a trailing slash so we don't build //api

# No message and no --clear: open the interactive menu when attached to a
# terminal; otherwise (piped/cron) print usage so we never block on a read.
if [ "$CLEAR" -eq 0 ] && [ -z "$MSG" ]; then
  if [ -t 0 ] && [ -t 1 ]; then
    interactive_menu
    exit 0
  fi
  echo "Nothing to send. Pass a message, or use --clear to take it down." >&2
  usage 1
fi

# One-shot (flag/argument) path. Explicit --ttl (ms) wins over --seconds.
if [ -z "$TTL" ] && [ -n "$SECS" ]; then
  if ! TTL="$(seconds_to_ttl "$SECS")"; then
    echo "--seconds must be a whole number of seconds." >&2
    exit 1
  fi
fi

if [ "$CLEAR" -eq 1 ]; then
  clear_message
else
  send_message "$MSG" "$TTL"
fi
