"use strict";

// Full movement integration -- stepHexy with variations stacked. These are the
// "brutal but not broken" guarantees: with all 10 variations live at round 10,
// Hexy must stay on-screen, stay finite, and never permanently freeze, while
// still escalating hard from round 1.

const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../src/js/modifiers.js");

const VIEW = { w: 800, h: 600 };
const DT = 1 / 60;

// A simulation positioned and launched the way game.js nextRound() does.
function makeSim(seed, round) {
  const plan = M.buildPlan(seed);
  const active = M.resetPlanForRound(plan, round, seed);
  const base = Math.min(VIEW.w, VIEW.h);
  const speed = base * (0.30 + round * 0.105);
  const ang = M.makeRng(((seed ^ 0x9e3779b9) + round * 0x85ebca6b) >>> 0)() * Math.PI * 2;
  return {
    hexy: {
      x: VIEW.w / 2 - 60,
      y: VIEW.h * 0.34 - 75,
      w: 120,
      h: 150,
      vx: Math.cos(ang) * speed,
      vy: Math.sin(ang) * speed * 0.7,
      wobble: 0,
    },
    view: VIEW,
    baseSpeed: speed,
    round: round,
    activeModifiers: active,
    state: "playing",
    bounceX: 0,
    bounceY: 0,
  };
}

function travel(sim, frames, reduceMotion) {
  let dist = 0;
  let px = sim.hexy.x;
  let py = sim.hexy.y;
  for (let f = 0; f < frames; f++) {
    M.stepHexy(sim, DT, 1, !!reduceMotion);
    dist += Math.hypot(sim.hexy.x - px, sim.hexy.y - py);
    px = sim.hexy.x;
    py = sim.hexy.y;
  }
  return dist;
}

test("Hexy never leaves the arena with all 10 variations stacked", () => {
  for (let seed = 1; seed <= 25; seed++) {
    const sim = makeSim(seed, 10);
    for (let f = 0; f < 1800; f++) {
      M.stepHexy(sim, DT, 1, false);
      assert.ok(sim.hexy.x >= 0 && sim.hexy.x <= VIEW.w - sim.hexy.w,
        "seed " + seed + " frame " + f + ": x=" + sim.hexy.x.toFixed(1) + " off-screen");
      assert.ok(sim.hexy.y >= 0 && sim.hexy.y <= VIEW.h - sim.hexy.h,
        "seed " + seed + " frame " + f + ": y=" + sim.hexy.y.toFixed(1) + " off-screen");
      assert.ok(Number.isFinite(sim.hexy.x) && Number.isFinite(sim.hexy.y),
        "seed " + seed + " frame " + f + ": position non-finite");
    }
  }
});

test("base velocity stays finite across a full round-10 run", () => {
  const sim = makeSim(7, 10);
  for (let f = 0; f < 1800; f++) {
    M.stepHexy(sim, DT, 1, false);
    assert.ok(Number.isFinite(sim.hexy.vx) && Number.isFinite(sim.hexy.vy),
      "velocity non-finite at frame " + f);
  }
});

test("Hexy is never frozen for long -- moves within any ~0.6s window at round 10", () => {
  for (let seed = 1; seed <= 15; seed++) {
    const sim = makeSim(seed, 10);
    let stalled = 0;
    let maxStall = 0;
    let px = sim.hexy.x;
    let py = sim.hexy.y;
    for (let f = 0; f < 1800; f++) {
      M.stepHexy(sim, DT, 1, false);
      const moved = Math.hypot(sim.hexy.x - px, sim.hexy.y - py);
      if (moved < 0.05) stalled++;
      else stalled = 0;
      maxStall = Math.max(maxStall, stalled);
      px = sim.hexy.x;
      py = sim.hexy.y;
    }
    assert.ok(maxStall < 40, "seed " + seed + " stalled " + maxStall + " frames (>0.66s)");
  }
});

