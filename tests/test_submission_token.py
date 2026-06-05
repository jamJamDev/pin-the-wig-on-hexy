"""Unit tests for signed leaderboard submissions (scripts/submission_token.py)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

import submission_token as T  # noqa: E402

# Fixed vector shared with the JS side (tests/leaderboard.test.js) to prove the
# client and server compute byte-identical signatures.
VEC = ("ABC", 12345, True, "00112233445566778899aabbccddeeff", 1700000000000,
       "owner-token-fixed-0001")
VEC_SIG = "60a7b02b1cf63a97ddafc6d22c9d2e5c0991ca7cd15b883974f816e1867a514c"


class Sign(unittest.TestCase):
    def test_known_vector_is_stable(self):
        # If this hex ever changes, the JS client and Python server have diverged
        # and every real submission would be rejected -- a contract break.
        self.assertEqual(T.sign(*VEC), VEC_SIG)

    def test_sign_is_deterministic(self):
        self.assertEqual(T.sign(*VEC), T.sign(*VEC))

    def test_god_flag_changes_the_signature(self):
        initials, score, _, nonce, ts, owner = VEC
        self.assertNotEqual(T.sign(initials, score, True, nonce, ts, owner),
                            T.sign(initials, score, False, nonce, ts, owner))


class Verify(unittest.TestCase):
    def test_accepts_a_matching_signature(self):
        self.assertTrue(T.verify(*VEC, VEC_SIG))

    def test_is_case_insensitive_on_the_hex(self):
        self.assertTrue(T.verify(*VEC, VEC_SIG.upper()))

    def test_rejects_a_tampered_score(self):
        initials, _, god, nonce, ts, owner = VEC
        self.assertFalse(T.verify(initials, 999999, god, nonce, ts, owner, VEC_SIG))

    def test_rejects_a_tampered_owner(self):
        initials, score, god, nonce, ts, _ = VEC
        self.assertFalse(T.verify(initials, score, god, nonce, ts, "someone-else", VEC_SIG))

    def test_rejects_a_malformed_signature(self):
        self.assertFalse(T.verify(*VEC, "not-a-hex"))
        self.assertFalse(T.verify(*VEC, None))
        self.assertFalse(T.verify(*VEC, ""))

    def test_rejects_a_non_numeric_score_without_raising(self):
        initials, _, god, nonce, ts, owner = VEC
        self.assertFalse(T.verify(initials, "abc", god, nonce, ts, owner, VEC_SIG))


class Fresh(unittest.TestCase):
    def test_within_window(self):
        self.assertTrue(T.fresh(1000, now_ms=1000))
        self.assertTrue(T.fresh(1000, now_ms=1000 + T.WINDOW_MS))

    def test_outside_window(self):
        self.assertFalse(T.fresh(1000, now_ms=1000 + T.WINDOW_MS + 1))
        self.assertFalse(T.fresh(1000, now_ms=1000 - T.WINDOW_MS - 1))

    def test_non_numeric_is_not_fresh(self):
        self.assertFalse(T.fresh("nope", now_ms=0))
        self.assertFalse(T.fresh(None, now_ms=0))


class Nonce(unittest.TestCase):
    def test_first_use_allowed_then_replay_blocked(self):
        nc = T.NonceCache(now_fn=lambda: 0.0)
        self.assertTrue(nc.check_and_remember("n1", now_ms=0))
        self.assertFalse(nc.check_and_remember("n1", now_ms=1))  # replay within window

    def test_distinct_nonces_each_allowed(self):
        nc = T.NonceCache(now_fn=lambda: 0.0)
        self.assertTrue(nc.check_and_remember("a", now_ms=0))
        self.assertTrue(nc.check_and_remember("b", now_ms=0))

    def test_blank_nonce_rejected(self):
        nc = T.NonceCache(now_fn=lambda: 0.0)
        self.assertFalse(nc.check_and_remember("", now_ms=0))
        self.assertFalse(nc.check_and_remember(None, now_ms=0))

    def test_evicts_stale_nonces_to_bound_memory(self):
        nc = T.NonceCache(ttl_ms=100, now_fn=lambda: 0.0)
        self.assertTrue(nc.check_and_remember("old", now_ms=0))
        # Long after the TTL, a new submission triggers eviction of "old".
        self.assertTrue(nc.check_and_remember("new", now_ms=10_000))
        self.assertNotIn("old", nc._seen)


if __name__ == "__main__":
    unittest.main()
