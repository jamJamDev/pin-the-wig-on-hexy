"use strict";

// The pinball bonus phase in isolation: the five table definitions are
// well-formed, table selection is deterministic, collision/scoring math never
// produces NaN, capture only fires for a settled ball with an open gate, drains
// are detected, the per-table rules stay within their declared bounds, and a
// fixed seed + input script reproduces an identical simulation.

const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../src/js/pinball.js");

const VIEW = { w: 620, h: 1000 };

function freshRun(seed) { return P.createRun(seed || 7, VIEW); }

// Force a run onto a specific table by id (selection order is shuffled).
function runOnTable(id, seed) {
  const run = freshRun(seed);
  const i = run.tables.findIndex((t) => t.id === id);
  assert.ok(i >= 0, "table " + id + " present in run");
  run.idx = i;
  P.layout(run, VIEW);
  P.resetRuleState(run);
  P.serveBall(run);
  return run;
}

function finiteBall(b, where) {
  for (const k of ["x", "y", "vx", "vy"]) {
    assert.ok(Number.isFinite(b[k]), where + ": ball." + k + " not finite");
  }
}

test("there are exactly five well-formed tables with known rules and in-range coords", () => {
  assert.equal(P.TABLES.length, 5);
  const ruleTypes = ["static", "moveHolder", "shutter", "gust", "gauntlet"];
  const ids = {};
  for (const t of P.TABLES) {
    assert.equal(typeof t.id, "string");
    assert.equal(typeof t.name, "string");
    assert.equal(typeof t.hint, "string");
    assert.ok(!ids[t.id], "duplicate table id " + t.id);
    ids[t.id] = true;
    assert.ok(ruleTypes.includes(t.rule.type), t.id + " has unknown rule " + t.rule.type);
    assert.ok(t.gravity > 0 && Number.isFinite(t.gravity), t.id + " gravity invalid");

    const h = t.holder;
    for (const k of ["x", "y", "w", "h", "captureSpeed"]) {
      assert.ok(Number.isFinite(h[k]), t.id + " holder." + k + " not finite");
    }
    assert.ok(h.x > 0 && h.x < 1 && h.y > 0 && h.y < 1, t.id + " holder center out of (0,1)");

    for (const bm of t.bumpers) {
      assert.ok(bm.x > 0 && bm.x < 1 && bm.y > 0 && bm.y < 1, t.id + " bumper out of (0,1)");
      assert.ok(bm.r > 0 && bm.r < 0.5, t.id + " bumper radius unreasonable");
      assert.ok(bm.bounce > 0, t.id + " bumper bounce invalid");
    }
  }
  // CAPTURE_VALUES aligns with the five tables.
  assert.equal(P.CAPTURE_VALUES.length, 5);
});

test("pickTables is deterministic, pins opener and finale, and varies the middle by seed", () => {
  const a = P.pickTables(1234).map((t) => t.id);
  const b = P.pickTables(1234).map((t) => t.id);
  assert.deepEqual(a, b, "same seed must yield same order");
  assert.equal(a[0], "warmup", "opener pinned");
  assert.equal(a[4], "gauntlet", "finale pinned");
  // Every run is a permutation of all five tables.
  assert.deepEqual([...a].sort(), ["forehead", "gauntlet", "grease", "storm", "warmup"]);

  // Over many seeds the middle three actually reorder (not a fixed sequence).
  const seen = new Set();
  for (let s = 1; s <= 60; s++) seen.add(P.pickTables(s).slice(1, 4).map((t) => t.id).join(","));
  assert.ok(seen.size > 1, "middle three never varied across seeds");
});

test("closestPointOnSegment clamps to the segment endpoints", () => {
  const a = { x: 0, y: 0 }, b = { x: 10, y: 0 };
  assert.deepEqual(
    { x: P.closestPointOnSegment({ x: 5, y: 4 }, a, b).x, y: P.closestPointOnSegment({ x: 5, y: 4 }, a, b).y },
    { x: 5, y: 0 }
  );
  assert.equal(P.closestPointOnSegment({ x: -3, y: 9 }, a, b).x, 0); // clamps to a
  assert.equal(P.closestPointOnSegment({ x: 99, y: 9 }, a, b).x, 10); // clamps to b
});

test("reflectVel flips the normal component, preserves the tangent, never NaNs", () => {
  // Horizontal floor, normal pointing up (0,-1): vy flips sign, vx preserved.
  const r = P.reflectVel(3, 5, 0, -1, 1);
  assert.equal(Math.round(r.vx), 3);
  assert.equal(Math.round(r.vy), -5);
  for (let i = 0; i < 200; i++) {
    const ang = (i / 200) * Math.PI * 2;
    const out = P.reflectVel(Math.cos(ang) * 7, Math.sin(ang) * 4, Math.cos(ang), Math.sin(ang), 0.8);
    assert.ok(Number.isFinite(out.vx) && Number.isFinite(out.vy), "reflect produced NaN at " + i);
  }
});

