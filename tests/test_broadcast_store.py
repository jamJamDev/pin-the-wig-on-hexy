"""Unit tests for the operator broadcast channel (scripts/broadcast_store.py).

The clock is injected, so TTL expiry is exercised deterministically without
sleeping. Each test would fail if the store leaked an expired message, failed to
bump the sequence (so clients could not tell a re-send apart), published a blank
flash, or accepted an empty/mismatched admin token.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from broadcast_store import (  # noqa: E402
    BroadcastStore,
    DEFAULT_TTL_MS,
    MAX_LEN,
    MAX_TTL_MS,
    MIN_TTL_MS,
    clamp_ttl,
    sanitize_text,
    verify_admin_token,
)


class FakeClock:
    """Hand-cranked millisecond clock for deterministic TTL tests."""

    def __init__(self, t=0.0):
        self.t = t

    def __call__(self):
        return self.t

    def advance(self, dt_ms):
        self.t += dt_ms


class SanitizeText(unittest.TestCase):
    def test_trims_and_collapses_whitespace(self):
        self.assertEqual(sanitize_text("  hello   world  "), "hello world")

    def test_control_chars_become_spaces_then_collapse(self):
        # Newlines/tabs/escapes cannot smuggle in layout or terminal control:
        # each becomes a space (the ESC too), then runs of space collapse to one.
        self.assertEqual(sanitize_text("a\n\tb\x1b[31mc"), "a b [31mc")

    def test_blank_and_none_yield_empty(self):
        self.assertEqual(sanitize_text(""), "")
        self.assertEqual(sanitize_text("   \n\t "), "")
        self.assertEqual(sanitize_text(None), "")

    def test_caps_at_max_len(self):
        out = sanitize_text("x" * (MAX_LEN + 50))
        self.assertEqual(len(out), MAX_LEN)

    def test_keeps_unicode(self):
        self.assertEqual(sanitize_text("héllo 🎉"), "héllo 🎉")


class ClampTtl(unittest.TestCase):
    def test_clamps_below_min_and_above_max(self):
        self.assertEqual(clamp_ttl(0), MIN_TTL_MS)
        self.assertEqual(clamp_ttl(MAX_TTL_MS + 999_999), MAX_TTL_MS)

    def test_passes_through_in_range(self):
        self.assertEqual(clamp_ttl(5000), 5000)

    def test_allows_long_operator_durations(self):
        # An operator can pin a long-lived message (e.g. 999 seconds) without it
        # being clamped down to a short default.
        self.assertEqual(clamp_ttl(999_000), 999_000)

    def test_garbage_falls_back_to_default(self):
        self.assertEqual(clamp_ttl(None), DEFAULT_TTL_MS)
        self.assertEqual(clamp_ttl("nope"), DEFAULT_TTL_MS)


class VerifyAdminToken(unittest.TestCase):
    def test_matches_only_exact(self):
        self.assertTrue(verify_admin_token("s3cret", "s3cret"))
        self.assertFalse(verify_admin_token("s3cret", "other"))

    def test_blank_or_missing_never_matches(self):
        # An unconfigured server (empty expected) cannot be driven by any header.
        self.assertFalse(verify_admin_token("anything", ""))
        self.assertFalse(verify_admin_token("", "expected"))
        self.assertFalse(verify_admin_token(None, "expected"))
        self.assertFalse(verify_admin_token("", ""))


class BroadcastStoreBehavior(unittest.TestCase):
    def test_starts_empty_with_zero_seq(self):
        store = BroadcastStore(now_fn=FakeClock())
        cur = store.current()
        self.assertEqual(cur["text"], "")
        self.assertEqual(cur["seq"], 0)

    def test_publish_makes_message_current_and_bumps_seq(self):
        clock = FakeClock()
        store = BroadcastStore(now_fn=clock)
        res = store.publish("Hello stream", ttl_ms=10_000)
        self.assertEqual(res["seq"], 1)
        self.assertEqual(res["text"], "Hello stream")
        cur = store.current()
        self.assertEqual(cur["text"], "Hello stream")
        self.assertEqual(cur["seq"], 1)
        self.assertEqual(cur["remaining_ms"], 10_000)

    def test_message_expires_after_ttl(self):
        clock = FakeClock()
        store = BroadcastStore(now_fn=clock)
        store.publish("flash", ttl_ms=5_000)
        clock.advance(4_999)
        self.assertEqual(store.current()["text"], "flash")  # still inside the window
        clock.advance(2)                                    # now past expiry
        cur = store.current()
        self.assertEqual(cur["text"], "")
        self.assertEqual(cur["seq"], 1)                     # seq survives so clients don't re-show

    def test_resend_bumps_seq_even_for_identical_text(self):
        # A client distinguishes a re-pin from the standing message by sequence.
        store = BroadcastStore(now_fn=FakeClock())
        first = store.publish("same")
        second = store.publish("same")
        self.assertEqual(first["seq"], 1)
        self.assertEqual(second["seq"], 2)

    def test_clear_empties_and_bumps_seq(self):
        store = BroadcastStore(now_fn=FakeClock())
        store.publish("up")
        cleared = store.clear()
        self.assertEqual(cleared["seq"], 2)
        self.assertEqual(store.current()["text"], "")

    def test_publish_sanitizes_text(self):
        store = BroadcastStore(now_fn=FakeClock())
        res = store.publish("  spaced\nout  ")
        self.assertEqual(res["text"], "spaced out")

    def test_publish_empty_message_raises(self):
        store = BroadcastStore(now_fn=FakeClock())
        with self.assertRaises(ValueError):
            store.publish("   \n\t ")

    def test_publish_clamps_ttl(self):
        store = BroadcastStore(now_fn=FakeClock())
        res = store.publish("hi", ttl_ms=0)
        self.assertEqual(res["remaining_ms"], MIN_TTL_MS)


if __name__ == "__main__":
    unittest.main()
