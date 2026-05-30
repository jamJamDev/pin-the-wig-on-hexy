/*
 * Pin the Wig on Hexy -- leaderboard ordering rules.
 *
 * Pure, DOM-free ranking math shared by the client (decides whether a run made
 * the board and where) and mirrored, authoritatively, by the Python store on
 * the server. Entries rank by score descending; ties break by submission time
 * ascending, so the first player to reach a score keeps the higher slot. The
 * board is capped at the top MAX_ENTRIES.
 *
 * The score itself is the full run total (base rounds + pinball finale), so a
 * GOD GAMER still carries a number that competes against other GOD GAMERs --
 * the rank is a badge, never a substitute for the score.
 *
 * Loaded as a plain script in the browser (sets window.PTWOHLeaderboard) and as
 * a CommonJS module in Node tests -- no build step.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.PTWOHLeaderboard = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var MAX_ENTRIES = 100;
  var INITIALS_LEN = 3;

  // Keep only A-Z, uppercased, at most three -- the classic arcade tag. Returns
  // "" when nothing usable was typed (the caller treats that as "not entered").
  function sanitizeInitials(raw) {
    var s = (raw == null ? "" : String(raw)).toUpperCase();
    var out = "";
    for (var i = 0; i < s.length && out.length < INITIALS_LEN; i++) {
      var c = s.charCodeAt(i);
      if (c >= 65 && c <= 90) out += s.charAt(i);
    }
    return out;
  }

  // True once sanitizeInitials yielded the full three letters.
  function validInitials(raw) {
    return sanitizeInitials(raw).length === INITIALS_LEN;
  }

  // Sort by score desc, then submission time asc (earlier wins a tie). Pure --
  // returns a new array; the input is not mutated.
  function sortEntries(entries) {
    return (entries || []).slice().sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return (a.ts || 0) - (b.ts || 0);
    });
  }

  // The number of existing entries that outrank a brand-new run of `score`
  // (a fresh entry has the latest ts, so equal scores already on the board sit
  // above it). Its 1-based rank is one more than this.
  function _ahead(entries, score) {
    var n = 0;
    for (var i = 0; i < (entries || []).length; i++) {
      if (entries[i].score >= score) n++;
    }
    return n;
  }

  // 1-based position a new run of `score` would take on the board.
  function rankOf(entries, score) {
    return _ahead(entries, score) + 1;
  }

  // Would a new run of `score` earn a slot in the top `max`? A real result only
  // (score must be a positive, finite number); a full board requires beating the
  // current lowest score (a tie at the bottom does not bump the incumbent).
  function qualifies(entries, score, max) {
    var cap = max == null ? MAX_ENTRIES : max;
    if (!isFinite(score) || score <= 0) return false;
    return rankOf(entries, score) <= cap;
  }

  // Insert a new entry and return the new sorted board, capped to `max`.
  // Pure -- the input array is not mutated.
  function insert(entries, entry, max) {
    var cap = max == null ? MAX_ENTRIES : max;
    var next = sortEntries((entries || []).concat([entry]));
    return next.slice(0, cap);
  }

  // The player's standing entry, by their anonymous browser id. The id is a
  // best-effort identity (one row per browser profile, not per person) -- a
  // falsy id never matches, so anonymous runs are each their own row.
  function findByClient(entries, clientId) {
    if (!clientId) return null;
    var list = entries || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].client_id === clientId) return list[i];
    }
    return null;
  }

  // Upsert keeping one row per client at their best score (mirrors the server).
  // A higher score replaces the standing row; a lower-or-equal one leaves the
  // board unchanged. Pure -- returns a new capped, sorted board.
  function upsert(entries, entry, max) {
    var cap = max == null ? MAX_ENTRIES : max;
    var cid = entry.client_id;
    var list = entries || [];
    var existing = findByClient(list, cid);
    if (existing && existing.score >= entry.score) {
      return sortEntries(list).slice(0, cap); // their best holds -> unchanged
    }
    var kept = list.filter(function (e) {
      return !(cid && e.client_id === cid); // drop this player's stale row, if any
    });
    return sortEntries(kept.concat([entry])).slice(0, cap);
  }

  // Would this run earn or improve THIS client's slot in the top `max`? A real
  // positive score that beats the player's own standing entry (if any) and lands
  // within the cap once that stale entry is set aside.
  function qualifiesForClient(entries, score, clientId, max) {
    var cap = max == null ? MAX_ENTRIES : max;
    if (!isFinite(score) || score <= 0) return false;
    var existing = findByClient(entries, clientId);
    if (existing && score <= existing.score) return false;
    var others = (entries || []).filter(function (e) {
      return !(clientId && e.client_id === clientId);
    });
    return rankOf(others, score) <= cap;
  }

  return {
    MAX_ENTRIES: MAX_ENTRIES,
    INITIALS_LEN: INITIALS_LEN,
    sanitizeInitials: sanitizeInitials,
    validInitials: validInitials,
    sortEntries: sortEntries,
    rankOf: rankOf,
    qualifies: qualifies,
    insert: insert,
    findByClient: findByClient,
    upsert: upsert,
    qualifiesForClient: qualifiesForClient,
  };
});
