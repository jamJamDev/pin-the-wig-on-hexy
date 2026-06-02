"use strict";

// The slot-machine finale in isolation: the constants/paytable are well-formed,
// the payline catalog is a fixed set of distinct lines, the evaluator scores only
// COMPLETE lines (no partial runs), the credit/bet state machine guards every
// edge, a fixed seed reproduces an identical sequence, the slot bonus is bounded,
// and -- the headline -- the rig delivers a ~60% net-win frequency with a tiny
// configured house edge, while what the reels show always equals what's paid.

const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../src/js/slots.js");

// A 5x5 grid from rows of symbol indices, for driving evaluate() directly.
const grid = (...rows) => rows.map((r) => r.slice());

test("constants and paytable are well-formed", () => {
  assert.equal(S.REELS, 5);
  assert.equal(S.ROWS, 5);
  assert.equal(S.START_CREDITS, 1000);
  assert.equal(S.TARGET_CREDITS, 2000);
  assert.equal(S.WIN_RATE, 0.595);
  assert.equal(S.MAX_LINES, 30);
  // FULL_PAY is one full-line payout per symbol, ascending strictly by rank.
  assert.equal(S.FULL_PAY.length, S.SYMBOLS.length);
  for (const p of S.FULL_PAY) assert.ok(p > 0, "every full-line payout is positive");
  for (let r = 1; r < S.FULL_PAY.length; r++) {
    assert.ok(S.FULL_PAY[r] > S.FULL_PAY[r - 1], "higher-ranked symbols pay strictly more");
  }
  // The top symbol's full line always out-pays a max-line stake, so a single line
  // can always net positive -- the floor the synthesis fallback leans on.
  assert.ok(S.FULL_PAY[S.FULL_PAY.length - 1] > S.MAX_LINES, "the jackpot line beats any stake");
});

test("the payline catalog is MAX_LINES distinct, valid lines; horizontals first", () => {
  const lines = S.buildPaylines();
  assert.equal(lines.length, S.MAX_LINES);
  const seen = new Set();
  for (const line of lines) {
    assert.equal(line.length, S.REELS);
    for (const r of line) assert.ok(r >= 0 && r < S.ROWS && Number.isInteger(r), "row index in [0,ROWS)");
    const key = line.join(",");
    assert.ok(!seen.has(key), "duplicate line " + key);
    seen.add(key);
  }
  // The first five are the straight horizontals, so "bet 1 line" is the top row.
  for (let r = 0; r < S.ROWS; r++) {
    assert.deepEqual(lines[r], [r, r, r, r, r]);
  }
});

test("the catalog has plenty of multi-row 'cross' shapes beyond the horizontals", () => {
  const lines = S.buildPaylines();
  // A line is multi-row if it visits more than one distinct row (i.e. not a flat
  // horizontal). The bulk of the catalog should be these zig-zag/diagonal shapes.
  const multiRow = lines.filter((l) => new Set(l).size > 1);
  assert.ok(multiRow.length >= 20, "expected many cross-row lines, got " + multiRow.length);
  // And several should span 3+ distinct rows -- proper across-the-grid shapes.
  const wide = lines.filter((l) => new Set(l).size >= 3);
  assert.ok(wide.length >= 5, "expected several 3+ row shapes, got " + wide.length);
});

test("evaluate scores full lines only, ignoring partial runs and inactive lines", () => {
  const horiz = (r) => [r, r, r, r, r];
  // A full top row of crowns (symbol 4): pays the full-line value x perLine.
  const g1 = grid(
    [4, 4, 4, 4, 4],
    [0, 1, 2, 3, 0],
    [1, 2, 3, 0, 1],
    [2, 3, 0, 1, 2],
    [3, 0, 1, 2, 3]
  );
  const r1 = S.evaluate(g1, [horiz(0)], 2);
  assert.equal(r1.payout, S.FULL_PAY[4] * 2);
  assert.equal(r1.winningLines.length, 1);
  assert.equal(r1.winningLines[0].count, S.REELS, "a paying line is always the full length");

  // A 4-of-5 run that breaks on the last reel is NOT a full line -> pays nothing.
  const g2 = grid(
    [2, 2, 2, 2, 0],   // wig x4 then break
    [0, 1, 0, 1, 1],
    [1, 0, 3, 0, 2],
    [3, 3, 1, 3, 3],
    [4, 4, 4, 4, 4]    // crown full row, but inactive below
  );
  const r2 = S.evaluate(g2, [horiz(0)], 1);
  assert.equal(r2.payout, 0, "a 4-of-5 partial run does not pay");
  assert.equal(r2.winningLines.length, 0);

  // No full line -> no payout, empty winners.
  const g3 = grid(
    [0, 1, 0, 1, 0],
    [1, 0, 1, 0, 1],
    [0, 1, 0, 1, 0],
    [1, 0, 1, 0, 1],
    [0, 1, 0, 1, 0]
  );
  const r3 = S.evaluate(g3, [horiz(0), horiz(1), horiz(2)], 5);
  assert.equal(r3.payout, 0);
  assert.equal(r3.winningLines.length, 0);

  // Payout is the SUM over winning active full lines; an inactive full row never counts.
  const g4 = grid(
    [0, 0, 0, 0, 0],   // rat full line
    [1, 1, 1, 1, 1],   // fart full line
    [2, 3, 4, 3, 2],
    [3, 4, 2, 4, 3],
    [4, 2, 3, 2, 4]
  );
  const bothActive = S.evaluate(g4, [horiz(0), horiz(1)], 1);
  assert.equal(bothActive.payout, S.FULL_PAY[0] + S.FULL_PAY[1]);
  assert.equal(bothActive.winningLines.length, 2);
  const onlyFirst = S.evaluate(g4, [horiz(0)], 1);   // row 1 inactive
  assert.equal(onlyFirst.payout, S.FULL_PAY[0]);
});