test("difficulty escalates round over round -- a real ramp, not a flat line", () => {
  const dist = [];
  for (let round = 1; round <= 10; round++) {
    let sum = 0;
    for (let seed = 1; seed <= 8; seed++) {
      sum += travel(makeSim(seed, round), 400, false);
    }
    dist.push(sum);
  }
  let rises = 0;
  for (let i = 1; i < 10; i++) if (dist[i] > dist[i - 1]) rises++;
  assert.ok(rises >= 8,
    "travel should climb in >=8 of 9 round transitions: " + dist.map((d) => d.toFixed(0)).join(", "));
  assert.ok(dist[3] > dist[0] * 1.4,
    "round 4 (" + dist[3].toFixed(0) + ") must clearly beat round 1 (" + dist[0].toFixed(0) + ")");
  assert.ok(dist[6] > dist[3] * 1.2,
    "round 7 (" + dist[6].toFixed(0) + ") must clearly beat round 4 (" + dist[3].toFixed(0) + ")");
  assert.ok(dist[9] > dist[6] * 1.15,
    "round 10 (" + dist[9].toFixed(0) + ") must clearly beat round 7 (" + dist[6].toFixed(0) + ")");
});

test("center bias keeps Hexy off the walls -- no corner trap", () => {
  for (let seed = 1; seed <= 12; seed++) {
    const sim = makeSim(seed, 10);
    let wallStreak = 0;
    let maxWallStreak = 0;
    let sumOffset = 0;
    for (let f = 0; f < 1800; f++) {
      M.stepHexy(sim, DT, 1, false);
      const onWall =
        sim.hexy.x <= 1 || sim.hexy.x >= VIEW.w - sim.hexy.w - 1 ||
        sim.hexy.y <= 1 || sim.hexy.y >= VIEW.h - sim.hexy.h - 1;
      wallStreak = onWall ? wallStreak + 1 : 0;
      if (wallStreak > maxWallStreak) maxWallStreak = wallStreak;
      const fx = Math.abs(sim.hexy.x + sim.hexy.w / 2 - VIEW.w / 2) / (VIEW.w / 2);
      const fy = Math.abs(sim.hexy.y + sim.hexy.h / 2 - VIEW.h / 2) / (VIEW.h / 2);
      sumOffset += Math.max(fx, fy);
    }
    assert.ok(maxWallStreak < 45,
      "seed " + seed + ": Hexy clung to a wall for " + maxWallStreak + " frames (corner trap)");
    assert.ok(sumOffset / 1800 < 0.58,
      "seed " + seed + ": mean wall-ward offset " + (sumOffset / 1800).toFixed(2) +
      " -- Hexy should stay weighted toward center");
  }
});

test("reduced-motion runs stay bounded and finite at round 10", () => {
  for (let seed = 1; seed <= 10; seed++) {
    const sim = makeSim(seed, 10);
    for (let f = 0; f < 900; f++) {
      M.stepHexy(sim, DT, 1, true);
      assert.ok(Number.isFinite(sim.hexy.x) && Number.isFinite(sim.hexy.y),
        "seed " + seed + " reduced-motion position non-finite");
      assert.ok(sim.hexy.x >= 0 && sim.hexy.x <= VIEW.w - sim.hexy.w &&
        sim.hexy.y >= 0 && sim.hexy.y <= VIEW.h - sim.hexy.h,
        "seed " + seed + " reduced-motion position off-screen");
    }
  }
});

test("a stepped run is fully deterministic for a fixed seed", () => {
  const a = makeSim(99, 10);
  const b = makeSim(99, 10);
  for (let f = 0; f < 900; f++) {
    M.stepHexy(a, DT, 1, false);
    M.stepHexy(b, DT, 1, false);
  }
  assert.equal(a.hexy.x, b.hexy.x, "x diverged for identical seeds");
  assert.equal(a.hexy.y, b.hexy.y, "y diverged for identical seeds");
});

test("celebration speed-scaling calms movement (roundEnd vs playing)", () => {
  const playing = travel(makeSim(5, 8), 300, false);
  const celebrating = makeSim(5, 8);
  celebrating.state = "roundEnd";
  let dist = 0;
  let px = celebrating.hexy.x;
  let py = celebrating.hexy.y;
  for (let f = 0; f < 300; f++) {
    M.stepHexy(celebrating, DT, 0.55, false);
    dist += Math.hypot(celebrating.hexy.x - px, celebrating.hexy.y - py);
    px = celebrating.hexy.x;
    py = celebrating.hexy.y;
  }
  assert.ok(dist < playing, "celebration travel (" + dist.toFixed(0) +
    ") should be calmer than full-speed play (" + playing.toFixed(0) + ")");
});
