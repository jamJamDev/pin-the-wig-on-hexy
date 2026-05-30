"""Authoritative top-100 leaderboard store for the Pin the Wig on Hexy server.

Mirrors the client ranking rules in ``src/js/leaderboard.js`` -- entries sort by
score descending, ties break by submission time ascending (first to a score keeps
the higher slot), and the board is capped at the top ``MAX_ENTRIES``. The score
is the full run total (base rounds + pinball finale), so a GOD GAMER still carries
a competitive number.

The pure helpers (``sanitize_initials``, ``coerce_score``, ``insert_sorted``) are
validated directly in tests. ``LeaderboardStore`` adds the I/O shell: a lock so
the ``ThreadingHTTPServer`` cannot interleave read-modify-write, and an atomic
temp-then-rename so a crash mid-write never corrupts the board. Stdlib only.
"""
import json
import os
import threading
import time

MAX_ENTRIES = 100
INITIALS_LEN = 3
# A run's score is base rounds (10 x 1000) plus the pinball finale; this ceiling
# sits comfortably above any real total and rejects absurd/forged submissions.
SCORE_MAX = 10_000_000


def sanitize_initials(raw):
    """Keep up to three A-Z characters, uppercased; '' when nothing usable."""
    s = ("" if raw is None else str(raw)).upper()
    out = []
    for ch in s:
        if len(out) >= INITIALS_LEN:
            break
        if "A" <= ch <= "Z":
            out.append(ch)
    return "".join(out)


def coerce_score(raw):
    """Return a valid integer score in 1..SCORE_MAX, or None if not a real result.

    Accepts ints, floats, and numeric strings; floors to an int. Rejects
    non-numeric, non-finite, zero/negative, and out-of-range values.
    """
    if isinstance(raw, bool):
        return None  # booleans are not scores (bool is an int subclass in Python)
    try:
        n = float(raw)
    except (TypeError, ValueError):
        return None
    if n != n or n in (float("inf"), float("-inf")):  # NaN / +-inf
        return None
    if n > SCORE_MAX:  # reject before flooring so SCORE_MAX + 0.9 cannot slip through
        return None
    n = int(n)  # floor toward zero
    if n <= 0:  # zero, negatives, and sub-1 fractions floored to 0
        return None
    return n


def insert_sorted(entries, entry, max_entries=MAX_ENTRIES):
    """Return a new sorted, capped board with ``entry`` inserted.

    Stable sort over (score desc, ts asc); ``entries`` is not mutated. The new
    entry is appended before sorting, so on a full (score, ts) tie it lands after
    the incumbent -- first to a score keeps the slot.
    """
    merged = list(entries) + [entry]
    merged.sort(key=lambda e: (-e["score"], e["ts"]))
    return merged[:max_entries]


def rank_of(entries, score):
    """1-based position a fresh run of ``score`` would take (ties land below)."""
    return sum(1 for e in entries if e["score"] >= score) + 1


class LeaderboardStore:
    """Thread-safe, file-backed top-100 board."""

    def __init__(self, path, max_entries=MAX_ENTRIES):
        self.path = path
        self.max_entries = max_entries
        self._lock = threading.Lock()

    def _load_locked(self):
        if not os.path.exists(self.path):
            return []
        with open(self.path, "r", encoding="utf-8") as f:
            data = json.load(f)  # raises on corrupt -- surfaced loudly, never silently reset
        if not isinstance(data, list):
            raise ValueError("leaderboard file is not a JSON array: %s" % self.path)
        return data

    def _write_locked(self, entries):
        directory = os.path.dirname(self.path) or "."
        os.makedirs(directory, exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(entries, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, self.path)  # atomic on POSIX

    def top(self):
        """Current board, sorted and capped (read-only)."""
        with self._lock:
            entries = self._load_locked()
        return sorted(entries, key=lambda e: (-e["score"], e["ts"]))[: self.max_entries]

    def add(self, initials, score, god=False, ts=None, client_id=None):
        """Validate, upsert, persist, and return (entry, rank, board, improved).

        With a ``client_id`` the board keeps **one row per player** at their best
        score: a higher score replaces the standing row, a lower-or-equal one
        leaves it untouched (``improved=False``) so a weak run never knocks a good
        score off. Without a ``client_id`` every submission is its own row (the
        original behaviour). ``rank`` is the resulting 1-based position; it can
        exceed the cap when a full board edged the run out. Raises ValueError on
        invalid initials or score so the caller can answer 400 -- a bad
        submission must fail loudly, not be silently coerced.
        """
        clean = sanitize_initials(initials)
        if len(clean) != INITIALS_LEN:
            raise ValueError("initials must be three letters")
        clean_score = coerce_score(score)
        if clean_score is None:
            raise ValueError("score must be a positive number within range")
        cid = str(client_id) if client_id else None
        with self._lock:
            entries = self._load_locked()
            # Every row for this player (legacy/edited data may hold more than one);
            # collapse to a single best row, matching the JS client's upsert exactly.
            mine = [e for e in entries if cid and e.get("client_id") == cid]
            others = [e for e in entries if not (cid and e.get("client_id") == cid)]
            best = max(mine, key=lambda e: e["score"]) if mine else None
            if best is not None and clean_score <= best["score"]:
                # Not a personal best -- the standing row holds. Persist only if we
                # had to collapse duplicate rows; otherwise the board is unchanged.
                board = insert_sorted(others, best, self.max_entries)
                if len(mine) > 1:
                    self._write_locked(board)
                rank = rank_of(others, best["score"])
                return best, rank, board, False
            # New player, or a new personal best: one row supersedes any prior ones.
            entry = {
                "initials": clean,
                "score": clean_score,
                "god": bool(god),
                "ts": int(ts if ts is not None else time.time() * 1000),
            }
            if cid:
                entry["client_id"] = cid
            rank = rank_of(others, clean_score)  # vs the board minus this player's old rows
            board = insert_sorted(others, entry, self.max_entries)
            self._write_locked(board)
        return entry, rank, board, True
