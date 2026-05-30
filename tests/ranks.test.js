"use strict";

// ranks.js -- the score-based rank ladder and the perfect-only gate on the top
// GOD GAMER rank for the game-over screen.

const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../src/js/ranks.js");

const MAX = 10000; // 10 rounds * 1000 (bullseye)

test("the ladder is ascending by accuracy and excludes GOD GAMER", () => {
  for (let i = 1; i < R.RANKS.length; i++) {
    assert.ok(R.RANKS[i].minAccuracy > R.RANKS[i - 1].minAccuracy);
  }
  assert.ok(!R.RANKS.some((r) => r.id === "god-gamer"));
  assert.equal(R.RANKS[0].minAccuracy, 0); // there is always a floor rank
});

test("GOD GAMER is awarded only for a flawless run", () => {
  assert.equal(R.rankFor(MAX, MAX, true).id, "god-gamer");
  assert.ok(R.isGodGamer(R.rankFor(MAX, MAX, true)));
});

test("a perfect SCORE without the allPerfect flag is NOT GOD GAMER", () => {
  // This is the crux: 100% score but not flagged perfect must fall short.
  const rank = R.rankFor(MAX, MAX, false);
  assert.notEqual(rank.id, "god-gamer");
  assert.equal(rank.id, "cracked"); // acc 1.0 clears the top ladder rung
  assert.ok(!R.isGodGamer(rank));
});

test("accuracy thresholds map to the right ladder rank", () => {
  assert.equal(R.rankFor(0, MAX, false).id, "npc");
  assert.equal(R.rankFor(1999, MAX, false).id, "npc");        // 19.99%
  assert.equal(R.rankFor(2000, MAX, false).id, "casual");     // 20%
  assert.equal(R.rankFor(3999, MAX, false).id, "casual");     // 39.99%
  assert.equal(R.rankFor(4000, MAX, false).id, "button-masher"); // 40%
  assert.equal(R.rankFor(6000, MAX, false).id, "gamer");      // 60%
  assert.equal(R.rankFor(7499, MAX, false).id, "gamer");      // 74.99%
  assert.equal(R.rankFor(7500, MAX, false).id, "pro-gamer");  // 75%
  assert.equal(R.rankFor(8999, MAX, false).id, "pro-gamer");  // 89.99%
  assert.equal(R.rankFor(9000, MAX, false).id, "cracked");    // 90%
});

test("rankFor is robust to degenerate inputs", () => {
  assert.equal(R.rankFor(0, 0, false).id, "npc");       // no max -> floor
  assert.equal(R.rankFor(-500, MAX, false).id, "npc");  // negative score -> floor
  assert.equal(R.rankFor(0, 0, true).id, "god-gamer");  // perfect flag still wins
});

test("isGodGamer is false for every ladder rank and for null", () => {
  R.RANKS.forEach((r) => assert.ok(!R.isGodGamer(r)));
  assert.ok(!R.isGodGamer(null));
  assert.ok(!R.isGodGamer(undefined));
});
