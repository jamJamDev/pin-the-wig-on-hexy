"use strict";

// Each of the 10 movement variations in isolation: parameter rolls stay in
// range, per-frame application never produces NaN/Infinity, and the variations
// that have safety contracts (stutter freeze window, swerve clamp, warp
// gating/bounds) actually honour them.

const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../src/js/modifiers.js");

function freshCtx() {
  return {
    heading: 0.5,
    speed: 200,
    posDX: 0,
    posDY: 0,
    warped: false,
    warpX: 0,
    warpY: 0,
    state: "playing",
    hexy: { x: 350, y: 250, w: 120, h: 150 },
    view: { w: 800, h: 600 },
    baseSpeed: 200,
  };
}

// A standalone, runtime-reset plan entry for a single variation.
function entryFor(key, seed) {
  const s = seed || 1;
  const mod = M.MODIFIERS[key];
  const e = { key, mod, params: mod.roll(M.makeRng(s)), runtime: mod.initRuntime(), introRound: 1 };
  mod.resetRuntime(e.runtime, e.params, e, s, 1);
  return e;
}

test("every variation key has a complete, well-formed definition", () => {
  assert.equal(M.MODIFIER_KEYS.length, 10);
  const phases = ["heading", "speedMul", "speedGate", "offset", "warp"];
  for (const key of M.MODIFIER_KEYS) {
    const mod = M.MODIFIERS[key];
    assert.equal(mod.key, key);
    assert.ok(phases.includes(mod.phase), key + " has an unknown phase");
    for (const fn of ["roll", "apply", "initRuntime", "resetRuntime"]) {
      assert.equal(typeof mod[fn], "function", key + "." + fn + " missing");
    }
  }
});

test("roll yields baseIntensity in (0,1] and only finite numeric params", () => {
  for (const key of M.MODIFIER_KEYS) {
    for (let seed = 1; seed <= 20; seed++) {
      const p = M.MODIFIERS[key].roll(M.makeRng(seed));
      assert.ok(p.baseIntensity > 0 && p.baseIntensity <= 1, key + " baseIntensity out of (0,1]");
      for (const k of Object.keys(p)) {
        assert.ok(Number.isFinite(p[k]), key + "." + k + " is not finite");
      }
    }
  }
});

test("each variation keeps the context finite over a long peak-intensity run", () => {
  for (const key of M.MODIFIER_KEYS) {
    const e = entryFor(key, 3);
    const ctx = freshCtx();
    const eff = e.params.baseIntensity * M.roundRamp(10); // round-10 peak
    for (let f = 0; f < 600; f++) {
      ctx.heading = 0.5;
      ctx.speed = 200;
      ctx.posDX = 0;
      ctx.posDY = 0;
      e.mod.apply(ctx, e.params, e.runtime, 1 / 60, eff);
      assert.ok(Number.isFinite(ctx.heading), key + " heading non-finite at frame " + f);
      assert.ok(Number.isFinite(ctx.speed), key + " speed non-finite at frame " + f);
      assert.ok(Number.isFinite(ctx.posDX) && Number.isFinite(ctx.posDY),
        key + " offset non-finite at frame " + f);
    }
  }
});

test("speed variations (pulse, stutter) never drive speed negative", () => {
  for (const key of ["pulse", "stutter"]) {
    const e = entryFor(key, 8);
    const ctx = freshCtx();
    for (let f = 0; f < 600; f++) {
      ctx.speed = 200;
      e.mod.apply(ctx, e.params, e.runtime, 1 / 60, 2.0);
      assert.ok(ctx.speed >= 0, key + " produced negative speed " + ctx.speed);
    }
  }
});

test("stutter never freezes longer than its own freeze window", () => {
  const e = entryFor("stutter", 6);
  const ctx = freshCtx();
  let frozen = 0;
  let maxFrozen = 0;
  for (let f = 0; f < 1800; f++) {
    ctx.speed = 200;
    e.mod.apply(ctx, e.params, e.runtime, 1 / 60, 1.5);
    if (ctx.speed < 200 * 0.4) frozen++;
    else frozen = 0;
    maxFrozen = Math.max(maxFrozen, frozen);
  }
  const cap = Math.ceil(e.params.freezeTime * 60) + 2;
  assert.ok(maxFrozen <= cap, "stutter froze " + maxFrozen + " frames (cap " + cap + ")");
});

test("swerve keeps its heading offset hard-clamped to +/-1.2 rad", () => {
  const e = entryFor("swerve", 4);
  const ctx = freshCtx();
  for (let f = 0; f < 1200; f++) {
    e.mod.apply(ctx, e.params, e.runtime, 1 / 60, 2.0);
    assert.ok(e.runtime.offset >= -1.2 && e.runtime.offset <= 1.2,
      "swerve offset " + e.runtime.offset + " escaped the clamp");
  }
});

test("warp stays dormant outside the playing state", () => {
  const e = entryFor("warp", 11);
  const ctx = freshCtx();
  ctx.state = "roundEnd";
  for (let f = 0; f < 1200; f++) {
    e.mod.apply(ctx, e.params, e.runtime, 1 / 60, 1);
  }
  assert.equal(ctx.warped, false, "warp must not teleport during a celebration");
});

test("warp eventually teleports while playing", () => {
  const e = entryFor("warp", 11);
  const ctx = freshCtx();
  let fired = false;
  for (let f = 0; f < 2400 && !fired; f++) {
    ctx.warped = false;
    e.mod.apply(ctx, e.params, e.runtime, 1 / 60, 1);
    if (ctx.warped) fired = true;
  }
  assert.ok(fired, "warp should blink at least once within 40s of play");
});

