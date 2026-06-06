#!/usr/bin/env python3
"""Static file server with HTTP Range support, for local development.

Python's stock ``http.server`` ignores ``Range`` requests and answers every
GET with the whole file and ``200 OK``. That breaks forward-seeking in large
media: the radio player seeks to a live wall-clock offset on unmute, and
without Range the browser cannot fetch the bytes at that offset, so playback
falls back to the start of the track. Real static hosts (GitHub Pages, nginx,
S3, Netlify) all honor Range, so this only bites local dev -- this server
closes that gap so local playback matches production.

Zero dependencies (stdlib only). Zero required arguments: ``python3
scripts/dev_server.py [port] [directory]`` (defaults: 8080, current dir).
"""
import errno
import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
import traceback
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from broadcast_store import BroadcastStore, verify_admin_token  # noqa: E402
from leaderboard_store import LeaderboardStore, OwnershipError  # noqa: E402
from rate_limit import RateLimiter  # noqa: E402
import submission_token  # noqa: E402

# Same-origin leaderboard API: the game and this server share a host, so no CORS.
API_PATH = "/api/leaderboard"
# Operator broadcast channel: GET polls the active flash message, POST (admin
# token) publishes or clears it. Same origin as the game, so no CORS.
BROADCAST_PATH = "/api/broadcast"
_MAX_BODY = 4096  # a leaderboard submission is a few dozen bytes; cap abuse
_MAX_BROADCAST_BODY = 1024  # a broadcast line + ttl is tiny; cap abuse

# The shared secret that gates broadcast publishing. Read once at startup from
# the environment; blank/unset means the feature is dormant -- GET still answers
# (empty), but every POST is refused so an unconfigured server can never be
# driven. Never logged or returned by the API.
_ADMIN_TOKEN = os.environ.get("PTWOH_ADMIN_TOKEN") or ""

_STORE = None
_STORE_LOCK = threading.Lock()

# Process-local active broadcast. Transient by design (an operator's live stream
# chatter), so it lives in memory only -- nothing to persist on the read-only fs.
_BROADCAST = BroadcastStore()

# In-process backstop to the Cloudflare edge rate-limit rule on the only public
# write endpoint. A burst of 10, then ~6/min sustained per client -- orders of
# magnitude above any real player, but it throttles scripted leaderboard spam
# even if the edge rule is misconfigured or absent.
_POST_LIMITER = RateLimiter(capacity=10, refill_per_sec=0.1)

# Broadcast publishing is operator-driven and bursty (rapid-fire messages while
# messing with a streamer), so a generous burst with a steady refill -- still a
# hard backstop should the admin token ever leak.
_BROADCAST_LIMITER = RateLimiter(capacity=20, refill_per_sec=1.0)

# Single-use nonce ledger so a captured submission cannot be replayed within the
# signing window. Bounded by submission_token.WINDOW_MS eviction.
_NONCES = submission_token.NonceCache()


def _store():
    """Lazily build the file-backed store under the served root (post-chdir)."""
    global _STORE
    if _STORE is None:
        with _STORE_LOCK:
            if _STORE is None:
                _STORE = LeaderboardStore(
                    os.path.join(os.getcwd(), "data", "leaderboard.json"))
    return _STORE