test("a fixed seed reproduces an identical spin sequence", () => {
  function run() {
    const g = S.createGame(424242);
    S.setLines(g, 10);
    S.setBet(g, 0);
    const trace = [];
    for (let i = 0; i < 40 && !S.isComplete(g) && !S.isBust(g); i++) {
      S.spin(g);
      trace.push(g.credits + ":" + g.lastResult.delta + ":" +
        g.grid.map((row) => row.join("")).join("|"));
    }
    return trace.join("/");
  }
  assert.equal(run(), run());
});

test("the bet/spin state machine guards every edge", () => {
  const g = S.createGame(7);
  S.setLines(g, 1);
  S.setBet(g, 0);                         // cost = 1
  assert.equal(S.spinCost(g), 1);

  // setLines/setBet clamp into range.
  S.setLines(g, 999); assert.equal(g.lines, S.MAX_LINES);
  S.setLines(g, -5); assert.equal(g.lines, S.MIN_LINES);
  S.setBet(g, 999); assert.equal(g.betIndex, S.BET_TIERS.length - 1);
  S.setBet(g, -5); assert.equal(g.betIndex, 0);

  // A spin advances spinNum, lands in "result", and moves credits by exactly delta.
  S.setLines(g, 5); S.setBet(g, 0);
  const before = g.credits;
  S.spin(g);
  assert.equal(g.spinNum, 1);
  assert.equal(g.phase, "result");
  assert.equal(g.credits, before + g.lastResult.delta);

  // A stake that would push the bankroll past the debt limit no-ops.
  const broke = S.createGame(7);
  broke.credits = 3;
  S.setLines(broke, S.MAX_LINES); S.setBet(broke, S.BET_TIERS.length - 1);  // cost 750 >> 3+50
  assert.equal(S.canSpin(broke), false, "stake far beyond the debt limit is refused");
  const c = broke.credits, n = broke.spinNum;
  S.spin(broke);
  assert.equal(broke.credits, c, "over-limit spin leaves credits untouched");
  assert.equal(broke.spinNum, n, "over-limit spin does not advance");

  // The minimum spin cost is exactly 1 (one line at the lowest bet).
  const cheap = S.createGame(7);
  S.setLines(cheap, S.MIN_LINES); S.setBet(cheap, 0);
  assert.equal(S.spinCost(cheap), 1, "cost floor is 1");

  // No betting or spinning once the stage has resolved.
  const done = S.createGame(7);
  done.complete = true;
  S.setLines(done, 3); assert.equal(done.lines, S.MAX_LINES, "lines locked after complete");
  done.credits = 2500;
  S.spin(done);
  assert.equal(done.credits, 2500, "no spin after complete");
});

test("debt: stake to -DEBT_LIMIT is allowed, beyond it is refused", () => {
  // canSpin lets the bankroll dip exactly to -DEBT_LIMIT, never past it.
  const g = S.createGame(7);
  g.credits = 0;
  S.setLines(g, 10); S.setBet(g, 2);                 // cost = 10 * 5 = 50 == DEBT_LIMIT
  assert.equal(S.spinCost(g), S.DEBT_LIMIT);
  assert.equal(S.canSpin(g), true, "staking exactly to -DEBT_LIMIT is allowed");

  const over = S.createGame(7);
  over.credits = 0;
  S.setLines(over, 11); S.setBet(over, 2);           // cost = 11 * 5 = 55 > 50
  assert.equal(S.canSpin(over), false, "staking past -DEBT_LIMIT is refused");

  // A cost-1 spin is affordable even from a zero bankroll (dips to -1).
  const floor = S.createGame(7);
  floor.credits = 0;
  S.setLines(floor, 1); S.setBet(floor, 0);
  assert.equal(S.canSpin(floor), true, "the 1-credit spin is always reachable above the limit");
});

