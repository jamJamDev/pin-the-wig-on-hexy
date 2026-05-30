#!/bin/bash
# Starts the production stack in the background: api + caddy + the Cloudflare
# tunnel. Zero arguments. Public access needs a TUNNEL_TOKEN in .env (see
# .env.example) and a public-hostname route in the Cloudflare dashboard pointing
# at http://caddy:8080.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "Need Docker (with the compose plugin) to run the stack." >&2
  exit 1
fi

if [ ! -f .env ] || ! grep -q '^TUNNEL_TOKEN=.\+' .env 2>/dev/null; then
  echo "warning: no TUNNEL_TOKEN found in .env -- api + caddy will start, but the" >&2
  echo "         Cloudflare tunnel cannot connect until you add the token." >&2
  echo "         (cp .env.example .env, then paste the token from the dashboard.)" >&2
fi

docker compose up -d

echo
echo "Stack is up."
echo "  Status:        docker compose ps"
echo "  Tunnel logs:   docker compose logs -f cloudflared   (look for 'Registered tunnel connection')"
echo "  Stop:          docker compose down"