test("warp destinations always land inside the arena bounds", () => {
  const e = entryFor("warp", 11);
  const ctx = freshCtx();
  let checked = 0;
  for (let f = 0; f < 6000; f++) {
    ctx.warped = false;
    e.mod.apply(ctx, e.params, e.runtime, 1 / 60, 1);
    if (ctx.warped) {
      checked++;
      assert.ok(ctx.warpX >= 0 && ctx.warpX <= ctx.view.w - ctx.hexy.w,
        "warpX " + ctx.warpX + " out of bounds");
      assert.ok(ctx.warpY >= 0 && ctx.warpY <= ctx.view.h - ctx.hexy.h,
        "warpY " + ctx.warpY + " out of bounds");
    }
  }
  assert.ok(checked > 0, "expected at least one warp to verify");
});

test("reduced-motion routing: jitter/swerve disable, sharp ones substitute, gentle ones damp", () => {
  assert.equal(M.MODIFIERS.jitter.rmDisable, true);
  assert.equal(M.MODIFIERS.swerve.rmDisable, true);
  for (const key of ["zigzag", "stutter", "warp"]) {
    assert.equal(typeof M.MODIFIERS[key].rmApply, "function", key + " should substitute");
  }
  for (const key of ["drift", "pulse", "spiral", "orbit"]) {
    assert.equal(typeof M.MODIFIERS[key].rmDamp, "number", key + " should declare a damp factor");
    assert.ok(M.MODIFIERS[key].rmDamp < 1, key + " damp factor should reduce intensity");
  }
});

test("jitter displacement per second is frame-rate independent", () => {
  function totalJitter(dtStep, steps) {
    const e = entryFor("jitter", 5);
    const ctx = freshCtx();
    let total = 0;
    for (let f = 0; f < steps; f++) {
      ctx.posDX = 0;
      ctx.posDY = 0;
      e.mod.apply(ctx, e.params, e.runtime, dtStep, 1.0);
      total += Math.abs(ctx.posDX) + Math.abs(ctx.posDY);
    }
    return total;
  }
  // Four simulated seconds at 60Hz vs 144Hz must move Hexy the same distance.
  const at60 = totalJitter(1 / 60, 240);
  const at144 = totalJitter(1 / 144, 576);
  assert.ok(Math.abs(at60 - at144) / at60 < 0.2,
    "jitter total at 60fps (" + at60.toFixed(0) + ") and 144fps (" +
    at144.toFixed(0) + ") should match -- displacement must be dt-normalized");
});

test("spiral accumulates heading rotation, not a fixed tilt", () => {
  const e = entryFor("spiral", 2);
  const ctx = freshCtx();
  const offsets = [];
  for (let block = 0; block < 3; block++) {
    for (let f = 0; f < 60; f++) {
      ctx.heading = 0; // game.js rebuilds heading from base velocity each frame
      e.mod.apply(ctx, e.params, e.runtime, 1 / 60, 1.0);
    }
    offsets.push(Math.abs(ctx.heading));
  }
  assert.ok(offsets[1] > offsets[0] * 1.6 && offsets[2] > offsets[1] * 1.3,
    "spiral heading offset must grow each second: " +
    offsets.map((o) => o.toFixed(2)).join(", "));
});

test("orbit absorbs a viewport resize without a position jump", () => {
  const e = entryFor("orbit", 3);
  const ctx = freshCtx();
  let typical = 0;
  for (let f = 0; f < 40; f++) {
    ctx.posDX = 0;
    ctx.posDY = 0;
    e.mod.apply(ctx, e.params, e.runtime, 1 / 60, 1.0);
    typical = Math.hypot(ctx.posDX, ctx.posDY);
  }
  ctx.view = { w: 1280, h: 960 }; // 1.6x larger mid-run
  ctx.posDX = 0;
  ctx.posDY = 0;
  e.mod.apply(ctx, e.params, e.runtime, 1 / 60, 1.0);
  const resizeFrame = Math.hypot(ctx.posDX, ctx.posDY);
  assert.ok(resizeFrame < typical * 4 + 3,
    "orbit resize-frame delta (" + resizeFrame.toFixed(1) +
    ") should stay near a normal frame (" + typical.toFixed(1) +
    ") -- the view-size change must be rescaled away");
});

test("roundRamp escalates monotonically from a gentle round 1 to a brutal round 10", () => {
  let prev = -1;
  for (let r = 1; r <= 10; r++) {
    const v = M.roundRamp(r);
    assert.ok(v > prev, "roundRamp must increase every round (round " + r + ")");
    prev = v;
  }
  assert.ok(M.roundRamp(1) < 0.25, "round 1 should be gentle: " + M.roundRamp(1).toFixed(2));
  assert.ok(M.roundRamp(10) >= M.roundRamp(1) * 5, "round 10 should dwarf round 1");
  assert.equal(M.roundRamp(0), M.roundRamp(1), "rounds below 1 clamp to round 1");
  assert.equal(M.roundRamp(99), M.roundRamp(10), "rounds above 10 clamp to round 10");
});

test("warp blinks more often as the difficulty ramp climbs", () => {
  function warpCount(eff) {
    const e = entryFor("warp", 11);
    const ctx = freshCtx();
    let n = 0;
    for (let f = 0; f < 3600; f++) { // 60 simulated seconds
      ctx.warped = false;
      e.mod.apply(ctx, e.params, e.runtime, 1 / 60, eff);
      if (ctx.warped) n++;
    }
    return n;
  }
  const early = warpCount(M.roundRamp(5));
  const late = warpCount(M.roundRamp(10));
  assert.ok(late > early,
    "warp should fire more at round 10 (" + late + ") than round 5 (" + early + ")");
});