test("debt: a spin still in the red after payout busts; a payout that clears it survives", () => {
  // The first spin's win/lose is decided by seed alone (drawn before any grid
  // synthesis), so we can pick seeds for each outcome and stake them into debt.
  function firstSpinSeed(wantWin) {
    for (let s = 1; s < 5000; s++) {
      const g = S.createGame(s);
      S.spin(g);                                     // default 1000 credits, can't go negative here
      if (g.lastResult.win === wantWin) return s;
    }
    throw new Error("no seed produced win=" + wantWin);
  }
  const loseSeed = firstSpinSeed(false);
  const winSeed = firstSpinSeed(true);

  // Lose while staked into debt -> ends in the red -> bust.
  const bust = S.createGame(loseSeed);
  S.setLines(bust, 1); S.setBet(bust, 0);            // cost 1
  bust.credits = 0;                                  // stake dips to -1
  S.spin(bust);
  assert.equal(bust.lastResult.win, false);
  assert.ok(bust.credits < 0, "a lost debt spin ends below zero");
  assert.equal(S.isBust(bust), true, "still in the red after the spin -> bust");

  // Win while staked into debt -> payout clears the overdraft -> survives.
  const saved = S.createGame(winSeed);
  S.setLines(saved, 1); S.setBet(saved, 0);          // cost 1
  saved.credits = 0;                                 // stake dips to -1
  S.spin(saved);
  assert.equal(saved.lastResult.win, true);
  assert.ok(saved.credits >= 0, "a winning debt spin claws back to solvent");
  assert.equal(S.isBust(saved), false, "cleared the debt -> not bust");

  // Sitting at exactly zero is not debt: the run continues, no bust.
  const zero = S.createGame(7);
  zero.credits = 0;
  assert.equal(S.isBust(zero), false, "zero credits is not yet a bust");
});

test("the slot bonus is bounded: 1000 on completion, 0 on bust, in [0,1000] mid-run", () => {
  assert.equal(S.maxScore(), 1000);
  const win = S.createGame(1); win.credits = 2000;
  assert.equal(S.slotBonus(win), 1000);
  const over = S.createGame(1); over.credits = 2600;     // overshoot still caps at 1000
  assert.equal(S.slotBonus(over), 1000);
  const bust = S.createGame(1); bust.credits = 0;
  assert.equal(S.slotBonus(bust), 0);
  const mid = S.createGame(1); mid.credits = 1450;
  assert.equal(S.slotBonus(mid), 450);
  const down = S.createGame(1); down.credits = 600;      // below start banks 0, never negative
  assert.equal(S.slotBonus(down), 0);
});

test("end-to-end: every seed resolves to complete or bust without error", () => {
  // Bet a large affordable chunk each spin so the bankroll walk absorbs quickly;
  // when low, stake everything so a bust is always reachable.
  function affordableBet(g) {
    S.setLines(g, S.MAX_LINES);
    for (let idx = S.BET_TIERS.length - 1; idx >= 0; idx--) {
      if (S.MAX_LINES * S.BET_TIERS[idx] <= g.credits) { S.setBet(g, idx); return; }
    }
    // Can't afford MAX_LINES even at the minimum tier: stake the whole bankroll.
    S.setLines(g, Math.max(S.MIN_LINES, Math.min(S.MAX_LINES, g.credits)));
    S.setBet(g, 0);
  }
  for (let seed = 1; seed <= 60; seed++) {
    const g = S.createGame(seed);
    let guard = 0;
    while (!S.isComplete(g) && !S.isBust(g) && guard++ < 5000) {
      affordableBet(g);
      S.spin(g);
      assert.ok(Number.isFinite(g.credits), "seed " + seed + " produced non-finite credits");
      assert.ok(g.credits >= -S.DEBT_LIMIT, "seed " + seed + " breached the debt limit");
      assert.ok(g.lastResult.payout >= 0, "seed " + seed + " negative payout");
    }
    assert.ok(S.isComplete(g) || S.isBust(g), "seed " + seed + " never resolved");
    assert.ok(!(S.isComplete(g) && S.isBust(g)), "seed " + seed + " both complete and bust");
    if (S.isComplete(g)) assert.ok(g.credits >= S.TARGET_CREDITS);
    if (S.isBust(g)) assert.ok(g.credits < 0, "a bust ends in the red");
  }
});

