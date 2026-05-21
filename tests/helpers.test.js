"use strict";

// Seeded RNG and math helpers -- the deterministic foundation the variation
// system is built on.

const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../src/js/modifiers.js");

test("makeRng is deterministic for the same seed", () => {
  const a = M.makeRng(42);
  const b = M.makeRng(42);
  for (let i = 0; i < 200; i++) {
    assert.equal(a(), b(), "stream diverged at draw " + i);
  }
});

test("makeRng diverges for different seeds", () => {
  const a = M.makeRng(1);
  const b = M.makeRng(2);
  let collisions = 0;
  for (let i = 0; i < 200; i++) {
    if (a() === b()) collisions++;
  }
  assert.ok(collisions < 3, "distinct seeds produced " + collisions + " identical draws");
});

test("makeRng output stays in [0, 1)", () => {
  const r = M.makeRng(7);
  for (let i = 0; i < 5000; i++) {
    const v = r();
    assert.ok(v >= 0 && v < 1, "value " + v + " out of [0,1)");
  }
});

test("lerp interpolates endpoints and midpoint", () => {
  assert.equal(M.lerp(0, 10, 0), 0);
  assert.equal(M.lerp(0, 10, 1), 10);
  assert.equal(M.lerp(2, 4, 0.5), 3);
});

test("clamp bounds values to the range", () => {
  assert.equal(M.clamp(5, 0, 10), 5);
  assert.equal(M.clamp(-3, 0, 10), 0);
  assert.equal(M.clamp(99, 0, 10), 10);
});

test("shuffle preserves the multiset (is a true permutation)", () => {
  const src = ["a", "b", "c", "d", "e"];
  const out = M.shuffle(src, M.makeRng(99));
  assert.equal(out.length, src.length);
  assert.deepEqual([...out].sort(), [...src].sort());
});

test("shuffle does not mutate its input array", () => {
  const src = ["a", "b", "c"];
  M.shuffle(src, M.makeRng(1));
  assert.deepEqual(src, ["a", "b", "c"]);
});

test("shuffle is deterministic per seed and actually reorders", () => {
  const src = ["a", "b", "c", "d", "e", "f"];
  assert.deepEqual(M.shuffle(src, M.makeRng(5)), M.shuffle(src, M.makeRng(5)));
  let reordered = false;
  for (let seed = 0; seed < 20 && !reordered; seed++) {
    if (M.shuffle(src, M.makeRng(seed)).join("") !== src.join("")) reordered = true;
  }
  assert.ok(reordered, "shuffle never reordered across 20 seeds");
});

test("wallMargin is full mid-arena and fades toward a wall", () => {
  const view = { w: 800, h: 600 };
  assert.equal(M.wallMargin({ x: 350, y: 250, w: 100, h: 120 }, view), 1);
  const cornered = M.wallMargin({ x: 0, y: 0, w: 100, h: 120 }, view);
  assert.ok(cornered < 1, "cornered margin should fade below 1");
  assert.ok(cornered >= 0.2, "margin should never drop below the 0.2 floor");
});