class RangeHandler(SimpleHTTPRequestHandler):
    # ---- Leaderboard API ----
    def do_GET(self):
        path = urlsplit(self.path).path
        if path == API_PATH:
            return self._api_get()
        if path == BROADCAST_PATH:
            return self._broadcast_get()
        return super().do_GET()

    def do_POST(self):
        path = urlsplit(self.path).path
        if path == API_PATH:
            return self._api_post()
        if path == BROADCAST_PATH:
            return self._broadcast_post()
        self.send_error(404, "Not found")

    def _api_get(self):
        try:
            board = _store().top()
        except Exception:
            traceback.print_exc()
            return self._send_json(500, {"error": "leaderboard unavailable"})
        return self._send_json(200, {"entries": board, "max": _store().max_entries})

    def _client_key(self):
        """Best-effort client identity for rate limiting.

        Behind the tunnel, Cloudflare sets ``CF-Connecting-IP`` and Caddy forwards
        ``X-Forwarded-For``; these are trustworthy ONLY because the origin
        publishes no ports and is reachable solely through the tunnel. On direct
        local access (no proxy headers) we fall back to the peer address.
        """
        cf = self.headers.get("CF-Connecting-IP")
        if cf:
            return cf.strip()
        xff = self.headers.get("X-Forwarded-For")
        if xff:
            return xff.split(",")[0].strip()
        return self.client_address[0] if self.client_address else "unknown"

    def _api_post(self):
        key = self._client_key()
        if not _POST_LIMITER.allow(key):
            return self._send_json(
                429, {"error": "too many submissions; slow down"},
                extra_headers={"Retry-After": str(_POST_LIMITER.retry_after(key))})
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > _MAX_BODY:
            return self._send_json(400, {"error": "invalid request body"})
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return self._send_json(400, {"error": "malformed JSON"})
        if not isinstance(payload, dict):
            return self._send_json(400, {"error": "expected a JSON object"})
        # Signed-submission gate: a valid HMAC over the run, a fresh timestamp,
        # and an unused nonce. Turns away unsigned scripted POSTs and replays.
        initials = payload.get("initials")
        score = payload.get("score")
        god = bool(payload.get("god"))
        nonce = payload.get("nonce")
        ts = payload.get("ts")
        owner = payload.get("owner")
        sig = payload.get("sig")
        if not isinstance(owner, str) or not owner:
            return self._send_json(400, {"error": "missing owner token"})
        if not submission_token.fresh(ts):
            return self._send_json(400, {"error": "stale submission; refresh and retry"})
        if not submission_token.verify(initials, score, god, nonce, ts, owner, sig):
            return self._send_json(403, {"error": "submission signature invalid"})
        if not _NONCES.check_and_remember(nonce):
            return self._send_json(409, {"error": "duplicate submission"})
        try:
            entry, rank, board, improved = _store().add(
                initials, score, god, owner_token=owner)
        except OwnershipError as e:
            return self._send_json(403, {"error": str(e)})
        except ValueError as e:
            return self._send_json(400, {"error": str(e)})
        except Exception:
            traceback.print_exc()  # full stack to stderr; the cause may be load OR write
            return self._send_json(500, {"error": "leaderboard update failed"})
        return self._send_json(200, {
            "ok": True, "rank": rank, "improved": improved, "entry": entry,
            "entries": board, "max": _store().max_entries,
        })

    # ---- Operator broadcast API ----
    def _broadcast_get(self):
        # Polled by every client a few times a minute; a cheap in-memory read.
        # Unauthenticated and unthrottled on purpose -- it only reveals the
        # operator's own message, which is meant to be seen by everyone.
        return self._send_json(200, _BROADCAST.current())

    def _broadcast_post(self):
        if not _ADMIN_TOKEN:
            # Fail loud: an operator who set no token gets a clear reason rather
            # than a silently ignored POST.
            return self._send_json(
                503, {"error": "broadcasting is not configured on this server"})
        if not verify_admin_token(self.headers.get("X-Admin-Token"), _ADMIN_TOKEN):
            return self._send_json(403, {"error": "invalid admin token"})
        key = self._client_key()
        if not _BROADCAST_LIMITER.allow(key):
            return self._send_json(
                429, {"error": "too many broadcasts; slow down"},
                extra_headers={"Retry-After": str(_BROADCAST_LIMITER.retry_after(key))})
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > _MAX_BROADCAST_BODY:
            return self._send_json(400, {"error": "invalid request body"})
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return self._send_json(400, {"error": "malformed JSON"})
        if not isinstance(payload, dict):
            return self._send_json(400, {"error": "expected a JSON object"})
        if payload.get("clear"):
            return self._send_json(200, dict(ok=True, **_BROADCAST.clear()))
        try:
            result = _BROADCAST.publish(payload.get("text"), payload.get("ttl_ms"))
        except ValueError as e:
            return self._send_json(400, {"error": str(e)})
        return self._send_json(200, dict(ok=True, **result))

    def _send_json(self, code, obj, extra_headers=None):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for name, value in (extra_headers or {}).items():
            self.send_header(name, value)
        self._cache_header_set = True  # don't let end_headers add a second one
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def end_headers(self):
        # Local dev: force the browser to revalidate every response so an edited
        # file is never served stale from cache (the stock handler sends no
        # Cache-Control, so browsers cache JS/CSS heuristically and show old
        # code after a save). "no-cache" still allows cheap 304s for unchanged
        # files. API responses set their own Cache-Control above -- don't stomp.
        if not getattr(self, "_cache_header_set", False):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    # ---- Static files with Range support ----
    def send_head(self):
        rng = self.headers.get("Range")
        if not rng:
            return super().send_head()

        path = self.translate_path(self.path)
        # Directories and missing files: let the base handler answer (listings,
        # redirects, 404s) -- Range only applies to a concrete file.
        if os.path.isdir(path) or not os.path.isfile(path):
            return super().send_head()

        try:
            f = open(path, "rb")
        except OSError:
            self.send_error(404, "File not found")
            return None

        try:
            size = os.fstat(f.fileno()).st_size
            start, end = self._parse_range(rng, size)
            if start is None:
                self.send_response(416)
                self.send_header("Content-Range", "bytes */%d" % size)
                self.send_header("Content-Length", "0")
                self.end_headers()
                f.close()
                return None

            length = end - start + 1
            self.send_response(206)
            self.send_header("Content-Type", self.guess_type(path))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
            self.send_header("Content-Length", str(length))
            self.end_headers()
            f.seek(start)
            self._range_remaining = length
            return f
        except Exception:
            f.close()
            raise

    def copyfile(self, source, outputfile):
        # When send_head served a range, emit only that many bytes.
        remaining = getattr(self, "_range_remaining", None)
        if remaining is None:
            return super().copyfile(source, outputfile)
        self._range_remaining = None
        while remaining > 0:
            chunk = source.read(min(64 * 1024, remaining))
            if not chunk:
                break
            outputfile.write(chunk)
            remaining -= len(chunk)

    @staticmethod
    def _parse_range(header, size):
        # Single range only: "bytes=start-end", "bytes=start-", "bytes=-suffix".
        units, _, spec = header.partition("=")
        if units.strip().lower() != "bytes" or "," in spec:
            return None, None
        start_s, _, end_s = spec.partition("-")
        start_s, end_s = start_s.strip(), end_s.strip()
        try:
            if start_s == "":
                suffix = int(end_s)
                if suffix <= 0:
                    return None, None
                start = max(0, size - suffix)
                end = size - 1
            else:
                start = int(start_s)
                end = int(end_s) if end_s else size - 1
        except ValueError:
            return None, None
        if start < 0 or start >= size:
            return None, None
        end = min(end, size - 1)
        if end < start:
            return None, None
        return start, end


