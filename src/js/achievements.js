/*
 * Pin the Wig on Hexy -- achievement progression rules.
 *
 * Two tracks of three tiers each (1 / 5 / all): listening to songs on the
 * radio, and hearing the post-stage voice lines. Progress is keyed by file
 * NAME in the I/O shell (game.js) so it survives the daily shuffle and page
 * reloads; this module only deals in counts and totals.
 *
 * Pure and DOM-free -- the unlock logic and the "what counts as listened"
 * rule are verifiable in Node (see tests/).
 *
 * Loaded as a plain script in the browser (sets window.PTWOHAchievements) and
 * as a CommonJS module in Node tests -- no build step.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.PTWOHAchievements = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var ACHIEVEMENTS = [
    { id: "song-1",    track: "song",  threshold: 1,     title: "Tuned In",          desc: "Listen to a whole song." },
    { id: "song-5",    track: "song",  threshold: 5,     title: "Regular Listener",  desc: "Listen to 5 different songs." },
    { id: "song-all",  track: "song",  threshold: "all", title: "Completionist",     desc: "Listen to every song in the album." },
    { id: "voice-1",   track: "voice", threshold: 1,     title: "Did You Hear That?", desc: "Hear a voice line." },
    { id: "voice-5",   track: "voice", threshold: 5,     title: "All Ears",          desc: "Hear 5 different voice lines." },
    { id: "voice-all", track: "voice", threshold: "all", title: "Heard It All",      desc: "Hear every voice line." },
  ];

  function get(id) {
    for (var i = 0; i < ACHIEVEMENTS.length; i++) {
      if (ACHIEVEMENTS[i].id === id) return ACHIEVEMENTS[i];
    }
    return null;
  }

  // A song counts as "listened" once the player has had >= 60s of audible
  // playtime on it, OR played it through to its end with >= 10s of audible
  // tail (covers tuning into the station near the end of a track).
  function qualifiesAsListened(accumAudibleSeconds, reachedEnd) {
    var s = accumAudibleSeconds || 0;
    if (s >= 60) return true;
    return !!reachedEnd && s >= 10;
  }

  function tierUnlocked(count, total, threshold) {
    if (threshold === "all") return total >= 1 && count >= total;
    return count >= threshold;
  }

  // Which achievement ids are currently earned, given distinct-item counts and
  // the totals available. "all" never unlocks on an empty set; with fewer than
  // 5 items the "5" tier is simply unreachable.
  function evaluateUnlocks(songCount, songTotal, voiceCount, voiceTotal) {
    var counts = { song: songCount || 0, voice: voiceCount || 0 };
    var totals = { song: songTotal || 0, voice: voiceTotal || 0 };
    var out = [];
    for (var i = 0; i < ACHIEVEMENTS.length; i++) {
      var a = ACHIEVEMENTS[i];
      if (tierUnlocked(counts[a.track], totals[a.track], a.threshold)) out.push(a.id);
    }
    return out;
  }

  // Ids present in `current` but not in `previous` -- the toasts to fire.
  function newlyUnlocked(previousIds, currentIds) {
    var seen = {};
    var prev = previousIds || [];
    for (var i = 0; i < prev.length; i++) seen[prev[i]] = true;
    var out = [];
    var cur = currentIds || [];
    for (var j = 0; j < cur.length; j++) {
      if (!seen[cur[j]]) out.push(cur[j]);
    }
    return out;
  }

  return {
    ACHIEVEMENTS: ACHIEVEMENTS,
    get: get,
    qualifiesAsListened: qualifiesAsListened,
    evaluateUnlocks: evaluateUnlocks,
    newlyUnlocked: newlyUnlocked,
  };
});
