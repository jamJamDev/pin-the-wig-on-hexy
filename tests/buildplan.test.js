"use strict";

// buildPlan / resetPlanForRound -- the per-game variation plan: a permutation
// of all 10 variations across the 10 rounds, frozen by seed.

const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../src/js/modifiers.js");

test("buildPlan produces exactly 10 entries in intro-round order", () => {
  const plan = M.buildPlan(12345);
  assert.equal(plan.length, 10);
  plan.forEach((e, i) => assert.equal(e.introRound, i + 1));
});

test("buildPlan uses each of the 10 variations exactly once", () => {
  const keys = M.buildPlan(777).map((e) => e.key).sort();
  assert.deepEqual(keys, [...M.MODIFIER_KEYS].sort());
});

test("buildPlan keeps gentle variations in rounds 1-4, spicy in 5-10", () => {
  for (let seed = 1; seed <= 30; seed++) {
    const plan = M.buildPlan(seed);
    for (let i = 0; i < 4; i++) {
      assert.ok(M.GENTLE_KEYS.includes(plan[i].key),
        "seed " + seed + ": round " + (i + 1) + " (" + plan[i].key + ") should be gentle");
    }
    for (let i = 4; i < 10; i++) {
      assert.ok(M.SPICY_KEYS.includes(plan[i].key),
        "seed " + seed + ": round " + (i + 1) + " (" + plan[i].key + ") should be spicy");
    }
  }
});

test("buildPlan is fully deterministic for a seed (order and params)", () => {
  const a = M.buildPlan(2024);
  const b = M.buildPlan(2024);
  assert.deepEqual(a.map((e) => e.key), b.map((e) => e.key));
  assert.deepEqual(a.map((e) => e.params), b.map((e) => e.params));
});

test("buildPlan varies the variation order across seeds", () => {
  const base = M.buildPlan(1).map((e) => e.key).join(",");
  let differs = false;
  for (let seed = 2; seed <= 40 && !differs; seed++) {
    if (M.buildPlan(seed).map((e) => e.key).join(",") !== base) differs = true;
  }
  assert.ok(differs, "no seed in 2..40 produced a different order from seed 1");
});

test("every plan entry carries params, runtime and its live modifier", () => {
  for (const e of M.buildPlan(55)) {
    assert.ok(e.params && typeof e.params.baseIntensity === "number");
    assert.ok(e.params.baseIntensity > 0 && e.params.baseIntensity <= 1,
      e.key + " baseIntensity out of (0,1]");
    assert.equal(typeof e.runtime, "object");
    assert.equal(e.mod, M.MODIFIERS[e.key]);
  }
});

test("resetPlanForRound returns the cumulative active set", () => {
  const plan = M.buildPlan(9);
  assert.equal(M.resetPlanForRound(plan, 1, 9).length, 1);
  assert.equal(M.resetPlanForRound(plan, 5, 9).length, 5);
  assert.equal(M.resetPlanForRound(plan, 10, 9).length, 10);
});

test("resetPlanForRound rearms event-stream runtimes (swerve/jitter/warp)", () => {
  const active = M.resetPlanForRound(M.buildPlan(404), 10, 404);
  for (const e of active) {
    if (e.key === "swerve" || e.key === "jitter" || e.key === "warp") {
      assert.equal(typeof e.runtime.rng, "function", e.key + " runtime.rng not rearmed");
    }
  }
});
