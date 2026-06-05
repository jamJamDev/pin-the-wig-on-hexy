"""Authoritative top-100 leaderboard store for the Pin the Wig on Hexy server.

Mirrors the client ranking rules in ``src/js/leaderboard.js`` -- entries sort by
score descending, ties break by submission time ascending (first to a score keeps
the higher slot), and the board is capped at the top ``MAX_ENTRIES``. The score
is the full run total (base rounds + the four finale stages).

A set of initials is OWNED by the first player to claim it: the board keeps one
row per initials, bound to a hash of that player's secret owner token. The owner
may raise their own score; a submission for the same initials from a different
owner is refused (``OwnershipError`` -> 403). The owner token is never returned
by the API -- only its hash is stored, and ``_public`` strips even that before a
row leaves the server, so the board cannot be used to discover an owner's token.

The pure helpers (``sanitize_initials``, ``coerce_score``, ``insert_sorted``) are
validated directly in tests. ``LeaderboardStore`` adds the I/O shell: a lock so
the ``ThreadingHTTPServer`` cannot interleave read-modify-write, and an atomic
temp-then-rename so a crash mid-write never corrupts the board. Stdlib only.
"""
import hashlib
import hmac
import json
import os
import threading
import time

MAX_ENTRIES = 100
INITIALS_LEN = 3
# True ceiling for a run: base rounds (10 x 1000) plus the four finale stages
# (Feed Molly, pinball, blackjack, slots), each capped at 10000 -> 50000. No
# legitimate run exceeds this, so it rejects inflated/forged submissions.
SCORE_MAX = 50_000
# A GOD GAMER must clear the slot finale, which alone banks exactly 10000, so
# every crowned run scores at least this. A claimed god flag below the floor is
# not a real victory and is dropped (the score itself is still recorded).
GOD_MIN = 10_000


class OwnershipError(Exception):
    """A submission targets initials already owned by a different player."""


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


def hash_owner(token):
    """SHA-256 hex of an owner token, or None for a blank/missing token."""
    if not token:
        return None
    return hashlib.sha256(str(token).encode("utf-8")).hexdigest()


def _public(entry):
    """A board row safe to hand to clients: never leak the owner hash (the
    binding that proves ownership) or the legacy client id."""
    return {k: v for k, v in entry.items() if k not in ("owner_hash", "client_id")}


def _collapse_by_initials(entries):
    """One row per name, keeping each name's best (score desc, ts asc).

    Legacy/edited data from the old per-client scheme can hold several rows for
    one name; collapsing on every write heals the whole board to one-row-per-name,
    not just for the initials being submitted.
    """
    best = {}
    for e in entries:
        name = e.get("initials")
        cur = best.get(name)
        if cur is None or (e.get("score", 0), -e.get("ts", 0)) > (
                cur.get("score", 0), -cur.get("ts", 0)):
            best[name] = e
    return list(best.values())


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
        """Current board, sorted, capped, and stripped of owner secrets."""
        with self._lock:
            entries = self._load_locked()
        ranked = sorted(entries, key=lambda e: (-e["score"], e["ts"]))[: self.max_entries]
        return [_public(e) for e in ranked]

    def add(self, initials, score, god=False, owner_token=None, ts=None):
        """Validate, claim/upsert by initials, persist; return (entry, rank,
        board, improved) with every row stripped of owner secrets.

        The board holds **one row per set of initials**, owned by the first
        player to claim it (the hash of their secret ``owner_token``). The owner
        may raise their own score: a higher score replaces the standing row, a
        lower-or-equal one leaves it untouched (``improved=False``) so a weak run
        never knocks a good score off. A submission for the same initials from a
        different owner raises ``OwnershipError`` (-> 403). A pre-ownership legacy
        row (no ``owner_hash``) is claimable and binds to the first valid owner.

        ``god`` is honoured only when the score clears ``GOD_MIN`` -- a claimed
        crown below a real victory's floor is dropped while the score still
        counts. ``rank`` is the resulting 1-based position; it can exceed the cap
        when a full board edged the run out. Raises ValueError on invalid
        initials, score, or a missing owner token so the caller answers 400.
        """
        clean = sanitize_initials(initials)
        if len(clean) != INITIALS_LEN:
            raise ValueError("initials must be three letters")
        clean_score = coerce_score(score)
        if clean_score is None:
            raise ValueError("score must be a positive number within range")
        owner = hash_owner(owner_token)
        if owner is None:
            raise ValueError("a submission must carry an owner token")
        accept_god = bool(god) and clean_score >= GOD_MIN
        with self._lock:
            entries = self._load_locked()
            # Collapse any rows sharing these initials (legacy/edited data may hold
            # more than one) to the single best, and key the board on initials.
            mine = [e for e in entries if e.get("initials") == clean]
            others = _collapse_by_initials(
                e for e in entries if e.get("initials") != clean)
            best = max(mine, key=lambda e: e["score"]) if mine else None
            if best is not None:
                owned_by = best.get("owner_hash")
                if owned_by is not None and not hmac.compare_digest(owned_by, owner):
                    raise OwnershipError("those initials are taken")
            if best is not None and clean_score <= best["score"]:
                # Not a personal best -- keep the standing row, but bind it to this
                # now-proven owner (claims a legacy row) and dedupe to one row.
                entry = dict(best)
                entry["owner_hash"] = owner
                entry.pop("client_id", None)
                entry["god"] = bool(entry.get("god")) and entry.get("score", 0) >= GOD_MIN
                improved = False
            else:
                # New initials, or the owner raising their own score.
                entry = {
                    "initials": clean,
                    "score": clean_score,
                    "god": accept_god,
                    "ts": int(ts if ts is not None else time.time() * 1000),
                    "owner_hash": owner,
                }
                improved = True
            rank = rank_of(others, entry["score"])  # vs the board minus this name
            board = insert_sorted(others, entry, self.max_entries)
            self._write_locked(board)
        return _public(entry), rank, [_public(e) for e in board], improved