test("display equals payout: wins show winning lines and net positive; losses show none", () => {
  // Many spins from a fresh, never-terminal game (credits topped up so the run
  // never ends) -- every win must net > 0 with a non-empty highlight, every
  // loss must net exactly -cost with no highlight.
  const g = S.createGame(99);
  S.setLines(g, 10);
  S.setBet(g, 0);
  const cost = S.spinCost(g);
  for (let i = 0; i < 4000; i++) {
    g.credits = 1000;                  // keep it mid-run so spins never no-op
    g.complete = false; g.bust = false;
    S.spin(g);
    const lr = g.lastResult;
    if (lr.win) {
      assert.ok(lr.delta > 0, "a win must net positive, got " + lr.delta);
      assert.ok(lr.winningLines.length >= 1, "a win must highlight a line");
      assert.equal(lr.payout, lr.delta + cost);
      // The credited payout equals the sum of highlighted line wins (what's shown).
      const shown = lr.winningLines.reduce((s, w) => s + w.lineWin, 0);
      assert.equal(shown, lr.payout, "highlighted lines must sum to the credited payout");
    } else {
      assert.equal(lr.payout, 0, "a loss pays nothing");
      assert.equal(lr.delta, -cost, "a loss costs exactly the stake");
      assert.equal(lr.winningLines.length, 0, "a loss highlights nothing");
    }
  }
});

test("wins land on lines of every shape (not just horizontals) and reels never repeat", () => {
  // A winning grid plants its run(s) on random ACTIVE lines of ANY shape, so over
  // many wins the highlighted lines range well beyond the five straight rows
  // (catalog indices 0..4). And every grid -- win or loss -- is permutation reels,
  // so no reel ever stacks the same symbol. This guards both user-visible fixes.
  const g = S.createGame(7);
  S.setLines(g, S.MAX_LINES);          // all 30 lines active -> mostly fancy shapes
  S.setBet(g, 0);
  const winningIndices = {};
  let wins = 0;
  for (let i = 0; i < 4000 && wins < 600; i++) {
    g.credits = 1000;                  // keep it mid-run so spins never no-op
    g.complete = false; g.bust = false;
    S.spin(g);
    const lr = g.lastResult;
    assertReelsRepeatFree(g.grid, "spin " + i);
    if (lr.win) {
      wins++;
      assert.ok(lr.winningLines.length >= 1 && lr.winningLines.length <= S.MAX_WIN_LINES,
        "a win pays 1.." + S.MAX_WIN_LINES + " lines, got " + lr.winningLines.length);
      for (const w of lr.winningLines) winningIndices[w.lineIndex] = true;
    }
  }
  const indices = Object.keys(winningIndices).map(Number);
  const fancyWins = indices.filter((idx) => idx >= S.ROWS);   // non-horizontal lines
  assert.ok(wins > 100, "expected plenty of wins to sample, got " + wins);
  assert.ok(fancyWins.length >= 5,
    "wins should land on many non-horizontal shapes, got line indices " + indices.join(","));
  assert.ok(indices.length >= 10,
    "wins should spread across many distinct lines, got " + indices.length);
});

test("true multi-line: a single spin can pay several lines, and they stack to the total", () => {
  // A win's payout can be split across distinct-symbol runs planted on several
  // active lines at once. With the current single-line-heavy tuning the DEFAULT
  // 30-line board pays mostly single crown lines (a win only has to clear a
  // 30-unit stake, and crown is the lone single line that does), so the multi-line
  // payout shows up at mid bet sizes, where the net-win target spans 2-3 line
  // spreads. On a 10-line board: multi-line wins recur, peak at MAX_WIN_LINES,
  // stay distinct, and stack to exactly the credited payout.
  const g = S.createGame(31);
  S.setLines(g, 10);
  S.setBet(g, 0);
  let wins = 0, multi = 0, peak = 0;
  for (let i = 0; i < 8000 && wins < 1500; i++) {
    g.credits = 1000;
    g.complete = false; g.bust = false;
    S.spin(g);
    const lr = g.lastResult;
    if (!lr.win) continue;
    wins++;
    const wl = lr.winningLines;
    peak = Math.max(peak, wl.length);
    if (wl.length >= 2) multi++;
    assert.ok(wl.length <= S.MAX_WIN_LINES, "a win pays at most " + S.MAX_WIN_LINES + " lines");
    // Every paying line is a distinct line, and the line wins stack to the payout.
    const lineSet = new Set(wl.map((w) => w.lineIndex));
    assert.equal(lineSet.size, wl.length, "winning lines are distinct");
    const sum = wl.reduce((s, w) => s + w.lineWin, 0);
    assert.equal(sum, lr.payout, "stacked line wins must equal the credited payout");
  }
  assert.ok(wins > 200, "expected plenty of wins, got " + wins);
  assert.ok(multi >= wins * 0.1,
    "multi-line wins must recur, got " + multi + "/" + wins);
  assert.ok(peak >= 3, "the busiest wins should light up 3+ lines, peak was " + peak);
});

