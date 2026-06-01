"use strict";

// radio.js -- the pure radio-station timeline: daily shuffle, cumulative
// timeline, wall-clock live position, and the small formatting helpers.

const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../src/js/radio.js");

test("dayIndex is the UTC day count for an epoch instant", () => {
  assert.equal(R.dayIndex(0), 0);
  assert.equal(R.dayIndex(86400000 - 1), 0);
  assert.equal(R.dayIndex(86400000), 1);
  assert.equal(R.dayIndex(86400000 * 19872 + 5), 19872);
});

test("dayOrder is deterministic for a given day", () => {
  const items = [0, 1, 2, 3, 4, 5, 6, 7];
  assert.deepEqual(R.dayOrder(items, 100), R.dayOrder(items, 100));
});

test("dayOrder is a valid permutation (no drops or dupes)", () => {
  const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  for (let d = 0; d < 50; d++) {
    const order = R.dayOrder(items, d);
    assert.equal(order.length, items.length);
    assert.deepEqual([...order].sort((a, b) => a - b), items);
  }
});

test("dayOrder varies across days", () => {
  const items = [0, 1, 2, 3, 4, 5];
  const base = R.dayOrder(items, 0).join(",");
  let differs = false;
  for (let d = 1; d <= 40 && !differs; d++) {
    if (R.dayOrder(items, d).join(",") !== base) differs = true;
  }
  assert.ok(differs, "no day in 1..40 produced a different order from day 0");
});

test("dayOrder returns a copy for 0 or 1 items", () => {
  assert.deepEqual(R.dayOrder([], 5), []);
  assert.deepEqual(R.dayOrder([7], 5), [7]);
});

test("normalizeDurations replaces missing/invalid with the constant", () => {
  const C = R.DEFAULT_TRACK_SECONDS;
  assert.deepEqual(R.normalizeDurations([120, null, 90]), [120, C, 90]);
  assert.deepEqual(R.normalizeDurations([0, -5, NaN, undefined]), [C, C, C, C]);
  assert.deepEqual(R.normalizeDurations([]), []);
});

test("buildTimeline gives cumulative starts and total", () => {
  const tl = R.buildTimeline([60, 120, 30]);
  assert.deepEqual(tl.cumulativeStarts, [0, 60, 180]);
  assert.equal(tl.total, 210);
});

test("livePosition lands in the right track at the right offset", () => {
  const durs = [60, 120, 30]; // total 210
  // anchor 0; nowMs in ms.
  assert.deepEqual(R.livePosition(30 * 1000, durs, 0), { index: 0, offset: 30 });
  assert.deepEqual(R.livePosition(90 * 1000, durs, 0), { index: 1, offset: 30 });
  assert.deepEqual(R.livePosition(200 * 1000, durs, 0), { index: 2, offset: 20 });
});

test("livePosition exact boundary falls to the start of the next track", () => {
  const durs = [60, 120, 30];
  assert.deepEqual(R.livePosition(60 * 1000, durs, 0), { index: 1, offset: 0 });
  assert.deepEqual(R.livePosition(180 * 1000, durs, 0), { index: 2, offset: 0 });
});

test("livePosition wraps the looping timeline", () => {
  const durs = [60, 120, 30]; // total 210
  // 210s -> wraps to 0; 215s -> 5s into track 0.
  assert.deepEqual(R.livePosition(210 * 1000, durs, 0), { index: 0, offset: 0 });
  assert.deepEqual(R.livePosition(215 * 1000, durs, 0), { index: 0, offset: 5 });
  // One full loop + 90s -> track 1, 30s in.
  assert.deepEqual(R.livePosition((210 + 90) * 1000, durs, 0), { index: 1, offset: 30 });
});

test("livePosition handles negative (pre-anchor) instants by wrapping", () => {
  const durs = [60, 120, 30]; // total 210
  const r = R.livePosition(-5 * 1000, durs, 0);
  assert.equal(r.index, 2);
  assert.ok(Math.abs(r.offset - 25) < 1e-9, "offset ~25s from album end");
});

test("livePosition respects a non-zero anchor", () => {
  const durs = [60, 120, 30];
  assert.deepEqual(R.livePosition(1000 + 30 * 1000, durs, 1000), { index: 0, offset: 30 });
});

test("livePosition guards empty and zero-total", () => {
  assert.deepEqual(R.livePosition(123456, [], 0), { index: 0, offset: 0 });
  assert.deepEqual(R.livePosition(123456, [0, 0, 0], 0), { index: 0, offset: 0 });
});

test("livePosition works for a single track", () => {
  assert.deepEqual(R.livePosition(45 * 1000, [100], 0), { index: 0, offset: 45 });
  assert.deepEqual(R.livePosition(145 * 1000, [100], 0), { index: 0, offset: 45 });
});

test("isLivePosition is true on the live track within tolerance", () => {
  const durs = [60, 120, 30]; // total 210; at 90s -> {index:1, offset:30}
  assert.equal(R.isLivePosition(90 * 1000, durs, 0, 1, 30, 2), true);    // exact
  assert.equal(R.isLivePosition(90 * 1000, durs, 0, 1, 31.5, 2), true);  // 1.5s behind
  assert.equal(R.isLivePosition(90 * 1000, durs, 0, 1, 28.5, 2), true);  // 1.5s ahead
});

test("isLivePosition treats the tolerance edge as still live", () => {
  const durs = [60, 120, 30];
  assert.equal(R.isLivePosition(90 * 1000, durs, 0, 1, 32, 2), true);   // exactly 2s diff
  assert.equal(R.isLivePosition(90 * 1000, durs, 0, 1, 33, 2), false);  // 3s diff -> drifted
});

test("isLivePosition is false on the wrong track regardless of offset", () => {
  const durs = [60, 120, 30];
  assert.equal(R.isLivePosition(90 * 1000, durs, 0, 0, 30, 2), false);
  assert.equal(R.isLivePosition(90 * 1000, durs, 0, 2, 30, 1000), false);
});

test("isLivePosition requires an exact match when tolerance is omitted or negative", () => {
  const durs = [60, 120, 30];
  assert.equal(R.isLivePosition(90 * 1000, durs, 0, 1, 30), true);        // exact
  assert.equal(R.isLivePosition(90 * 1000, durs, 0, 1, 30.5), false);     // 0.5s off
  assert.equal(R.isLivePosition(90 * 1000, durs, 0, 1, 30, -5), true);    // neg tol -> exact
  assert.equal(R.isLivePosition(90 * 1000, durs, 0, 1, 30.5, -5), false);
});

test("nextIndex / prevIndex wrap at both ends", () => {
  assert.equal(R.nextIndex(0, 3), 1);
  assert.equal(R.nextIndex(2, 3), 0);
  assert.equal(R.prevIndex(0, 3), 2);
  assert.equal(R.prevIndex(1, 3), 0);
});

test("nextIndex / prevIndex are stable for a single track", () => {
  assert.equal(R.nextIndex(0, 1), 0);
  assert.equal(R.prevIndex(0, 1), 0);
});

test("formatTime renders m:ss", () => {
  assert.equal(R.formatTime(0), "0:00");
  assert.equal(R.formatTime(5), "0:05");
  assert.equal(R.formatTime(65), "1:05");
  assert.equal(R.formatTime(59.9), "0:59");
  assert.equal(R.formatTime(3661), "61:01");
  assert.equal(R.formatTime(-10), "0:00");
});
