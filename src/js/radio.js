/*
 * Pin the Wig on Hexy -- radio-station timeline math.
 *
 * The music player behaves like an always-on station: the album is one
 * continuous, endlessly looping timeline, and the play position is derived
 * from the wall clock (epoch). Every visit recomputes the live position, so
 * leaving and returning lands you where the station "would" be. The track
 * order is daily-shuffled -- a deterministic permutation seeded by the UTC day
 * index, so every visitor on the same day hears the same order.
 *
 * This module is pure and DOM-free: every function operates on plain values.
 * That keeps the timeline core verifiable in Node (see tests/) -- game.js is
 * the I/O shell that owns the <audio> element and the widget.
 *
 * Loaded as a plain script in the browser (sets window.PTWOHRadio) and as a
 * CommonJS module in Node tests -- no build step.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.PTWOHRadio = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var MS_PER_DAY = 86400000;

  // Fallback length for a track whose duration is missing/invalid in the
  // manifest. A fixed constant (not a per-browser measurement) so every
  // visitor agrees on the timeline -- the shared-clock station only stays in
  // sync if everyone computes identical durations.
  var DEFAULT_TRACK_SECONDS = 180;

  // mulberry32 -- the same tiny seeded PRNG game logic uses elsewhere, so the
  // daily shuffle is deterministic across browsers and Node.
  function makeRng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Fisher-Yates. Returns a new array; does not mutate the input.
  function shuffle(arr, rng) {
    var out = arr.slice();
    for (var i = out.length - 1; i > 0; i--) {
      var j = (rng() * (i + 1)) | 0;
      var tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }

  // UTC day index for a given epoch-ms instant -- the daily-shuffle seed.
  function dayIndex(nowMs) {
    return Math.floor((nowMs || 0) / MS_PER_DAY);
  }

  // Deterministic per-day permutation of an array (typically track indices).
  // Same dayIndex -> same order for everyone; order changes each UTC day.
  // Arrays of 0 or 1 elements are returned as a copy unchanged.
  function dayOrder(items, dIndex) {
    if (!items || items.length <= 1) return (items || []).slice();
    var seed = (((dIndex >>> 0) ^ 0x9e3779b9) + 0x85ebca6b) >>> 0 || 1;
    return shuffle(items, makeRng(seed));
  }

  function normDur(d) {
    return (typeof d === "number" && isFinite(d) && d > 0) ? d : DEFAULT_TRACK_SECONDS;
  }

  // Replace missing/invalid durations with the shared fallback constant so the
  // timeline is coherent for every visitor. Returns a new array.
  function normalizeDurations(durations) {
    var out = [];
    for (var i = 0; i < (durations ? durations.length : 0); i++) out.push(normDur(durations[i]));
    return out;
  }

  // Cumulative start offset (seconds) of each track, plus the album total.
  // Sums durations as given -- callers normalize first (normalizeDurations).
  function buildTimeline(durations) {
    var starts = [];
    var acc = 0;
    for (var i = 0; i < (durations ? durations.length : 0); i++) {
      starts.push(acc);
      acc += (typeof durations[i] === "number" && isFinite(durations[i])) ? durations[i] : 0;
    }
    return { cumulativeStarts: starts, total: acc };
  }

  // Where the station "is" right now: which track and how far into it.
  // Math is done in float milliseconds (no whole-second pre-quantize) so the
  // returned offset has sub-second precision for seeking <audio>.currentTime.
  // Guards an empty list and a non-positive total (returns the safe origin).
  function livePosition(nowMs, durations, anchorMs) {
    var n = durations ? durations.length : 0;
    if (n === 0) return { index: 0, offset: 0 };
    var tl = buildTimeline(durations);
    if (tl.total <= 0) return { index: 0, offset: 0 };
    var anchor = anchorMs || 0;
    var periodMs = tl.total * 1000;
    var elapsedMs = (((nowMs - anchor) % periodMs) + periodMs) % periodMs;
    var elapsed = elapsedMs / 1000;
    for (var i = 0; i < n; i++) {
      var start = tl.cumulativeStarts[i];
      var dur = (typeof durations[i] === "number" && isFinite(durations[i])) ? durations[i] : 0;
      // Exact boundary (elapsed === start of track i) falls to track i at
      // offset 0, never to the end of track i-1.
      if (elapsed < start + dur) return { index: i, offset: elapsed - start };
    }
    // Float catch-all: elapsed grazed the album end -> last track.
    var last = n - 1;
    return { index: last, offset: Math.max(0, elapsed - tl.cumulativeStarts[last]) };
  }

  function nextIndex(i, n) {
    if (n <= 0) return 0;
    return ((i + 1) % n + n) % n;
  }

  function prevIndex(i, n) {
    if (n <= 0) return 0;
    return ((i - 1) % n + n) % n;
  }

  // Seconds -> "m:ss" (minutes may exceed 59 for long tracks).
  function formatTime(seconds) {
    var s = Math.max(0, Math.floor(seconds || 0));
    var m = Math.floor(s / 60);
    var r = s % 60;
    return m + ":" + (r < 10 ? "0" : "") + r;
  }

  return {
    DEFAULT_TRACK_SECONDS: DEFAULT_TRACK_SECONDS,
    makeRng: makeRng,
    shuffle: shuffle,
    dayIndex: dayIndex,
    dayOrder: dayOrder,
    normalizeDurations: normalizeDurations,
    buildTimeline: buildTimeline,
    livePosition: livePosition,
    nextIndex: nextIndex,
    prevIndex: prevIndex,
    formatTime: formatTime,
  };
});
