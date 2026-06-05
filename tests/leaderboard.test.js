"use strict";

// leaderboard.js -- pure ranking rules for the top-100 board: initials
// sanitizing, score-desc / time-asc ordering, qualification, and capped insert.

const test = require("node:test");
const assert = require("node:assert/strict");
const LB = require("../src/js/leaderboard.js");

const E = (initials, score, ts) => ({ initials, score, ts, god: false });

test("sanitizeInitials keeps up to three A-Z, uppercased", () => {
  assert.equal(LB.sanitizeInitials("abc"), "ABC");
  assert.equal(LB.sanitizeInitials("a1b2c3d4"), "ABC"); // strips digits, caps at 3
  assert.equal(LB.sanitizeInitials("  zz "), "ZZ");
  assert.equal(LB.sanitizeInitials("!@#"), "");
  assert.equal(LB.sanitizeInitials(null), "");
  assert.equal(LB.sanitizeInitials("héx"), "HX"); // non-ASCII letters dropped
});

test("validInitials requires exactly three letters", () => {
  assert.ok(LB.validInitials("ABC"));
  assert.ok(LB.validInitials("ab1c")); // sanitizes to ABC
  assert.ok(!LB.validInitials("AB"));
  assert.ok(!LB.validInitials(""));
});

test("sortEntries orders by score desc then ts asc, without mutating input", () => {
  const input = [E("AAA", 100, 5), E("BBB", 300, 9), E("CCC", 300, 2)];
  const sorted = LB.sortEntries(input);
  assert.deepEqual(sorted.map((e) => e.initials), ["CCC", "BBB", "AAA"]); // 300@2 before 300@9
  // input untouched
  assert.deepEqual(input.map((e) => e.initials), ["AAA", "BBB", "CCC"]);
});

test("rankOf places a new run, with ties landing below incumbents", () => {
  const board = [E("AAA", 500, 1), E("BBB", 300, 2), E("CCC", 100, 3)];
  assert.equal(LB.rankOf(board, 600), 1); // beats all
  assert.equal(LB.rankOf(board, 400), 2); // between 500 and 300
  assert.equal(LB.rankOf(board, 300), 3); // ties BBB -> ranks just below it
  assert.equal(LB.rankOf(board, 50), 4);  // last
  assert.equal(LB.rankOf([], 10), 1);     // empty board
});

test("qualifies: positive score, room or beats the lowest, no bottom-tie bump", () => {
  const full = [];
  for (let i = 0; i < LB.MAX_ENTRIES; i++) full.push(E("XXX", 1000 - i, i)); // scores 1000..901
  assert.ok(LB.qualifies(full, 950, LB.MAX_ENTRIES));  // beats the lowest (901)
  assert.ok(!LB.qualifies(full, 901, LB.MAX_ENTRIES)); // ties the lowest -> no bump
  assert.ok(!LB.qualifies(full, 500, LB.MAX_ENTRIES)); // below the board
  assert.ok(LB.qualifies([], 1));                      // any positive on an empty board
  assert.ok(!LB.qualifies([], 0));                     // zero is not a real result
  assert.ok(!LB.qualifies([], -5));
  assert.ok(!LB.qualifies([], Infinity));              // non-finite rejected
});

test("insert returns a new sorted board capped to max", () => {
  const board = [E("AAA", 500, 1), E("BBB", 100, 2)];
  const next = LB.insert(board, E("CCC", 300, 3), 100);
  assert.deepEqual(next.map((e) => e.initials), ["AAA", "CCC", "BBB"]);
  assert.equal(board.length, 2); // original not mutated

  // cap drops the lowest
  const capped = LB.insert([E("AAA", 9, 1), E("BBB", 8, 2)], E("CCC", 5, 3), 2);
  assert.equal(capped.length, 2);
  assert.deepEqual(capped.map((e) => e.initials), ["AAA", "BBB"]);
});

// Distinct 3-letter initials for an index, so a full board has one row per name.
const NAME = (i) =>
  "A" + String.fromCharCode(65 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26));

test("findByInitials returns the standing row for a name, or null", () => {
  const board = [E("AAA", 500, 1), E("BBB", 300, 2)];
  assert.equal(LB.findByInitials(board, "BBB").score, 300);
  assert.equal(LB.findByInitials(board, "ZZZ"), null);
  assert.equal(LB.findByInitials(board, ""), null);   // empty never matches
  assert.equal(LB.findByInitials(board, null), null);
});

test("upsertByInitials keeps one row per name at its best score", () => {
  let board = [E("AAA", 500, 1)];
  // higher score replaces the standing row -> still one row
  board = LB.upsertByInitials(board, E("AAA", 800, 2), 100);
  assert.equal(board.length, 1);
  assert.equal(board[0].score, 800);
  // lower score leaves the best untouched
  board = LB.upsertByInitials(board, E("AAA", 300, 3), 100);
  assert.equal(board.length, 1);
  assert.equal(board[0].score, 800);
  // a different name adds its own row
  board = LB.upsertByInitials(board, E("BBB", 100, 4), 100);
  assert.equal(board.length, 2);
});

test("qualifiesForInitials: beat your own best, and land within the cap", () => {
  const board = [E("AAA", 500, 1), E("BBB", 300, 2)];
  assert.ok(LB.qualifiesForInitials(board, 900, "AAA", 100));  // new personal best
  assert.ok(!LB.qualifiesForInitials(board, 400, "AAA", 100)); // below own 500 -> no
  assert.ok(!LB.qualifiesForInitials(board, 500, "AAA", 100)); // ties own best -> no
  assert.ok(LB.qualifiesForInitials(board, 50, "ZZZ", 100));   // new name, room on board
  // full board: a newcomer must beat the lowest; the name's own stale row is set aside
  const full = [];
  for (let i = 0; i < LB.MAX_ENTRIES; i++) full.push(E(NAME(i), 1000 - i, i)); // 1000..901
  assert.ok(!LB.qualifiesForInitials(full, 800, "NEW", LB.MAX_ENTRIES)); // below the floor
  assert.ok(LB.qualifiesForInitials(full, 1500, NAME(50), LB.MAX_ENTRIES)); // own row ignored, tops all
});

// Submission signing must match the Python server byte-for-byte, or every real
// POST is rejected. The vector below is mirrored in tests/test_submission_token.py.
const SUB = require("../src/js/submission.js");

test("submission signing matches the shared cross-language vector", async () => {
  const fields = {
    initials: "ABC", score: 12345, god: true,
    nonce: "00112233445566778899aabbccddeeff", ts: 1700000000000,
    owner: "owner-token-fixed-0001",
  };
  const sig = await SUB.sign(fields);
  assert.equal(sig, "60a7b02b1cf63a97ddafc6d22c9d2e5c0991ca7cd15b883974f816e1867a514c");
  // flipping any signed field changes the signature
  const flipped = await SUB.sign(Object.assign({}, fields, { score: 12346 }));
  assert.notEqual(flipped, sig);
});

test("newNonce yields distinct hex tokens", () => {
  const a = SUB.newNonce();
  const b = SUB.newNonce();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b);
});
