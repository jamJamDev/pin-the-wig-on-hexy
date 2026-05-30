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
import subprocess
import sys
import threading
import traceback
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from leaderboard_store import LeaderboardStore  # noqa: E402

# Same-origin leaderboard API: the game and this server share a host, so no CORS.
API_PATH = "/api/leaderboard"
_MAX_BODY = 4096  # a leaderboard submission is a few dozen bytes; cap abuse

_STORE = None
_STORE_LOCK = threading.Lock()


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
        if urlsplit(self.path).path == API_PATH:
            return self._api_get()
        return super().do_GET()

    def do_POST(self):
        if urlsplit(self.path).path == API_PATH:
            return self._api_post()
        self.send_error(404, "Not found")

    def _api_get(self):
        try:
            board = _store().top()
        except Exception:
            traceback.print_exc()
            return self._send_json(500, {"error": "leaderboard unavailable"})
        return self._send_json(200, {"entries": board, "max": _store().max_entries})

    def _api_post(self):
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
        try:
            entry, rank, board, improved = _store().add(
                payload.get("initials"), payload.get("score"),
                bool(payload.get("god")), client_id=payload.get("client_id"))
        except ValueError as e:
            return self._send_json(400, {"error": str(e)})
        except Exception:
            traceback.print_exc()  # full stack to stderr; the cause may be load OR write
            return self._send_json(500, {"error": "leaderboard update failed"})
        return self._send_json(200, {
            "ok": True, "rank": rank, "improved": improved, "entry": entry,
            "entries": board, "max": _store().max_entries,
        })

    def _send_json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

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
    return [p for p in out.split() if p.strip()]


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    if len(sys.argv) > 2:
        os.chdir(sys.argv[2])
    try:
        httpd = ThreadingHTTPServer(("", port), RangeHandler)
    except OSError as exc:
        if exc.errno != errno.EADDRINUSE:
            raise  # an unexpected bind failure -- surface it loudly, don't mask
        # A leftover server (often an orphaned background run) still holds the
        # port. Don't crash with a traceback -- name the culprit and the fix.
        pids = port_holder_pids(port)
        sys.stderr.write(
            "error: port %d is already in use%s.\n"
            % (port, " by PID " + ", ".join(pids) if pids else "")
        )
        if pids:
            sys.stderr.write("  Stop it:  kill %s\n" % " ".join(pids))
        else:
            sys.stderr.write("  Find and stop it:  lsof -ti tcp:%d | xargs kill\n" % port)
        sys.stderr.write(
            "  Or serve elsewhere:  PORT=%d ./run_pin_the_wig_on_hexy.sh\n" % (port + 1)
        )
        sys.exit(1)
    print("Serving %s on http://localhost:%d/ (Range-enabled)" % (os.getcwd(), port))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
