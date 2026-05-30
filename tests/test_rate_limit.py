"""Unit tests for the in-process leaderboard rate limiter (scripts/rate_limit.py).

Time is injected, so refill and eviction are exercised deterministically without
sleeping -- each test would fail if the bucket let an over-limit request through,
never refilled, or leaked idle buckets.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from rate_limit import RateLimiter  # noqa: E402


class FakeClock:
    """Hand-cranked monotonic clock for deterministic token-bucket tests."""

    def __init__(self, t=0.0):
        self.t = t

    def __call__(self):
        return self.t

    def advance(self, dt):
        self.t += dt


class TokenBucket(unittest.TestCase):
    def test_allows_burst_up_to_capacity_then_blocks(self):
        clock = FakeClock()
        rl = RateLimiter(capacity=3, refill_per_sec=1.0, now_fn=clock)
        self.assertTrue(rl.allow("ip"))
        self.assertTrue(rl.allow("ip"))
        self.assertTrue(rl.allow("ip"))
        self.assertFalse(rl.allow("ip"))  # bucket drained

    def test_refills_over_time(self):
        clock = FakeClock()
        rl = RateLimiter(capacity=2, refill_per_sec=1.0, now_fn=clock)
        self.assertTrue(rl.allow("ip"))
        self.assertTrue(rl.allow("ip"))
        self.assertFalse(rl.allow("ip"))
        clock.advance(1.0)               # one token regenerated
        self.assertTrue(rl.allow("ip"))
        self.assertFalse(rl.allow("ip"))  # and only one

    def test_refill_is_capped_at_capacity(self):
        clock = FakeClock()
        rl = RateLimiter(capacity=2, refill_per_sec=1.0, now_fn=clock)
        self.assertTrue(rl.allow("ip"))
        clock.advance(1000.0)            # long idle must not over-fill
        self.assertTrue(rl.allow("ip"))
        self.assertTrue(rl.allow("ip"))
        self.assertFalse(rl.allow("ip"))  # capacity is still 2, not 1001

    def test_keys_are_independent(self):
        clock = FakeClock()
        rl = RateLimiter(capacity=1, refill_per_sec=1.0, now_fn=clock)
        self.assertTrue(rl.allow("a"))
        self.assertFalse(rl.allow("a"))
        self.assertTrue(rl.allow("b"))    # b's bucket is untouched by a
        self.assertFalse(rl.allow("b"))

    def test_retry_after_reports_wait_then_clears(self):
        clock = FakeClock()
        rl = RateLimiter(capacity=1, refill_per_sec=0.5, now_fn=clock)
        self.assertTrue(rl.allow("ip"))
        self.assertFalse(rl.allow("ip"))
        self.assertEqual(rl.retry_after("ip"), 2)  # 1 token / 0.5 per sec = 2s
        clock.advance(2.0)
        self.assertEqual(rl.retry_after("ip"), 0)  # token is back
        self.assertTrue(rl.allow("ip"))

    def test_retry_after_zero_when_tokens_available(self):
        rl = RateLimiter(capacity=2, refill_per_sec=1.0, now_fn=FakeClock())
        self.assertEqual(rl.retry_after("fresh"), 0)

    def test_evicts_idle_buckets(self):
        clock = FakeClock()
        rl = RateLimiter(capacity=1, refill_per_sec=1.0, now_fn=clock,
                         idle_ttl=10.0)
        rl.allow("old")
        self.assertIn("old", rl._buckets)
        clock.advance(11.0)               # past the idle TTL
        rl.allow("new")                   # triggers a sweep
        self.assertNotIn("old", rl._buckets)  # stale bucket dropped
        self.assertIn("new", rl._buckets)

    def test_invalid_construction_rejected(self):
        with self.assertRaises(ValueError):
            RateLimiter(capacity=0, refill_per_sec=1.0)
        with self.assertRaises(ValueError):
            RateLimiter(capacity=1, refill_per_sec=0)


if __name__ == "__main__":
    unittest.main()