def port_holder_pids(port):
    """Best-effort PIDs of whatever is listening on ``port`` (via lsof).

    Returns an empty list when lsof is missing or reveals nothing, so callers
    degrade to a generic hint rather than failing.
    """
    lsof = shutil.which("lsof")
    if not lsof:
        return []
    try:
        out = subprocess.run(
            [lsof, "-nP", "-iTCP:%d" % port, "-sTCP:LISTEN", "-t"],
            capture_output=True, text=True, timeout=3,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    pids = []
    for tok in out.split():
        try:
            pids.append(int(tok))
        except ValueError:
            pass
    return pids


def is_our_dev_server(pid):
    """True only when ``pid`` is another run of THIS server.

    We reclaim our own orphaned instance but never kill an unrelated process
    that merely happens to sit on the port -- so the auto-kill is verified by
    command line, not assumed from the port alone.
    """
    if pid == os.getpid():
        return False
    try:
        out = subprocess.run(
            ["ps", "-p", str(pid), "-o", "command="],
            capture_output=True, text=True, timeout=3,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    return "dev_server.py" in out


def try_bind(port):
    """Bind the server, or return None if the port is already in use."""
    try:
        return ThreadingHTTPServer(("", port), RangeHandler)
    except OSError as exc:
        if exc.errno != errno.EADDRINUSE:
            raise  # an unexpected bind failure -- surface it loudly, don't mask
        return None


def reclaim_port(port, pids):
    """Stop previous instances of this server and wait for the port to free.

    Escalates SIGTERM -> SIGKILL, retrying the bind between signals. Returns a
    bound server on success, or None if the port could not be reclaimed.
    """
    print(
        "Port %d held by a previous dev server (PID %s) -- stopping it."
        % (port, ", ".join(str(p) for p in pids)),
        flush=True,  # always surface the takeover, even when stdout is redirected
    )
    for sig in (signal.SIGTERM, signal.SIGKILL):
        for pid in pids:
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                pass  # already gone -- the bind retry below will pick it up
            except (PermissionError, OSError):
                return None  # cannot signal it; fall back to the manual hint
        for _ in range(15):  # give the OS up to ~3s to release the socket
            time.sleep(0.2)
            server = try_bind(port)
            if server is not None:
                return server
    return None


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    if len(sys.argv) > 2:
        os.chdir(sys.argv[2])
    httpd = try_bind(port)
    if httpd is None:
        # Port busy. Auto-reclaim it when a previous instance of THIS server is
        # squatting (the common case: an orphaned background run). Anything else
        # on the port is left untouched, with an actionable hint instead.
        holders = port_holder_pids(port)
        ours = [p for p in holders if is_our_dev_server(p)]
        if ours:
            httpd = reclaim_port(port, ours)
    if httpd is None:
        holders = port_holder_pids(port)
        sys.stderr.write(
            "error: port %d is already in use%s.\n"
            % (port, " by PID " + ", ".join(str(p) for p in holders) if holders else "")
        )
        if holders:
            sys.stderr.write("  Stop it:  kill %s\n" % " ".join(str(p) for p in holders))
        else:
            sys.stderr.write("  Find and stop it:  lsof -ti tcp:%d | xargs kill\n" % port)
        sys.stderr.write(
            "  Or serve elsewhere:  PORT=%d ./run_pin_the_wig_on_hexy.sh\n" % (port + 1)
        )
        sys.exit(1)
    print("Serving %s on http://localhost:%d/ (Range-enabled)" % (os.getcwd(), port))

    def _graceful_shutdown(_signum, _frame):
        # `docker stop` sends SIGTERM (not SIGINT); shut down cleanly so an
        # in-flight leaderboard write finishes instead of waiting for SIGKILL.
        # shutdown() must run off the serving thread, so hand it to a worker.
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, _graceful_shutdown)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
