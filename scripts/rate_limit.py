"""Per-client rate limiter for the leaderboard write endpoint.

The leaderboard ``POST`` in ``scripts/dev_server.py`` is the only public mutation,
and a publicly tunneled deployment invites scripted spam. This is the in-process
backstop to the Cloudflare edge rate-limit rule: a classic token bucket per
client key, so a short burst of submissions is absorbed while a sustained flood
is throttled to ``refill_per_sec``.

The bucket math is a pure function of an injected clock (``now_fn``), so tests
drive time deterministically instead of sleeping. The only shared state is the
per-key bucket table, guarded by a lock so the ``ThreadingHTTPServer`` cannot
interleave its updates. Idle buckets are evicted so a flood of distinct keys
cannot grow the table without bound. Stdlib only.
"""
import math
import threading
import time


class RateLimiter:
    """Thread-safe token-bucket limiter keyed by an arbitrary client identifier.

    Each key gets a bucket holding up to ``capacity`` tokens that refills at
    ``refill_per_sec``. ``allow`` consumes one token and returns whether the
    request is permitted: a burst up to ``capacity`` passes immediately, and
    beyond that callers are limited to ``refill_per_sec`` over time.
    """

    def __init__(self, capacity, refill_per_sec, now_fn=time.monotonic,
                 idle_ttl=3600.0):
        if capacity <= 0:
            raise ValueError("capacity must be positive")
        if refill_per_sec <= 0:
            raise ValueError("refill_per_sec must be positive")
        self.capacity = float(capacity)
        self.refill_per_sec = float(refill_per_sec)
        self._now = now_fn
        self._idle_ttl = idle_ttl
        self._lock = threading.Lock()
        self._buckets = {}  # key -> (tokens, last_ts)
        self._last_evict = None

    def _level_locked(self, key, now):
        """Tokens available to ``key`` at ``now`` (caller holds the lock)."""
        tokens, last = self._buckets.get(key, (self.capacity, now))
        return min(self.capacity, tokens + (now - last) * self.refill_per_sec)

    def allow(self, key):
        """Consume a token for ``key``; return True if one was available."""
        now = self._now()
        with self._lock:
            self._evict_locked(now)
            tokens = self._level_locked(key, now)
            allowed = tokens >= 1.0
            if allowed:
                tokens -= 1.0
            self._buckets[key] = (tokens, now)
            return allowed

    def retry_after(self, key):
        """Whole seconds until ``key`` regains a token (>=1), or 0 if it has one."""
        now = self._now()
        with self._lock:
            tokens = self._level_locked(key, now)
            if tokens >= 1.0:
                return 0
            return max(1, math.ceil((1.0 - tokens) / self.refill_per_sec))

    def _evict_locked(self, now):
        # An idle bucket refills to full, so forgetting it is equivalent to
        # keeping it -- eviction only bounds memory against a flood of one-shot
        # keys. Sweep at most once per TTL to keep allow() amortized O(1).
        if self._last_evict is not None and now - self._last_evict < self._idle_ttl:
            return
        self._last_evict = now
        stale = [k for k, (_, last) in self._buckets.items()
                 if now - last >= self._idle_ttl]
        for k in stale:
            del self._buckets[k]
