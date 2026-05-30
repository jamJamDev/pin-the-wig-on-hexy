"use strict";

// achievements.js -- the "what counts as listened" rule and the 1/5/all tier
// unlock logic for the song and voice-line tracks.

const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("../src/js/achievements.js");

test("there are 6 achievements: songs 1/5/all + voice 1/5/all", () => {
  assert.equal(A.ACHIEVEMENTS.length, 6);
  const ids = A.ACHIEVEMENTS.map((a) => a.id).sort();
  assert.deepEqual(ids, ["song-1", "song-5", "song-all", "voice-1", "voice-5", "voice-all"].sort());
});

test("get returns the definition by id, or null", () => {
  assert.equal(A.get("song-5").track, "song");
  assert.equal(A.get("voice-all").threshold, "all");
  assert.equal(A.get("nope"), null);
});

test("qualifiesAsListened: >= 60s of audible playtime counts", () => {
  assert.equal(A.qualifiesAsListened(59.99, false), false);
  assert.equal(A.qualifiesAsListened(60, false), true);
  assert.equal(A.qualifiesAsListened(120, false), true);
});

test("qualifiesAsListened: reaching the end needs >= 10s of tail", () => {
  assert.equal(A.qualifiesAsListened(9.99, true), false);
  assert.equal(A.qualifiesAsListened(10, true), true);
  assert.equal(A.qualifiesAsListened(30, true), true);
});

test("qualifiesAsListened: mid-song without reaching the end needs the full minute", () => {
  assert.equal(A.qualifiesAsListened(40, false), false);
  assert.equal(A.qualifiesAsListened(0, true), false);
  assert.equal(A.qualifiesAsListened(0, false), false);
});

test("evaluateUnlocks: song tiers trip at 1, 5, and all", () => {
  assert.deepEqual(A.evaluateUnlocks(0, 12, 0, 8), []);
  assert.deepEqual(A.evaluateUnlocks(1, 12, 0, 8), ["song-1"]);
  assert.deepEqual(A.evaluateUnlocks(5, 12, 0, 8), ["song-1", "song-5"]);
  assert.deepEqual(A.evaluateUnlocks(12, 12, 0, 8), ["song-1", "song-5", "song-all"]);
});

test("evaluateUnlocks: voice tiers are independent of songs", () => {
  assert.deepEqual(A.evaluateUnlocks(0, 12, 1, 8), ["voice-1"]);
  assert.deepEqual(A.evaluateUnlocks(0, 12, 8, 8), ["voice-1", "voice-5", "voice-all"]);
});

test("evaluateUnlocks: 'all' never unlocks on an empty manifest", () => {
  assert.deepEqual(A.evaluateUnlocks(0, 0, 0, 0), []);
  // count clamped by total can't be < total when total is 0, so guard matters.
  assert.ok(!A.evaluateUnlocks(0, 0, 0, 0).includes("song-all"));
  assert.ok(!A.evaluateUnlocks(0, 0, 0, 0).includes("voice-all"));
});

test("evaluateUnlocks: 'all' unlocks with < 5 items while '5' stays unreachable", () => {
  const ids = A.evaluateUnlocks(3, 3, 0, 8);
  assert.ok(ids.includes("song-1"));
  assert.ok(ids.includes("song-all"));
  assert.ok(!ids.includes("song-5"));
});

test("newlyUnlocked diffs current against previous", () => {
  assert.deepEqual(A.newlyUnlocked([], ["song-1"]), ["song-1"]);
  assert.deepEqual(A.newlyUnlocked(["song-1"], ["song-1", "song-5"]), ["song-5"]);
  assert.deepEqual(A.newlyUnlocked(["song-1", "song-5"], ["song-1", "song-5"]), []);
});
