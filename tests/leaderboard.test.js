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

// Per-player rows keyed by an anonymous browser id (client_id).
const C = (initials, score, ts, cid) => ({ initials, score, ts, god: false, client_id: cid });

test("findByClient returns the player's standing row, or null", () => {
  const board = [C("AAA", 500, 1, "c1"), C("BBB", 300, 2, "c2")];
  assert.equal(LB.findByClient(board, "c2").initials, "BBB");
  assert.equal(LB.findByClient(board, "c9"), null);
  assert.equal(LB.findByClient(board, ""), null);   // anonymous never matches
  assert.equal(LB.findByClient(board, null), null);
});

test("upsert keeps one row per client at their best score", () => {
  let board = [C("AAA", 500, 1, "c1")];
  // higher score replaces the standing row -> still one row
  board = LB.upsert(board, C("AAA", 800, 2, "c1"), 100);
  assert.equal(board.length, 1);
  assert.equal(board[0].score, 800);
  // lower score leaves the best untouched
  board = LB.upsert(board, C("AAA", 300, 3, "c1"), 100);
  assert.equal(board.length, 1);
  assert.equal(board[0].score, 800);
  // a different client adds its own row
  board = LB.upsert(board, C("BBB", 100, 4, "c2"), 100);
  assert.equal(board.length, 2);
  // anonymous (no client_id) submissions are each their own row
  let anon = LB.upsert([C("AAA", 100, 1, undefined)], E("AAA", 200, 2), 100);
  assert.equal(anon.length, 2);
});

test("qualifiesForClient: beat your own best, and land within the cap", () => {
  const board = [C("AAA", 500, 1, "c1"), C("BBB", 300, 2, "c2")];
  assert.ok(LB.qualifiesForClient(board, 900, "c1", 100));  // new personal best
  assert.ok(!LB.qualifiesForClient(board, 400, "c1", 100)); // below own 500 -> no
  assert.ok(!LB.qualifiesForClient(board, 500, "c1", 100)); // ties own best -> no
  assert.ok(LB.qualifiesForClient(board, 50, "c9", 100));   // new player, room on board
  // full board: a newcomer must beat the lowest; the player's own stale row is set aside
  const full = [];
  for (let i = 0; i < LB.MAX_ENTRIES; i++) full.push(C("XXX", 1000 - i, i, "f" + i)); // 1000..901
  assert.ok(!LB.qualifiesForClient(full, 800, "new", LB.MAX_ENTRIES)); // below the floor
  assert.ok(LB.qualifiesForClient(full, 1500, "f50", LB.MAX_ENTRIES)); // own row ignored, tops all
});
