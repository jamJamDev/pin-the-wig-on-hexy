"use strict";

// achievements.js -- the "what counts as listened" rule and the 1/5/all tier
// unlock logic for the song and voice-line tracks.

const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("../src/js/achievements.js");

test("there are 6 achievements: songs 1/5/all + voice 1/5/all", () => {
  assert.equal(A.ACHIEVEMENTS.length, 6);
  const ids = A.ACHIEVEMENTS.map((a) => a.id).sort();
  assert.deepEqual(ids, ["song-1", "song-5", "song-all", "voice-1", "voice-50", "voice-all"].sort());
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
  // The mid voice milestone is now 50 lines, so hearing all 8 of a small set
  // trips voice-1 + voice-all (every line heard) but not voice-50.
  assert.deepEqual(A.evaluateUnlocks(0, 12, 8, 8), ["voice-1", "voice-all"]);
  // 50 of a 96-line library: the mid milestone trips, completion does not.
  assert.deepEqual(A.evaluateUnlocks(0, 12, 50, 96), ["voice-1", "voice-50"]);
});

test("the mid voice milestone requires 50 lines, not 5", () => {
  assert.equal(A.get("voice-50").threshold, 50);
  assert.equal(A.get("voice-5"), null, "the old 5-line id is gone");
  assert.deepEqual(A.evaluateUnlocks(0, 12, 49, 96), ["voice-1"]);          // 49 < 50
  assert.ok(A.evaluateUnlocks(0, 12, 50, 96).includes("voice-50"));         // 50 trips it
});

test("isResettable: only the completion ('all') tier resets", () => {
  assert.equal(A.isResettable("voice-all"), true);
  assert.equal(A.isResettable("song-all"), true);
  assert.equal(A.isResettable("voice-50"), false);
  assert.equal(A.isResettable("voice-1"), false);
  assert.equal(A.isResettable("nope"), false);
});

test("reconcileEarned revokes a completion badge when the library grows", () => {
  // "Heard It All" earned at 90/90. Six new lines arrive -> 90/96 is no longer all.
  const current = A.evaluateUnlocks(0, 12, 90, 96);          // voice-1, voice-50, NOT voice-all
  assert.ok(!current.includes("voice-all"));
  const earned = A.reconcileEarned(["voice-1", "voice-50", "voice-all"], current);
  assert.ok(!earned.includes("voice-all"), "completion resets until they catch up");
  assert.ok(earned.includes("voice-50"), "count milestones stay earned");
  assert.ok(earned.includes("voice-1"));
});

test("reconcileEarned re-grants completion once every item is heard again", () => {
  const earned = A.reconcileEarned(["voice-1", "voice-50"], A.evaluateUnlocks(0, 12, 96, 96));
  assert.ok(earned.includes("voice-all"));
});

test("reconcileEarned keeps milestones below threshold and drops unknown ids", () => {
  // A milestone the player passed earlier stays even if the live count dips
  // (e.g. items were pruned); only completion reacts to the total. A stale id
  // from a renamed achievement is dropped so the trophy count stays honest.
  const earned = A.reconcileEarned(
    ["voice-1", "voice-50", "voice-5"], A.evaluateUnlocks(0, 12, 3, 96));
  assert.deepEqual(earned, ["voice-1", "voice-50"]);
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
