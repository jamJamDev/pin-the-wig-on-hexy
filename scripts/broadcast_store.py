"""In-memory broadcast channel for the Pin the Wig server.

Lets a single operator flash a short text message over every connected player's
screen in near real time. The server holds ONE active broadcast at a time: a
sanitized line, a monotonically increasing sequence number, and an expiry. Every
client polls ``GET /api/broadcast`` a few times a minute and shows the message
while it is active; ``POST /api/broadcast`` (admin-token gated) publishes or
clears it. State is process-local and intentionally transient -- a broadcast is
"mess with the stream right now" chatter, not data worth persisting, so nothing
touches disk (the api container runs read-only).

The pure helpers (``sanitize_text``, ``clamp_ttl``, ``verify_admin_token``) carry
the message-shaping and auth rules and are validated directly in tests.
``BroadcastStore`` adds the I/O shell: a lock so the ``ThreadingHTTPServer``
cannot interleave a read with a publish, and an injected clock so TTL expiry is
deterministic under test. Stdlib only.

``sanitize_text`` is mirrored in ``src/js/broadcast.js`` so the client and server
shape a message identically (no build step shares one source).
"""
import hmac
import threading
import time

# A flashed line is short by design -- it is read at a glance over live
# gameplay, so anything longer is truncated rather than allowed to wall off the
# screen.
MAX_LEN = 200
# How long a published message stays active (milliseconds) before clients stop
# showing it, unless replaced or cleared sooner. Long enough that every poller
# catches it once, short enough that a forgotten message clears itself.
DEFAULT_TTL_MS = 12_000
MIN_TTL_MS = 1_000
# Generous ceiling (1 hour) so an operator can pin a long-lived message; a new
# send replaces it and --clear takes it down, so "stuck forever" is not a risk.
MAX_TTL_MS = 3_600_000


def sanitize_text(raw):
    """Collapse a raw message to a single trimmed line, capped at ``MAX_LEN``.

    Control characters (including newlines and tabs) become spaces and runs of
    whitespace collapse to one, so the message cannot smuggle in layout-breaking
    blank space or terminal escapes. Returns ``''`` when nothing usable remains;
    the caller treats that as "no message".
    """
    if raw is None:
        return ""
    cleaned = []
    for ch in str(raw):
        o = ord(ch)
        if o < 0x20 or o == 0x7F:  # C0 control chars + DEL -> space
            cleaned.append(" ")
        else:
            cleaned.append(ch)
    collapsed = " ".join("".join(cleaned).split())
    return collapsed[:MAX_LEN]


def clamp_ttl(raw, default=DEFAULT_TTL_MS):
    """Clamp a requested TTL into ``[MIN_TTL_MS, MAX_TTL_MS]``; default on junk."""
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return default
    return max(MIN_TTL_MS, min(MAX_TTL_MS, n))


def verify_admin_token(provided, expected):
    """Constant-time match of a presented token against the configured one.

    False when either side is blank/missing, so an unconfigured server (no token
    set) can never be driven by an empty header. Constant-time compare avoids
    leaking the token length or a prefix match through timing.
    """
    if not provided or not expected:
        return False
    return hmac.compare_digest(str(provided), str(expected))


class BroadcastStore:
    """Thread-safe single active broadcast with a TTL and monotonic sequence."""

    def __init__(self, now_fn=None):
        self._now = now_fn or (lambda: time.time() * 1000)
        self._lock = threading.Lock()
        self._seq = 0
        self._text = ""
        self._ts = 0.0
        self._expires = 0.0

    def publish(self, text, ttl_ms=DEFAULT_TTL_MS, now_ms=None):
        """Make ``text`` the active broadcast; return its public view.

        Bumps the sequence so every client distinguishes this from the previous
        message (even an identical re-send). Raises ValueError when the message
        sanitizes to nothing, so the caller answers 400 rather than publishing a
        blank flash.
        """
        clean = sanitize_text(text)
        if not clean:
            raise ValueError("message is empty")
        ttl = clamp_ttl(ttl_ms)
        now = self._now() if now_ms is None else now_ms
        with self._lock:
            self._seq += 1
            self._text = clean
            self._ts = now
            self._expires = now + ttl
            return {
                "seq": self._seq, "text": clean,
                "ts": int(now), "remaining_ms": ttl,
            }

    def clear(self, now_ms=None):
        """Retire the active broadcast immediately; return the new sequence.

        Bumps the sequence and empties the text so the next poll hides the
        overlay on every client.
        """
        now = self._now() if now_ms is None else now_ms
        with self._lock:
            self._seq += 1
            self._text = ""
            self._ts = now
            self._expires = now
            return {"seq": self._seq}

    def current(self, now_ms=None):
        """The active broadcast, or an empty payload once it has expired/cleared.

        Always carries the current sequence so a client can tell a cleared/expired
        slot (``text == ""``) apart from a never-used one and avoid re-showing a
        message it already dismissed.
        """
        now = self._now() if now_ms is None else now_ms
        with self._lock:
            if self._text and now < self._expires:
                return {
                    "seq": self._seq, "text": self._text,
                    "ts": int(self._ts), "remaining_ms": int(self._expires - now),
                }
            return {"seq": self._seq, "text": "", "ts": int(self._ts), "remaining_ms": 0}