test("a synthesized losing grid never pays on any line, for any seed", () => {
  // The behavioral contract: a "loss" forms no left-anchored run on the FULL
  // catalog at the maximum per-line bet -- a leak here would mean a loss silently
  // credited the player. The grid is also a set of permutation reels, so confirm
  // every reel is repeat-free (no "solid column" tell).
  const allLines = S.buildPaylines();
  for (let seed = 1; seed <= 500; seed++) {
    const rng = S.makeRng(seed);
    const grid = S.synthesizeLosingGrid(rng);
    const res = S.evaluate(grid, allLines, 25);
    assert.equal(res.payout, 0, "losing grid paid " + res.payout + " at seed " + seed);
    assert.equal(res.winningLines.length, 0, "losing grid highlighted a line at seed " + seed);
    assertReelsRepeatFree(grid, "losing grid at seed " + seed);
  }
});

// Every reel (column) shows distinct symbols -- no symbol stacked within a reel.
function assertReelsRepeatFree(grid, label) {
  for (let col = 0; col < S.REELS; col++) {
    const seen = {};
    for (let row = 0; row < S.ROWS; row++) {
      const sym = grid[row][col];
      assert.ok(!seen[sym], label + ": reel " + col + " repeats symbol " + sym);
      seen[sym] = true;
    }
  }
}

test("THE RIG: ~60% net-win frequency and the configured house edge over many spins", () => {
  // Deterministic Monte Carlo: independent spins (credits reset so an early
  // bust never truncates the sample), tallying win frequency and mean delta.
  const N = 50000;
  const g = S.createGame(1);
  S.setLines(g, 10);
  S.setBet(g, 0);
  const cost = S.spinCost(g);
  let wins = 0;
  let totalDelta = 0;
  for (let i = 0; i < N; i++) {
    g.credits = 1000;
    g.complete = false; g.bust = false;
    g.seed = (i * 2654435761 + 1) >>> 0;   // step the seed so spins are independent
    g.spinNum = 0;
    S.spin(g);
    if (g.lastResult.win) wins++;
    totalDelta += g.lastResult.delta;
  }
  const freq = wins / N;
  const meanDelta = totalDelta / N;
  assert.ok(Math.abs(freq - S.WIN_RATE) < 0.01,
    "net-win frequency " + freq.toFixed(4) + " should be ~" + S.WIN_RATE);
  // Mean delta tracks the configured edge: EDGE*cost. The edge is deliberately
  // tiny here (a slow drain), so assert closeness to EDGE*cost rather than a sign
  // -- that still catches a drifted OR ceiling-capped edge without going flaky on
  // the small magnitude.
  const expectedDelta = S.EDGE * cost;
  assert.ok(Math.abs(meanDelta - expectedDelta) < 0.03 * cost,
    "mean credit delta " + meanDelta.toFixed(4) + " should track EDGE*cost = "
      + expectedDelta.toFixed(4) + " (EDGE=" + S.EDGE + ")");
});

test("requiredMeanNet matches the EV identity for the configured knobs", () => {
  // E[netWin] = ((1-WIN_RATE)+EDGE)/WIN_RATE, in multiples of cost.
  const expected = ((1 - S.WIN_RATE) + S.EDGE) / S.WIN_RATE;
  assert.ok(Math.abs(S.requiredMeanNet() - expected) < 1e-12);
  // Every achievable full-line spread total (sum over any non-empty symbol subset).
  const achievable = new Set();
  for (let mask = 1; mask < (1 << S.SYMBOLS.length); mask++) {
    let v = 0;
    for (let b = 0; b < S.SYMBOLS.length; b++) if (mask & (1 << b)) v += S.FULL_PAY[b];
    achievable.add(v);
  }
  // drawWinUnits always returns a net-positive total that some real spread can pay.
  const rng = S.makeRng(12345);
  for (let i = 0; i < 200; i++) {
    const v = S.drawWinUnits(rng, 10);
    assert.ok(v > 10, "a win must exceed the 10-line stake, got " + v);
    assert.ok(achievable.has(v), "v=" + v + " must be an achievable full-line spread total");
  }
});
