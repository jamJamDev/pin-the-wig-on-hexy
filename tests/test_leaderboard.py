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
        self.store.add("abc", 500, god=False, ts=1, owner_token="o-abc")
        entry, rank, board, improved = self.store.add(
            "xyz", 30000, god=True, ts=2, owner_token="o-xyz")
        self.assertTrue(improved)
        self.assertEqual(rank, 1)
        self.assertEqual(entry["initials"], "XYZ")
        self.assertTrue(entry["god"])                    # 30000 clears the god floor
        self.assertNotIn("owner_hash", entry)            # secret never leaves the server
        # persisted to disk (with the owner binding kept on disk)
        with open(self.path, encoding="utf-8") as f:
            on_disk = json.load(f)
        self.assertEqual([e["initials"] for e in on_disk], ["XYZ", "ABC"])
        self.assertTrue(all("owner_hash" in e for e in on_disk))
        # a fresh store reads the same board back, still stripped for clients
        reread = LB.LeaderboardStore(self.path, max_entries=3).top()
        self.assertEqual([e["initials"] for e in reread], ["XYZ", "ABC"])
        self.assertTrue(all("owner_hash" not in e for e in reread))

    def test_rank_and_cap(self):
        self.store.add("AAA", 100, ts=1, owner_token="o1")
        self.store.add("BBB", 200, ts=2, owner_token="o2")
        self.store.add("CCC", 300, ts=3, owner_token="o3")
        # board full (max 3) with 100/200/300; a 50 is edged out -> rank 4, off board
        _, rank, board, _ = self.store.add("DDD", 50, ts=4, owner_token="o4")
        self.assertEqual(rank, 4)
        self.assertEqual(len(board), 3)
        self.assertNotIn("DDD", [e["initials"] for e in board])

    def test_invalid_submissions_raise(self):
        with self.assertRaises(ValueError):
            self.store.add("ab", 100, owner_token="o")       # too few letters
        with self.assertRaises(ValueError):
            self.store.add("ABC", 0, owner_token="o")        # not a real score
        with self.assertRaises(ValueError):
            self.store.add("ABC", "nope", owner_token="o")   # non-numeric
        with self.assertRaises(ValueError):
            self.store.add("ABC", 100)                       # no owner token

    def test_corrupt_file_fails_loud(self):
        with open(self.path, "w", encoding="utf-8") as f:
            f.write("{ this is not json")
        with self.assertRaises(Exception):
            self.store.top()


