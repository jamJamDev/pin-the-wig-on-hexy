"use strict";

// Feed Molly -- the can-rim opener bonus. Pure logic: seeded can order, the
// sweep/notch/patience model, tap scoring, multi-stop cans, and reduced-motion
// hazard routing. game.js is the untested I/O shell.

const test = require("node:test");
const assert = require("node:assert/strict");
const F = require("../src/js/feedmolly.js");

const TAU = Math.PI * 2;

test("angDiff returns the smallest signed difference in (-PI, PI]", () => {
  assert.ok(Math.abs(F.angDiff(0.1, 0.0) - 0.1) < 1e-9);
  assert.ok(Math.abs(F.angDiff(0.0, 0.1) + 0.1) < 1e-9);
  // Wrapping the long way around is the short way the other direction.
  assert.ok(Math.abs(F.angDiff(0.1, TAU - 0.1) - 0.2) < 1e-9);
});

test("normalizeAngle maps any angle into [0, TAU)", () => {
  assert.ok(F.normalizeAngle(-0.5) >= 0 && F.normalizeAngle(-0.5) < TAU);
  assert.ok(Math.abs(F.normalizeAngle(TAU + 1) - 1) < 1e-9);
});

test("pickCans pins the opener and finale, includes all cans, and is seed-stable", () => {
  const cans = F.pickCans(42);
  assert.equal(cans.length, F.CANS_GOAL);
  assert.equal(cans[0].key, "crack");                 // opener pinned
  assert.equal(cans[cans.length - 1].key, "diva");    // finale pinned
  const keys = cans.map((c) => c.key).sort();
  assert.deepEqual(keys, F.CANS.map((c) => c.key).sort());
  // Same seed -> same order.
  assert.deepEqual(F.pickCans(42).map((c) => c.key), cans.map((c) => c.key));
});

test("maxScore is every required strike a BULLSEYE plus an open bonus per can", () => {
  let expected = 0;
  for (const c of F.CANS) expected += c.rule.hits * F.BULLSEYE + F.OPEN_BONUS;
  assert.equal(F.maxScore(), expected);
  // Every stage tops out at the same 10000 so each contributes equally to the overall score.
  assert.equal(F.maxScore(), 10000);
});

test("createRun starts full patience on the first can", () => {
  const run = F.createRun(7);
  assert.equal(run.idx, 0);
  assert.equal(run.opened, 0);
  assert.equal(run.patience, 1);
  assert.equal(run.failed, false);
});

test("step keeps theta normalized and never drives patience below zero", () => {
  const run = F.createRun(99);
  for (let i = 0; i < 2000; i++) {
    F.step(run, 1 / 60, false);
    assert.ok(run.theta >= 0 && run.theta < TAU, "theta in range");
    assert.ok(run.patience >= 0, "patience >= 0");
  }
});

test("step eventually empties patience and flags patienceOut once", () => {
  const run = F.createRun(3);
  let outFlags = 0;
  for (let i = 0; i < 100000 && !run.failed; i++) {
    const ev = F.step(run, 1 / 60, false);
    if (ev.patienceOut) outFlags++;
  }
  assert.ok(run.failed, "patience drains to a failure");
  assert.equal(outFlags, 1, "patienceOut signals exactly on the failing frame");
});

test("the green tab scores bullseye / perfect / good by distance from center", () => {
  // Dead center -> bullseye (the bonus zone). Opener is a 1-hit can, so it also
  // opens and banks the open bonus.
  const run = F.createRun(11);
  const r = F.activeCan(run).rule;
  run.theta = run.notch;
  const bull = F.attempt(run);
  assert.equal(bull.tier, "bullseye");
  assert.equal(bull.points, F.BULLSEYE + F.OPEN_BONUS);

  // Just outside the bonus zone but well inside the green -> perfect.
  const run2 = F.createRun(11);
  const r2 = F.activeCan(run2).rule;
  run2.theta = F.normalizeAngle(run2.notch + r2.notch * 0.35);
  assert.equal(F.attempt(run2).tier, "perfect");

  // Near the edge of the green -> good.
  const run3 = F.createRun(11);
  const r3 = F.activeCan(run3).rule;
  run3.theta = F.normalizeAngle(run3.notch + r3.notch * 0.8);
  assert.equal(F.attempt(run3).tier, "good");
});

test("a tap on bare rim whiffs for zero and costs patience", () => {
  const run = F.createRun(5);
  const r = F.activeCan(run).rule;
  run.theta = F.normalizeAngle(run.notch + Math.PI);   // opposite the tab
  const before = run.patience;
  const res = F.attempt(run);
  assert.equal(res.tier, "whiff");
  assert.equal(res.points, 0);
  assert.ok(run.patience < before, "a whiff drains patience");
});