test("a settled ball in the holder is captured; a fast one is not", () => {
  const run = runOnTable("warmup");
  const h = run.geom.holder;
  // Settled dead-center, gate open (static table).
  run.ball.live = true;
  run.ball.x = h.cx; run.ball.y = h.cy; run.ball.vx = 0; run.ball.vy = 0;
  let ev = P.step(run, 0.016, {});
  assert.equal(ev.captured, true, "slow centered ball should be captured");
  assert.equal(run.ball.live, false, "captured ball is no longer live");

  // Same spot but moving fast: must not count.
  P.serveBall(run);
  run.ball.live = true;
  run.ball.x = h.cx; run.ball.y = h.cy; run.ball.vx = h.captureSpeed * 3; run.ball.vy = 0;
  ev = P.step(run, 0.016, {});
  assert.equal(ev.captured, false, "fast ball must not be captured");
});

test("a closed shutter blocks capture even when the ball is settled inside", () => {
  // grease cycle: open 1150ms, closed 1250ms (cycle 2400ms). phase<1150 => open.
  function settledStepAt(t) {
    const run = runOnTable("grease");
    const h = run.geom.holder;
    run.ruleState.t = t;                 // tickRule advances by dt, then reads phase
    run.ball.live = true;
    run.ball.x = h.cx; run.ball.y = h.cy; run.ball.vx = 0; run.ball.vy = 0;
    return { run, ev: P.step(run, 0.001, {}) };
  }
  // The ball is geometrically inside either way.
  const closed = settledStepAt(1.5);    // phase ~1501ms => closed
  assert.equal(closed.run.ruleState.shutterOpen, false, "shutter should be closed at t=1.5");
  assert.equal(closed.ev.captured, false, "no capture while the gate is shut");

  const open = settledStepAt(0.1);       // phase ~101ms => open
  assert.equal(open.run.ruleState.shutterOpen, true, "shutter should be open at t=0.1");
  assert.equal(open.ev.captured, true, "settled ball captures through an open gate");
});

test("a ball past the bottom drains, and serveBall re-parks it at the plunger", () => {
  const run = runOnTable("warmup");
  run.ball.live = true;
  run.ball.x = run.rect.x + run.rect.w * 0.5;     // center drain gap
  run.ball.y = run.rect.y + run.rect.h * 0.99;
  run.ball.vx = 0; run.ball.vy = run.rect.h * 0.5;
  const ev = P.step(run, 0.016, {});
  assert.equal(ev.drained, true, "ball below the table should drain");
  assert.equal(run.ball.live, false);

  P.serveBall(run);
  assert.equal(run.ball.live, false);
  assert.ok(Math.abs(run.ball.x - run.geom.plunger.x) < 1e-6, "re-parked at plunger x");
  assert.ok(Math.abs(run.ball.y - run.geom.plunger.y) < 1e-6, "re-parked at plunger y");
});

test("a live ball falls under gravity, and Fart Storm's top zone falls slower", () => {
  // Baseline fall in mid-field on the warmup table.
  const run = runOnTable("warmup");
  run.ball.live = true;
  run.ball.x = run.rect.x + run.rect.w * 0.5;
  run.ball.y = run.rect.y + run.rect.h * 0.5;
  run.ball.vx = 0; run.ball.vy = 0;
  let y0 = run.ball.y;
  for (let i = 0; i < 10; i++) { P.step(run, 0.016, {}); }
  assert.ok(run.ball.y > y0, "ball must fall under gravity");

  // Storm: high in the low-gravity crown zone (ny < 0.42) it falls less far than
  // the same drop would in normal gravity.
  const storm = runOnTable("storm");
  storm.ball.live = true;
  storm.ball.x = storm.rect.x + storm.rect.w * 0.5;
  storm.ball.y = storm.rect.y + storm.rect.h * 0.20;   // top zone
  storm.ball.vx = 0; storm.ball.vy = 0;
  const topStart = storm.ball.y;
  for (let i = 0; i < 6; i++) { P.step(storm, 0.016, {}); }
  const topDrop = storm.ball.y - topStart;

  const storm2 = runOnTable("storm");
  storm2.ball.live = true;
  storm2.ball.x = storm2.rect.x + storm2.rect.w * 0.5;
  storm2.ball.y = storm2.rect.y + storm2.rect.h * 0.7;  // normal-gravity zone
  storm2.ball.vx = 0; storm2.ball.vy = 0;
  const lowStart = storm2.ball.y;
  for (let i = 0; i < 6; i++) { P.step(storm2, 0.016, {}); }
  const lowDrop = storm2.ball.y - lowStart;

  assert.ok(topDrop < lowDrop, "low-gravity top zone should fall slower than the main field");
});