class InitialsOwnership(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "leaderboard.json")
        self.store = LB.LeaderboardStore(self.path)

    def test_owner_keeps_one_row_at_best_score(self):
        _, _, board, improved = self.store.add("AAA", 500, ts=1, owner_token="o1")
        self.assertTrue(improved)
        self.assertEqual(len(board), 1)
        # the owner raising their score replaces the standing row (still one row)
        _, _, board, improved = self.store.add("AAA", 800, ts=2, owner_token="o1")
        self.assertTrue(improved)
        self.assertEqual(len(board), 1)
        self.assertEqual(board[0]["score"], 800)
        # a weaker run by the same owner leaves the best untouched
        entry, rank, board, improved = self.store.add("AAA", 300, ts=3, owner_token="o1")
        self.assertFalse(improved)
        self.assertEqual(board[0]["score"], 800)
        self.assertEqual(entry["score"], 800)
        self.assertEqual(rank, 1)
        # a different set of initials earns its own second row
        _, _, board, _ = self.store.add("BBB", 100, ts=4, owner_token="o2")
        self.assertEqual(sorted(e["initials"] for e in board), ["AAA", "BBB"])

    def test_different_owner_cannot_take_claimed_initials(self):
        self.store.add("AAA", 500, ts=1, owner_token="o1")
        with self.assertRaises(LB.OwnershipError):
            self.store.add("AAA", 900, ts=2, owner_token="o2")  # impersonation refused
        # the original owner's row is untouched and still the only AAA row
        board = self.store.top()
        self.assertEqual([e["initials"] for e in board], ["AAA"])
        self.assertEqual(board[0]["score"], 500)

    def test_no_duplicate_rows_under_one_name(self):
        self.store.add("AAA", 500, ts=1, owner_token="o1")
        self.store.add("AAA", 800, ts=2, owner_token="o1")
        self.store.add("AAA", 200, ts=3, owner_token="o1")
        names = [e["initials"] for e in self.store.top()]
        self.assertEqual(names, ["AAA"])  # exactly one row, never a duplicate

    def test_owner_secret_is_never_returned(self):
        _, _, board, _ = self.store.add("AAA", 1000, ts=1, owner_token="super-secret")
        self.assertTrue(all("owner_hash" not in e for e in board))
        self.assertTrue(all("owner_hash" not in e for e in self.store.top()))
        # but the binding IS persisted on disk so ownership survives a restart
        with open(self.path, encoding="utf-8") as f:
            on_disk = json.load(f)
        self.assertIn("owner_hash", on_disk[0])
        self.assertNotEqual(on_disk[0]["owner_hash"], "super-secret")  # hashed, not raw

    def test_god_flag_requires_the_god_floor(self):
        low, _, _, _ = self.store.add("LOW", LB.GOD_MIN - 1, god=True, ts=1, owner_token="oL")
        self.assertFalse(low["god"])          # a claimed crown below a real victory is dropped
        self.assertEqual(low["score"], LB.GOD_MIN - 1)  # the score itself still counts
        high, _, _, _ = self.store.add("HII", LB.GOD_MIN, god=True, ts=2, owner_token="oH")
        self.assertTrue(high["god"])          # a god-range score keeps the crown

    def test_claiming_a_legacy_subfloor_god_row_drops_the_crown(self):
        # A pre-floor row may carry god=True below GOD_MIN. Claiming it on the
        # non-improving path must apply the same floor as a fresh write, so a
        # crown that no longer qualifies cannot survive by being inherited.
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump([{"initials": "AAA", "score": LB.GOD_MIN - 1,
                        "god": True, "ts": 1}], f)
        entry, _, board, improved = self.store.add("AAA", 10, ts=2, owner_token="o1")
        self.assertFalse(improved)                 # 10 < standing best
        self.assertEqual(entry["score"], LB.GOD_MIN - 1)
        self.assertFalse(entry["god"])             # sub-floor crown dropped on claim
        self.assertFalse(board[0]["god"])

    def test_personal_best_keeps_its_god_flag(self):
        self.store.add("AAA", 30000, god=True, ts=1, owner_token="o1")
        entry, _, board, improved = self.store.add("AAA", 100, god=False, ts=2, owner_token="o1")
        self.assertFalse(improved)
        self.assertTrue(entry["god"])         # the crowned best run is preserved
        self.assertEqual(entry["score"], 30000)
        self.assertTrue(board[0]["god"])

    def test_legacy_row_is_claimable_then_locked(self):
        # A pre-ownership row (no owner_hash) is claimable by the first valid owner,
        # then locked to them -- a later different owner is refused.
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump([{"initials": "AAA", "score": 900, "god": False, "ts": 1}], f)
        entry, _, _, improved = self.store.add("AAA", 1500, ts=2, owner_token="o1")
        self.assertTrue(improved)
        self.assertEqual(entry["score"], 1500)
        with self.assertRaises(LB.OwnershipError):
            self.store.add("AAA", 2000, ts=3, owner_token="o2")

    def test_a_write_heals_legacy_duplicates_of_other_names(self):
        # Legacy data may hold duplicate rows for names OTHER than the one being
        # submitted; any write must collapse the whole board to one row per name,
        # not only the submitted name's rows.
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump([
                {"initials": "BBB", "score": 900, "god": False, "ts": 1, "client_id": "c1"},
                {"initials": "BBB", "score": 1500, "god": False, "ts": 2, "client_id": "c1"},
            ], f)
        self.store.add("AAA", 300, ts=3, owner_token="o1")  # submit a DIFFERENT name
        board = self.store.top()
        bbb = [e for e in board if e["initials"] == "BBB"]
        self.assertEqual(len(bbb), 1)            # the duplicate BBB rows are collapsed
        self.assertEqual(bbb[0]["score"], 1500)  # to BBB's best
        self.assertNotIn("client_id", bbb[0])    # and stripped for clients

    def test_collapses_duplicate_legacy_rows(self):
        # Legacy/edited data can hold more than one row for a name; any add must
        # collapse them to the single best and bind the proven owner.
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump([
                {"initials": "AAA", "score": 900, "god": False, "ts": 1, "client_id": "c1"},
                {"initials": "AAA", "score": 700, "god": False, "ts": 2, "client_id": "c1"},
            ], f)
        entry, rank, board, improved = self.store.add("AAA", 800, ts=3, owner_token="o1")
        self.assertFalse(improved)                       # 800 < best 900
        self.assertEqual(entry["score"], 900)            # standing best, not the 800 run
        mine = [e for e in board if e["initials"] == "AAA"]
        self.assertEqual(len(mine), 1)                   # the duplicate 700 row is gone
        self.assertNotIn("client_id", mine[0])           # legacy field dropped from output
        # the collapse is persisted, not just returned
        reread = LB.LeaderboardStore(self.path).top()
        self.assertEqual(len([e for e in reread if e["initials"] == "AAA"]), 1)


if __name__ == "__main__":
    unittest.main()