test("the decoy kibble arc scores negative on the finale can", () => {
  // Walk to the finale (the only can with a kibble arc).
  const run = F.createRun(8);
  while (F.activeCan(run).key !== "diva") F.nextCan(run);
  const r = F.activeCan(run).rule;
  assert.ok(r.kibble > 0, "finale has a kibble arc");
  run.theta = run.kibble;     // strike the decoy dead-on
  const res = F.attempt(run);
  assert.equal(res.tier, "kibble");
  assert.ok(res.points < 0);
});

test("a multi-stop can needs all its hits before it opens", () => {
  const run = F.createRun(13);
  while (F.activeCan(run).rule.hits < 2) F.nextCan(run);
  const need = F.activeCan(run).rule;
  for (let h = 1; h <= need.hits; h++) {
    run.theta = run.notch;                 // perfect each time
    const res = F.attempt(run);
    if (h < need.hits) assert.equal(res.opened, false, "not open until the last hit");
    else assert.equal(res.opened, true, "opens on the final hit");
  }
});

test("opening a can refills patience so a multi-can run is survivable", () => {
  const run = F.createRun(31);
  // Spend some patience first so a refill is observable (not clamped at 1).
  for (let i = 0; i < 300; i++) F.step(run, 1 / 60, false);
  const before = run.patience;
  assert.ok(before < 1, "patience drained below full");
  run.theta = run.notch;                 // perfect -> opens the 1-hit opener
  const res = F.attempt(run);
  assert.equal(res.opened, true);
  assert.ok(run.patience > before, "opening a can restores patience");
});

test("nextCan advances then refuses past the last can; isComplete tracks opens", () => {
  const run = F.createRun(21);
  for (let i = 1; i < F.CANS_GOAL; i++) assert.equal(F.nextCan(run), true);
  assert.equal(F.nextCan(run), false);   // already on the last can
  // Force all cans opened and confirm completion.
  run.opened = F.CANS_GOAL;
  assert.equal(F.isComplete(run), true);
});

test("the flip mechanic reverses the opener's direction over time", () => {
  // Advance to a can that flips (the "Second Thoughts" can, and the finale).
  const run = F.createRun(17);
  while (!F.activeCan(run).rule.flip) assert.equal(F.nextCan(run), true);
  const dirs = new Set();
  for (let i = 0; i < 3000; i++) {
    F.step(run, 1 / 60, false);
    dirs.add(run.dir);
    if (dirs.size > 1) break;
  }
  assert.ok(dirs.size > 1, "direction reverses at least once while sweeping");
});

test("the flipping opener always sweeps past the tab (never trapped out of reach)", () => {
  // Regression: a time-based flip could oscillate in an arc that never reached
  // the green tab. Distance-based flips must cross the notch every segment.
  for (let seed = 1; seed <= 40; seed++) {
    const run = F.createRun(seed);
    while (!F.activeCan(run).rule.flip) F.nextCan(run);
    let minDist = Infinity;
    for (let i = 0; i < 600; i++) {            // ~10s at 60fps
      F.step(run, 1 / 60, false);
      minDist = Math.min(minDist, Math.abs(F.angDiff(run.theta, run.notch)));
    }
    assert.ok(minDist <= F.activeCan(run).rule.notch,
      "seed " + seed + ": opener must reach the tab (min gap " + minDist.toFixed(3) + ")");
  }
});

test("a can without flip never reverses direction", () => {
  const run = F.createRun(2);
  // The opener never flips.
  assert.equal(F.activeCan(run).rule.flip, undefined);
  const dir0 = run.dir;
  for (let i = 0; i < 3000; i++) F.step(run, 1 / 60, false);
  assert.equal(run.dir, dir0, "a non-flip can keeps one direction");
});

test("reduced motion suppresses the rim jolt on a hazard strike", () => {
  // The finale always has a jolting hazard; advance to it.
  const run = F.createRun(4);
  while (F.activeCan(run).rule.hazard == null) F.nextCan(run);
  const r = F.activeCan(run).rule;
  // Drive frames until a strike resolves; with reduceMotion the notch must not
  // snap. We disable drift's contribution by sampling the notch right around
  // the strike frame.
  let strikes = 0;
  for (let i = 0; i < 100000 && strikes < 3 && !run.failed; i++) {
    const notchBefore = run.notch;
    const ev = F.step(run, 1 / 60, true);   // reduceMotion = true
    if (ev.strike) {
      strikes++;
      // Only drift (r.drift * dt) may have moved the notch this frame -- not a jolt.
      const moved = Math.abs(F.angDiff(run.notch, notchBefore));
      assert.ok(moved <= r.drift * (1 / 60) + 1e-6,
        "reduced motion: strike must not jolt the rim");
    }
  }
  assert.ok(strikes > 0, "a hazard actually struck during the sample");
});
