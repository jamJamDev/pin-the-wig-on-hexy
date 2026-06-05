"""HMAC-signed leaderboard submission verification for the Pin the Wig server.

The leaderboard ``POST`` is the only public mutation. Each submission carries an
HMAC-SHA256 signature over a canonical payload plus a single-use nonce and a
timestamp; this module recomputes the signature, rejects a stale timestamp, and
rejects a replayed nonce. It turns away naive scripted submissions that do not
sign and stops a captured request from being replayed.

The shared key is mirrored byte-for-byte in ``src/js/submission.js`` (no build
step shares one source). It ships in client JS, so it is shared friction, not a
credential -- a determined reader can extract it. Real ownership rests on the
per-player owner token in ``leaderboard_store.py``, never on this key.

Pure functions (``canonical``, ``sign``, ``verify``, ``fresh``) plus a
lock-guarded ``NonceCache`` with an injected clock for deterministic tests.
Stdlib only.
"""
import hashlib
import hmac
import threading
import time

# Mirrored byte-for-byte in src/js/submission.js SIGNING_SECRET.
SIGNING_SECRET = b"ptwoh.leaderboard.v1.shared-submission-key.not-a-real-secret"  # gitleaks:allow
SCHEME = "ptwoh-sub-v1"
_SEP = "\x1f"  # ASCII unit separator -- cannot occur in any signed field
# A submission's signed timestamp must land within this window of server time
# (milliseconds). Bounds the replay surface and the nonce cache's memory.
WINDOW_MS = 300_000


def _now_ms():
    return time.time() * 1000


def canonical(initials, score, god, nonce, ts, owner):
    """The exact string both sides HMAC. Mirrors src/js/submission.js canonical().

    Raises ValueError/TypeError on a non-integer score or ts so a malformed
    field fails verification rather than signing a coerced value.
    """
    return _SEP.join([
        SCHEME,
        str(initials),
        str(int(score)),
        "1" if god else "0",
        str(nonce),
        str(int(ts)),
        str(owner),
    ])


def sign(initials, score, god, nonce, ts, owner):
    """HMAC-SHA256 hex of the canonical payload."""
    msg = canonical(initials, score, god, nonce, ts, owner).encode("utf-8")
    return hmac.new(SIGNING_SECRET, msg, hashlib.sha256).hexdigest()


def verify(initials, score, god, nonce, ts, owner, sig):
    """True only when ``sig`` is the valid signature for these fields.

    Constant-time compare; a malformed field or non-hex signature returns False
    rather than raising, so the caller answers a uniform rejection.
    """
    if not isinstance(sig, str) or len(sig) != 64:
        return False
    try:
        expected = sign(initials, score, god, nonce, ts, owner)
    except (TypeError, ValueError):
        return False
    return hmac.compare_digest(expected, sig.lower())


def fresh(ts, now_ms=None, window_ms=WINDOW_MS):
    """True when signed timestamp ``ts`` is within ``window_ms`` of now."""
    try:
        ts_i = int(ts)
    except (TypeError, ValueError):
        return False
    now = _now_ms() if now_ms is None else now_ms
    return abs(now - ts_i) <= window_ms


class NonceCache:
    """Thread-safe single-use nonce ledger.

    ``check_and_remember`` returns True the first time it sees a nonce and False
    on any repeat within the TTL. Entries older than ``ttl_ms`` are evicted (a
    stale nonce is rejected by the timestamp window anyway), so a flood of
    distinct nonces cannot grow the ledger without bound.
    """

    def __init__(self, ttl_ms=WINDOW_MS, now_fn=_now_ms):
        self._ttl = float(ttl_ms)
        self._now = now_fn
        self._lock = threading.Lock()
        self._seen = {}  # nonce -> first-seen ms
        self._last_evict = None

    def check_and_remember(self, nonce, now_ms=None):
        if not nonce or not isinstance(nonce, str):
            return False
        now = self._now() if now_ms is None else now_ms
        with self._lock:
            self._evict_locked(now)
            if nonce in self._seen:
                return False  # replay
            self._seen[nonce] = now
            return True

    def _evict_locked(self, now):
        if self._last_evict is not None and now - self._last_evict < self._ttl:
            return
        self._last_evict = now
        stale = [n for n, seen in self._seen.items() if now - seen >= self._ttl]
        for n in stale:
            del self._seen[n]
