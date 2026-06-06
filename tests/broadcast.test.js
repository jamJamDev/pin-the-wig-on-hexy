"use strict";

// broadcast.js -- pure logic for the operator broadcast overlay: message
// shaping (mirrors scripts/broadcast_store.py) and the poll-to-overlay decision.

const test = require("node:test");
const assert = require("node:assert/strict");
const BC = require("../src/js/broadcast.js");

test("sanitizeMessage trims and collapses whitespace", () => {
  assert.equal(BC.sanitizeMessage("  hello   world  "), "hello world");
});

test("sanitizeMessage turns control chars (newline, tab, escape) into spaces, then collapses", () => {
  // ESC built from its code point so no raw control byte lives in the source.
  const input = "a\n\tb" + String.fromCharCode(27) + "c"; // a <nl> <tab> b <esc> c
  assert.equal(BC.sanitizeMessage(input), "a b c");
});

test("sanitizeMessage returns empty for blank or null", () => {
  assert.equal(BC.sanitizeMessage(""), "");
  assert.equal(BC.sanitizeMessage("  \n\t "), "");
  assert.equal(BC.sanitizeMessage(null), "");
});

test("sanitizeMessage caps at MAX_LEN", () => {
  assert.equal(BC.sanitizeMessage("x".repeat(BC.MAX_LEN + 50)).length, BC.MAX_LEN);
});

test("decide shows a new active message and reports it as new", () => {
  const v = BC.decide(-1, { seq: 1, text: "wake up", remaining_ms: 10000 });
  assert.equal(v.visible, true);
  assert.equal(v.isNew, true);
  assert.equal(v.seq, 1);
  assert.equal(v.text, "wake up");
  assert.equal(v.displayMs, 10000);
});

test("decide treats the same seq as not new (already showing it)", () => {
  const v = BC.decide(3, { seq: 3, text: "still up", remaining_ms: 4000 });
  assert.equal(v.visible, true);
  assert.equal(v.isNew, false);
});

test("decide hides when the slot is empty (cleared or expired)", () => {
  const v = BC.decide(1, { seq: 2, text: "", remaining_ms: 0 });
  assert.equal(v.visible, false);
  assert.equal(v.isNew, true); // seq advanced past what we last showed
  assert.equal(v.seq, 2);
  assert.equal(v.displayMs, 0);
});

test("decide clamps a near-expired message up to MIN_DISPLAY_MS", () => {
  const v = BC.decide(-1, { seq: 5, text: "late", remaining_ms: 100 });
  assert.equal(v.displayMs, BC.MIN_DISPLAY_MS);
});

test("decide re-sanitizes payload text defensively", () => {
  const v = BC.decide(-1, { seq: 1, text: "  spaced\nout  ", remaining_ms: 9000 });
  assert.equal(v.text, "spaced out");
});

test("decide is safe on a malformed payload", () => {
  const v = BC.decide(0, {});
  assert.equal(v.visible, false);
  assert.equal(v.seq, 0);
  assert.equal(v.isNew, false);
});

test("pollDelay returns the base interval when healthy", () => {
  assert.equal(BC.pollDelay(0), BC.POLL_MS);
  assert.equal(BC.pollDelay(undefined), BC.POLL_MS);
  assert.equal(BC.pollDelay(-3), BC.POLL_MS);
});

test("pollDelay backs off exponentially while failing", () => {
  assert.equal(BC.pollDelay(1), BC.POLL_MS * 2);
  assert.equal(BC.pollDelay(2), BC.POLL_MS * 4);
  assert.equal(BC.pollDelay(3), BC.POLL_MS * 8);
});

test("pollDelay caps the backoff at BACKOFF_MAX_MS", () => {
  assert.equal(BC.pollDelay(99), BC.BACKOFF_MAX_MS);
  assert.ok(BC.pollDelay(4) <= BC.BACKOFF_MAX_MS);
});
