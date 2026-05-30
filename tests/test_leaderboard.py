"""Unit tests for the authoritative leaderboard store (scripts/leaderboard_store.py)."""
import os
import sys
import json
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

import leaderboard_store as LB  # noqa: E402


def E(initials, score, ts):
    return {"initials": initials, "score": score, "god": False, "ts": ts}


class SanitizeInitials(unittest.TestCase):
    def test_keeps_up_to_three_upper_letters(self):
        self.assertEqual(LB.sanitize_initials("abc"), "ABC")
        self.assertEqual(LB.sanitize_initials("a1b2c3d4"), "ABC")
        self.assertEqual(LB.sanitize_initials("  zz "), "ZZ")
        self.assertEqual(LB.sanitize_initials("!@#"), "")
        self.assertEqual(LB.sanitize_initials(None), "")


class CoerceScore(unittest.TestCase):
    def test_valid_and_invalid(self):
        self.assertEqual(LB.coerce_score(1234), 1234)
        self.assertEqual(LB.coerce_score("950"), 950)
        self.assertEqual(LB.coerce_score(12.9), 12)  # floored
        self.assertIsNone(LB.coerce_score(0))
        self.assertIsNone(LB.coerce_score(-5))
        self.assertIsNone(LB.coerce_score("abc"))
        self.assertIsNone(LB.coerce_score(None))
        self.assertIsNone(LB.coerce_score(float("inf")))
        self.assertIsNone(LB.coerce_score(LB.SCORE_MAX + 1))
        self.assertIsNone(LB.coerce_score(LB.SCORE_MAX + 0.9))  # ceiling checked before floor
        self.assertIsNone(LB.coerce_score(True))                # bool is not a score
        self.assertIsNone(LB.coerce_score(0.5))                 # floors to 0 -> rejected


class InsertSorted(unittest.TestCase):
    def test_orders_and_caps_without_mutating(self):
        board = [E("AAA", 500, 1), E("BBB", 100, 2)]
        nxt = LB.insert_sorted(board, E("CCC", 300, 3), 100)
        self.assertEqual([e["initials"] for e in nxt], ["AAA", "CCC", "BBB"])
        self.assertEqual(len(board), 2)  # original untouched

        capped = LB.insert_sorted([E("AAA", 9, 1), E("BBB", 8, 2)], E("CCC", 5, 3), 2)
        self.assertEqual([e["initials"] for e in capped], ["AAA", "BBB"])

    def test_tie_breaks_by_time_newcomer_below(self):
        board = [E("OLD", 300, 1)]
        nxt = LB.insert_sorted(board, E("NEW", 300, 9), 100)
        self.assertEqual([e["initials"] for e in nxt], ["OLD", "NEW"])


class StoreAddPersist(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "leaderboard.json")
        self.store = LB.LeaderboardStore(self.path, max_entries=3)

    def test_add_persists_and_reloads(self):
        self.store.add("abc", 500, god=False, ts=1)
        entry, rank, board, improved = self.store.add("xyz", 900, god=True, ts=2)
        self.assertTrue(improved)
        self.assertEqual(rank, 1)
        self.assertEqual(entry["initials"], "XYZ")
        self.assertTrue(entry["god"])
        # persisted to disk
        with open(self.path, encoding="utf-8") as f:
            on_disk = json.load(f)
        self.assertEqual([e["initials"] for e in on_disk], ["XYZ", "ABC"])
        # a fresh store reads the same board back
        reread = LB.LeaderboardStore(self.path, max_entries=3).top()
        self.assertEqual([e["initials"] for e in reread], ["XYZ", "ABC"])

    def test_rank_and_cap(self):
        self.store.add("AAA", 100, ts=1)
        self.store.add("BBB", 200, ts=2)
        self.store.add("CCC", 300, ts=3)
        # board full (max 3) with 100/200/300; a 50 is edged out -> rank 4, off board
        _, rank, board, _ = self.store.add("DDD", 50, ts=4)
        self.assertEqual(rank, 4)
        self.assertEqual(len(board), 3)
        self.assertNotIn("DDD", [e["initials"] for e in board])

    def test_invalid_submissions_raise(self):
        with self.assertRaises(ValueError):
            self.store.add("ab", 100)      # too few letters
        with self.assertRaises(ValueError):
            self.store.add("ABC", 0)       # not a real score
        with self.assertRaises(ValueError):
            self.store.add("ABC", "nope")  # non-numeric

    def test_corrupt_file_fails_loud(self):
        with open(self.path, "w", encoding="utf-8") as f:
            f.write("{ this is not json")
        with self.assertRaises(Exception):
            self.store.top()


class ClientDedup(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "leaderboard.json")
        self.store = LB.LeaderboardStore(self.path)

    def test_one_row_per_client_keeps_best(self):
        _, _, board, improved = self.store.add("AAA", 500, ts=1, client_id="c1")
        self.assertTrue(improved)
        self.assertEqual(len(board), 1)
        # a higher score replaces the standing row (still one row)
        _, _, board, improved = self.store.add("AAA", 800, ts=2, client_id="c1")
        self.assertTrue(improved)
        self.assertEqual(len(board), 1)
        self.assertEqual(board[0]["score"], 800)
        # a lower score leaves the best untouched
        entry, rank, board, improved = self.store.add("AAA", 300, ts=3, client_id="c1")
        self.assertFalse(improved)
        self.assertEqual(len(board), 1)
        self.assertEqual(board[0]["score"], 800)
        self.assertEqual(entry["score"], 800)  # the standing row, not the weak run
        self.assertEqual(rank, 1)
        # a different client earns its own second row
        _, _, board, _ = self.store.add("BBB", 100, ts=4, client_id="c2")
        self.assertEqual(len(board), 2)
        self.assertEqual(sorted(e["client_id"] for e in board), ["c1", "c2"])

    def test_personal_best_keeps_its_god_flag(self):
        self.store.add("AAA", 9000, god=True, ts=1, client_id="c1")
        entry, _, board, improved = self.store.add("AAA", 100, god=False, ts=2, client_id="c1")
        self.assertFalse(improved)
        self.assertTrue(entry["god"])      # the crowned best run is preserved
        self.assertEqual(entry["score"], 9000)
        self.assertTrue(board[0]["god"])

    def test_anonymous_submissions_are_not_deduped(self):
        self.store.add("AAA", 100, ts=1)   # no client_id
        self.store.add("AAA", 200, ts=2)
        self.assertEqual(len(self.store.top()), 2)

    def test_collapses_duplicate_client_rows(self):
        # Legacy/edited data can hold more than one row for a client; any add must
        # collapse them to the single best, matching the JS client's upsert.
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump([
                {"initials": "AAA", "score": 900, "god": False, "ts": 1, "client_id": "c1"},
                {"initials": "AAA", "score": 700, "god": False, "ts": 2, "client_id": "c1"},
            ], f)
        entry, rank, board, improved = self.store.add("AAA", 800, ts=3, client_id="c1")
        self.assertFalse(improved)                       # 800 < best 900
        self.assertEqual(entry["score"], 900)            # standing best, not the 800 run
        mine = [e for e in board if e.get("client_id") == "c1"]
        self.assertEqual(len(mine), 1)                   # the duplicate 700 row is gone
        self.assertEqual(mine[0]["score"], 900)
        # the collapse is persisted, not just returned
        reread = LB.LeaderboardStore(self.path).top()
        self.assertEqual(len([e for e in reread if e.get("client_id") == "c1"]), 1)


if __name__ == "__main__":
    unittest.main()
