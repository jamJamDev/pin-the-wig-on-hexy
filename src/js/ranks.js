/*
 * Pin the Wig on Hexy -- end-of-game rank ladder.
 *
 * A score-based tier name for the game-over screen. The top rank, GOD GAMER,
 * is awarded ONLY for a flawless run (every round a bullseye) -- never by score
 * alone. That exactness is the whole point of the start-screen forfeiture
 * contract: fall short of perfect and you are, prominently, NOT a God Gamer.
 *
 * Pure and DOM-free -- the thresholds and the perfect-only gate are verifiable
 * in Node (see tests/). Loaded as a plain script in the browser (sets
 * window.PTWOHRanks) and as a CommonJS module in Node tests -- no build step.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.PTWOHRanks = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Ascending ladder, keyed by accuracy fraction (score / maxScore). GOD_GAMER
  // is deliberately NOT in this list -- it is reachable only via the allPerfect
  // gate in rankFor, so a 99.99% run can never round its way into godhood.
  var RANKS = [
    { id: "npc",           name: "NPC",           minAccuracy: 0,    blurb: "Did you even aim?" },
    { id: "casual",        name: "Casual",        minAccuracy: 0.20, blurb: "Mostly forehead, honestly." },
    { id: "button-masher", name: "Button Masher", minAccuracy: 0.40, blurb: "Patchy -- but he'll take it." },
    { id: "gamer",         name: "Gamer",         minAccuracy: 0.60, blurb: "Hexy looks decent." },
    { id: "pro-gamer",     name: "Pro Gamer",     minAccuracy: 0.75, blurb: "Hexy looks fabulous." },
    { id: "cracked",       name: "Cracked",       minAccuracy: 0.90, blurb: "So close to divinity." },
  ];

  var GOD_GAMER = { id: "god-gamer", name: "GOD GAMER", minAccuracy: 1, blurb: "Every round. Flawless. Bow down." };

  // The rank for a finished run. allPerfect (every round a bullseye) is the sole
  // path to GOD_GAMER; otherwise pick the highest ladder rank the accuracy clears.
  function rankFor(score, maxScore, allPerfect) {
    if (allPerfect) return GOD_GAMER;
    var acc = maxScore > 0 ? Math.max(0, score || 0) / maxScore : 0;
    var chosen = RANKS[0];
    for (var i = 0; i < RANKS.length; i++) {
      if (acc >= RANKS[i].minAccuracy) chosen = RANKS[i];
      else break;
    }
    return chosen;
  }

  function isGodGamer(rank) {
    return !!rank && rank.id === GOD_GAMER.id;
  }

  return {
    RANKS: RANKS,
    GOD_GAMER: GOD_GAMER,
    rankFor: rankFor,
    isGodGamer: isGodGamer,
  };
});