test("moveHolder keeps the holder within its amplitude; shutter and gust toggle", () => {
  const run = runOnTable("forehead");
  const baseCx = run.geom.holder.baseCx;
  const amp = run.tables[run.idx].rule.amp * run.rect.w;
  for (let i = 0; i < 400; i++) {
    P.tickRule(run, 0.016);
    assert.ok(run.geom.holder.cx >= baseCx - amp - 1e-6 && run.geom.holder.cx <= baseCx + amp + 1e-6,
      "holder drifted outside its amplitude");
  }

  const gr = runOnTable("grease");
  let sawOpen = false, sawClosed = false;
  for (let i = 0; i < 400; i++) {
    P.tickRule(gr, 0.016);
    if (gr.ruleState.shutterOpen) sawOpen = true; else sawClosed = true;
  }
  assert.ok(sawOpen && sawClosed, "shutter must both open and close over time");

  const st = runOnTable("storm");
  let sawGust = false, sawCalm = false, dirs = new Set();
  for (let i = 0; i < 800; i++) {
    P.tickRule(st, 0.016);
    if (st.ruleState.gustActive) { sawGust = true; dirs.add(st.ruleState.gustDir); } else sawCalm = true;
  }
  assert.ok(sawGust && sawCalm, "gust must switch on and off");
  assert.ok(dirs.has(1) && dirs.has(-1), "gusts must blow both directions");
});

test("the gauntlet holder shrinks within [minHw, baseHw]", () => {
  const run = runOnTable("gauntlet");
  const baseHw = run.geom.holder.baseHw;
  const minHw = run.geom.holder.minHw;
  assert.ok(minHw < baseHw, "gauntlet must declare a smaller minimum width");
  let sawNarrow = false;
  for (let i = 0; i < 500; i++) {
    P.tickRule(run, 0.016);
    assert.ok(run.geom.holder.hw >= minHw - 1e-6 && run.geom.holder.hw <= baseHw + 1e-6,
      "holder width left its bounds");
    if (run.geom.holder.hw < baseHw * 0.6) sawNarrow = true;
  }
  assert.ok(sawNarrow, "holder should visibly shrink during the cycle");
});

test("capturePoints is bounded and ball-efficiency weighted; maxScore is 10000", () => {
  const run = freshRun(3);
  run.idx = 0; run.ballIndex = 1; assert.equal(P.capturePoints(run), 1000);
  run.idx = 0; run.ballIndex = 2; assert.equal(P.capturePoints(run), 800);
  run.idx = 0; run.ballIndex = 3; assert.equal(P.capturePoints(run), 600);
  run.idx = 4; run.ballIndex = 1; assert.equal(P.capturePoints(run), 3000);
  run.idx = 4; run.ballIndex = 3; assert.equal(P.capturePoints(run), 1800);
  assert.equal(P.maxScore(), 10000);
});

test("applyCapture / loseBall / nextTable / isComplete drive progression correctly", () => {
  const run = freshRun(11);
  assert.equal(P.isComplete(run), false);

  // First capture on ball 1.
  const pts = P.applyCapture(run);
  assert.equal(pts, 1000);
  assert.equal(run.score, 1000);
  assert.equal(run.captures, 1);

  // Drop two balls, then advancing resets the allotment.
  assert.equal(P.loseBall(run), 2);
  assert.equal(P.loseBall(run), 1);
  assert.equal(run.ballIndex, 3);
  assert.equal(P.nextTable(run), true);
  assert.equal(run.balls, P.BALLS_PER_TABLE);
  assert.equal(run.ballIndex, 1);
  assert.equal(run.idx, 1);

  // Drive to five captures: nextTable returns false after the last.
  run.captures = 4; run.idx = 4;
  P.applyCapture(run);
  assert.equal(run.captures, 5);
  assert.equal(P.isComplete(run), true);
  assert.equal(P.nextTable(run), false, "no sixth table");
});

test("a fixed seed and input script reproduce an identical simulation", () => {
  const script = [];
  for (let i = 0; i < 240; i++) {
    script.push({
      launchHeld: i < 55,
      launchReleased: i === 55,
      leftDown: i % 40 < 8,
      rightDown: i % 37 < 6
    });
  }
  function run(seed) {
    const r = freshRun(seed);
    const trace = [];
    for (let i = 0; i < script.length; i++) {
      const inp = script[i];
      P.setFlipper(r, "left", inp.leftDown);
      P.setFlipper(r, "right", inp.rightDown);
      P.step(r, 0.016, inp);
      trace.push([Math.round(r.ball.x * 1e3), Math.round(r.ball.y * 1e3), r.ball.live]);
    }
    return trace;
  }
  assert.deepEqual(run(99), run(99), "same seed + inputs must be identical");
});

test("the simulation never produces NaN across a long, input-heavy run", () => {
  const r = freshRun(5);
  for (let i = 0; i < 1200; i++) {
    const inp = {
      launchHeld: i < 50,
      launchReleased: i === 50,
      leftDown: i % 25 < 7,
      rightDown: i % 31 < 9
    };
    P.setFlipper(r, "left", inp.leftDown);
    P.setFlipper(r, "right", inp.rightDown);
    const ev = P.step(r, 0.016, inp);
    finiteBall(r.ball, "step " + i);
    // Recover from terminal events so the run keeps exercising physics.
    if (ev.drained) { P.loseBall(r); if (r.balls <= 0) { r.balls = P.BALLS_PER_TABLE; r.ballIndex = 1; } P.serveBall(r); }
    if (ev.captured) { P.applyCapture(r); if (!P.nextTable(r)) { r.idx = 0; P.layout(r, VIEW); P.resetRuleState(r); P.serveBall(r); } }
  }
});
