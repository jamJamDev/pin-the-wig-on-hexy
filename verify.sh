#!/bin/bash
# Verifies the production stack locally WITHOUT the tunnel. Builds and starts
# api+caddy in an isolated throwaway compose project (separate volumes, so the
# real leaderboard is never touched), then probes the static + API + cache +
# Range + rate-limit behavior over the internal network exactly as cloudflared
# would reach it, and tears everything down. Zero arguments; non-zero on any
# failed check.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "Need Docker (with the compose plugin) to verify the stack." >&2
  exit 1
fi

PROJECT=ptwoh-verify
cleanup() { docker compose -p "$PROJECT" down -v >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "=== building + starting api + caddy (isolated project: $PROJECT) ==="
docker compose -p "$PROJECT" up -d --build api caddy

echo "=== waiting for caddy to become healthy ==="
cid=$(docker compose -p "$PROJECT" ps -q caddy)
status=starting
for _ in $(seq 1 30); do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo starting)
  [ "$status" = healthy ] && break
  sleep 1
done
if [ "$status" != healthy ]; then
  echo "caddy did not become healthy in time (status: $status)" >&2
  docker compose -p "$PROJECT" logs caddy >&2 || true
  exit 1
fi

echo "=== probing over the internal network (from the api container) ==="
docker compose -p "$PROJECT" exec -T api python3 - <<'PY'
import json, sys, time, urllib.error, urllib.parse, urllib.request

BASE = "http://caddy:8080"
fails = []

sys.path.insert(0, "/app/scripts")
import submission_token as T  # the same signer the API verifies against


def signed(initials, score, god, owner, nonce):
    """A POST body carrying a valid HMAC signature, as a real client would send."""
    ts = int(time.time() * 1000)
    sig = T.sign(initials, score, god, nonce, ts, owner)
    return json.dumps({"initials": initials, "score": score, "god": god,
                       "nonce": nonce, "ts": ts, "owner": owner, "sig": sig}).encode()


def req(path, method="GET", data=None, headers=None):
    h = {"Accept": "*/*"}
    if headers:
        h.update(headers)
    r = urllib.request.Request(BASE + path, method=method, data=data, headers=h)
    try:
        resp = urllib.request.urlopen(r, timeout=5)
        return resp.status, resp.headers, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()


def has(headers, name):
    return name.lower() in {k.lower() for k in headers.keys()}


def check(name, ok, detail=""):
    line = ("PASS" if ok else "FAIL") + " - " + name
    if not ok and detail:
        line += "  [" + detail + "]"
    print(line)
    if not ok:
        fails.append(name)


# 1. static entrypoint + security headers + no Server leak
st, hd, _ = req("/index.html")
check("GET /index.html -> 200", st == 200, "got %s" % st)
check("CSP header present", has(hd, "content-security-policy"))
check("Server header stripped", not has(hd, "server"), hd.get("Server", ""))

# 2. immutable media caching
st, hd, _ = req("/assets/hexy_logo_no_bg.png")
cc = hd.get("Cache-Control", "")
check("asset -> 200", st == 200, "got %s" % st)
check("asset Cache-Control immutable", "immutable" in cc and "31536000" in cc, cc)

# 3. manifest must revalidate (so new/removed tracks appear)
st, hd, mbody = req("/assets/music/manifest.json")
cc = hd.get("Cache-Control", "")
check("manifest -> 200", st == 200, "got %s" % st)
check("manifest Cache-Control no-cache", "no-cache" in cc, cc)

# 4. HTTP Range on an audio file (radio seek depends on this; must NOT be gzipped)
track = None
try:
    track = (json.loads(mbody).get("tracks") or [{}])[0].get("file")
except Exception:
    pass
if track:
    st, hd, _ = req("/assets/music/" + urllib.parse.quote(track),
                    headers={"Range": "bytes=0-1023"})
    check("Range request -> 206", st == 206, "got %s for %r" % (st, track))
    check("Content-Range present", has(hd, "content-range"))
    check("audio not gzipped", hd.get("Content-Encoding", "") == "",
          hd.get("Content-Encoding", ""))
else:
    check("found a track to Range-test", False, "no track in manifest")

# 5. text compression
st, hd, _ = req("/src/js/game.js", headers={"Accept-Encoding": "gzip"})
check("game.js -> 200", st == 200, "got %s" % st)
check("game.js gzip-encoded", hd.get("Content-Encoding", "") == "gzip",
      hd.get("Content-Encoding", ""))

# 6. API GET is dynamic (never cached)
st, hd, _ = req("/api/leaderboard")
cc = hd.get("Cache-Control", "")
check("API GET -> 200", st == 200, "got %s" % st)
check("API Cache-Control no-store", "no-store" in cc, cc)

# 7. API POST accepts a valid signed score
payload = signed("VFY", 4242, False, "verify-owner", "verify-nonce-1")
st, _, body = req("/api/leaderboard", method="POST", data=payload,
                  headers={"Content-Type": "application/json"})
ok = False
try:
    ok = st == 200 and json.loads(body).get("ok") is True
except Exception:
    pass
check("API POST valid -> ok:true", ok, "got %s" % st)

# 8. malformed body is rejected
st, _, _ = req("/api/leaderboard", method="POST", data=b"not json",
               headers={"Content-Type": "application/json"})
check("API POST malformed -> 400", st == 400, "got %s" % st)

# 9. rate limiter trips under a flood
codes = []
for i in range(14):
    p = signed("FLD", 1000 + i, False, "verify-flood-owner", "flood-nonce-%d" % i)
    s, _, _ = req("/api/leaderboard", method="POST", data=p,
                  headers={"Content-Type": "application/json"})
    codes.append(s)
check("rate limiter returns 429 under flood", 429 in codes, "codes=%s" % codes)

print()
if fails:
    print("VERIFY FAILED: %d check(s) failed -> %s" % (len(fails), ", ".join(fails)))
    sys.exit(1)
print("VERIFY PASSED: all checks green")
PY

echo
echo "Local verification complete."
