/*
 * Pin the Wig on Hexy -- the FINAL leg of the GOD GAMER gauntlet: a 5x5
 * multi-line slot machine. Reaching here means the player beat the True God
 * Gamer at blackjack. Now they must turn 1000 credits into 2000 on a machine
 * rigged so 45% of spins net a win -- the player loses outright more often than
 * they win -- with the expected value per spin tuned just below zero (a slow
 * drain). Bust to 0 and the run ends in failure; reach 2000 and the gauntlet is cleared.
 *
 * Layered on top is a symmetric SPECIAL pair that surfaces on some non-winning
 * spins: Hexy's BARE HEAD (a full line DEDUCTS credits -- the trap) and the GOLDEN
 * WIG (a full line AWARDS the same magnitude -- the jackpot). Equal rate and equal
 * size, so the pair is exactly EV-neutral: it adds drama and a real per-spin swing
 * without moving the tuned win-rate or house edge.
 *
 * The rig is outcome-first AND honest-on-screen: every spin first decides
 * win/lose, then synthesizes a grid that the pure evaluator scores -- and the
 * credited payout is ALWAYS evaluator output, so what the player sees on the
 * reels is exactly what they are paid. Reels are independent permutation strips
 * (each shows all five symbols once -- no repeats). Every paying line is a
 * COMPLETE 5-cell line of a single symbol -- there are no partial 3- or 4-cell
 * wins -- and a win lights up one to MAX_WIN_LINES such full lines at once, each
 * a DISTINCT symbol on its own shape (horizontal, diagonal, chevron, zigzag,
 * W/M). The winning shapes are mutually non-crossing (they never share a cell),
 * which is exactly what lets several full lines of different symbols coexist on
 * permutation reels. A loss forms no full line on any active line. The grid is
 * rejection-sampled so EXACTLY those full lines pay and nothing else. The win
 * total is drawn from a two-point mixture over achievable full-line spread sums
 * whose mean is fixed by WIN_RATE and EDGE, so the 45% win-frequency and the
 * configured house edge hold provably (see tests/).
 *
 * Pure and DOM-free: the payline catalog, grid synthesis, the line evaluator,
 * the rig, and the credit/bet state machine are all verifiable in Node. game.js
 * is the thin shell that renders the reels and wires the buttons.
 *
 * Loaded as a plain script in the browser (sets window.PTWOHSlots) and as a
 * CommonJS module in Node tests -- no build step.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.PTWOHSlots = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var REELS = 5;                 // columns
  var ROWS = 5;                  // rows -> 5x5 grid (grid[row][col])
  var START_CREDITS = 1000;      // bankroll at the deal
  var TARGET_CREDITS = 2000;     // reach this to COMPLETE the stage
  var MAX_LINES = 30;            // size of the payline catalog ("a TON")
  var MIN_LINES = 2;   // floor is 2: one active line forces every win to the >=2x payout floor, overshooting the EV target into a ~+19%/spin grind
  var BET_TIERS = [1, 2, 3, 4, 5];   // discrete bet-per-line values (min cost = MIN_LINES x 1)

  // Playing on credit: a spin may be staked even when the bankroll can't cover
  // it, going as far as DEBT_LIMIT into the red. But debt is never carried -- if
  // the spin resolves still in the red (credits < 0), the run ends. So the only
  // way out of a staked debt is a payout that clears it on the same spin.
  var DEBT_LIMIT = 50;

  // ---- THE RIG: the two knobs that matter ----
  // WIN_RATE   fraction of spins that are a net win for the player -- the headline
  //            knob: 45% of spins pay, so the player loses outright MORE often than
  //            they win and the machine feels stingy. Fewer wins must carry the same
  //            house edge, so each win pays more: the net-win target sits well above
  //            the single-line floor, and the default 30-line board lights up 2-3
  //            line spreads rather than lone lines.
  // EDGE       house edge as EV/cost: 0 = fair (EV~=0), >0 favors the player,
  //            <0 favors the house. Kept deliberately tiny (-0.002, RTP ~99.8%) so
  //            the drain is SLOW -- the bankroll bleeds down gradually rather than
  //            collapsing, and clearing the 1000->2000 stage stays a real (if
  //            sub-even) chance. The 45% win rate, not the edge, is what makes the
  //            machine feel stingy; |EDGE| is what sets how fast it ultimately drains.
  var WIN_RATE = 0.45;
  var EDGE = -0.002;

  // ---- THE SPECIALS: a symmetric bonus/penalty pair layered ON TOP of the stake ----
  // A fraction of NON-win spins surface a single SPECIAL full line instead of a blank
  // loss: half the time Hexy's BARE HEAD (deducts PENALTY per line bet) and half the
  // time the GOLDEN WIG (awards BONUS per line bet). BONUS == PENALTY and the two
  // halves are equally likely, so the pair is exactly EV-neutral -- it "evens out"
  // and leaves both rig knobs above byte-identical: the house EDGE is untouched, and
  // the ~45% net-win frequency (which counts PAYING wins only) is unchanged. The bald
  // deduction is suppressed when a spin already staked into debt, and is capped at
  // PENALTY * max(BET_TIERS) <= DEBT_LIMIT, so a penalty can never breach the debt floor.
  var SPECIAL_LINE_RATE = 0.22;   // share of non-win spins that surface a special line
  var PENALTY = 10;               // a bald full line DEDUCTS this per line bet
  var BONUS = 10;                 // a golden-wig full line AWARDS this per line bet (== PENALTY)

  // Hexy-themed symbols. Indices 0..4 are the PAYING ladder (low -> high value),
  // then the two SPECIAL symbols: index 5 is Hexy's BARE HEAD (a penalty -- a full
  // line DEDUCTS) and index 6 is the GOLDEN WIG (a bonus -- a full line AWARDS the
  // same magnitude, so the pair cancels). Paying symbols render as a glyph; the two
  // specials render as an image (Hexy's bald head / the wig) with a glyph fallback
  // for non-DOM contexts (the roll-blur, tests). `kind` lets the renderer style them.
  var SYMBOLS = [
    { id: "rat",     glyph: "🐀", kind: "pay" },
    { id: "fart",    glyph: "💨", kind: "pay" },
    { id: "wig",     glyph: "💇", kind: "pay" },
    { id: "lips",    glyph: "👄", kind: "pay" },
    { id: "crown",   glyph: "👑", kind: "pay" },
    { id: "bald",    glyph: "🧑‍🦲", img: "assets/bald_no_bg.png", kind: "bald" },
    { id: "jackpot", glyph: "✨", img: "assets/wig.png", kind: "bonus" }
  ];
  var PAY_SYMBOLS = 5;   // indices 0..4 pay; the catalog/spread math is over these only
  var BALD = 5;          // a full bald line DEDUCTS (Hexy's bare head -- the trap)
  var BONUS_SYM = 6;     // a full golden-wig line AWARDS (the jackpot)
  // FULL_PAY[symbolIndex] = payout per line, as a multiple of bet-per-line, for a
  // COMPLETE 5-cell line of that symbol. There are no partial-run payouts -- only
  // a full line pays. Ascending by rank: a rat line barely beats a single-line
  // stake, a crown line is the jackpot. The values are tuned so the win-total
  // ladder (drawWinUnits) brackets the EV target at every line count from 1 to
  // MAX_LINES while keeping wins multi-line on the busy boards (see tests/).
  var FULL_PAY = [2, 3, 7, 18, 50];   // rat, fart, wig, lips, crown

  // ---------- PRNG (mulberry32, matches the other modules) ----------
  function makeRng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // ---------- Payline catalog ----------
  // A payline is one row index per reel column: [r0, r1, r2, r3, r4]. Built once
  // and frozen. The five straight horizontals come FIRST (so the lowest-index
  // lines are the top rows), then diagonals, chevrons, zigzags, and W/M shapes. The
  // catalog is exactly MAX_LINES distinct lines; players bet on the first N.
  function clampRow(r) { return r < 0 ? 0 : (r >= ROWS ? ROWS - 1 : r); }

  function buildPaylines() {
    var lines = [];
    var seen = {};
    function add(line) {
      // Invariant the single-row fallback relies on: among the catalog, ONLY a
      // straight horizontal has reel0 == reel1 (same row on the first two columns),
      // so locking two distinct symbols into cols 0/1 of every other row leaves the
      // planted horizontal the sole payer. Reject any non-horizontal whose first
      // two rows happen to match.
      if (line[0] === line[1] && !(line[1] === line[2] && line[2] === line[3] && line[3] === line[4])) return;
      var key = line.join(",");
      if (!seen[key] && lines.length < MAX_LINES) { seen[key] = true; lines.push(line); }
    }
    var r, b;
    // 1) Five straight horizontals -- the classic first bets.
    for (r = 0; r < ROWS; r++) add([r, r, r, r, r]);
    // 2) Two diagonals.
    add([0, 1, 2, 3, 4]); add([4, 3, 2, 1, 0]);
    // 3) Chevrons (V and inverted-V, shifted).
    add([0, 1, 2, 1, 0]); add([4, 3, 2, 3, 4]);
    add([1, 2, 3, 2, 1]); add([3, 2, 1, 2, 3]);
    // 4) Zigzags: a small sawtooth around each base row.
    for (b = 0; b < ROWS; b++) {
      add([b, clampRow(b + 1), b, clampRow(b + 1), b]);
      add([b, clampRow(b - 1), b, clampRow(b - 1), b]);
    }
    // 5) W / M shapes and staircases to backfill toward MAX_LINES.
    add([0, 2, 0, 2, 0]); add([4, 2, 4, 2, 4]);
    add([0, 0, 2, 4, 4]); add([4, 4, 2, 0, 0]);
    add([2, 1, 0, 1, 2]); add([2, 3, 4, 3, 2]);
    add([0, 2, 4, 2, 0]); add([4, 2, 0, 2, 4]);
    add([1, 0, 1, 0, 1]); add([3, 4, 3, 4, 3]);
    add([1, 3, 1, 3, 1]); add([3, 1, 3, 1, 3]);
    add([0, 1, 0, 1, 0]); add([4, 3, 4, 3, 4]);
    add([2, 0, 2, 0, 2]); add([2, 4, 2, 4, 2]);
    add([1, 2, 1, 2, 1]); add([3, 2, 3, 2, 3]);
    add([0, 3, 0, 3, 0]); add([4, 1, 4, 1, 4]);
    return lines;  // exactly MAX_LINES entries (categories above overflow the cap)
  }

  var PAYLINES = buildPaylines();

  function activeLines(game) { return PAYLINES.slice(0, game.lines); }

  // ---------- Pure line evaluator (the settle() analog) ----------
  // Reads only the grid + bet. A line resolves ONLY when all five cells along it are
  // the same symbol -- a complete line; partial runs (3 or 4 in a row) do nothing. A
  // full PAYING line adds to `payout`; a full GOLDEN-WIG line adds to `bonus`; a full
  // BALD line adds to `penalty` (the amount the player loses). The credited amount a
  // spin applies is payout + bonus - penalty. No RNG, no mutation -- the single source
  // of truth, so display and credit can never disagree. Every resolved line's count is
  // REELS (a full line), kept so the renderer can highlight the whole shape uniformly.
  function evaluate(grid, lineList, perLine) {
    var payout = 0, bonus = 0, penalty = 0;
    var winners = [];
    var specials = [];
    for (var i = 0; i < lineList.length; i++) {
      var line = lineList[i];
      var sym = grid[line[0]][0];
      var full = true;
      for (var c = 1; c < REELS; c++) {
        if (grid[line[c]][c] !== sym) { full = false; break; }
      }
      if (!full) continue;
      if (sym < PAY_SYMBOLS) {
        var lineWin = FULL_PAY[sym] * perLine;
        payout += lineWin;
        winners.push({ line: line, lineIndex: i, symbol: sym, count: REELS, lineWin: lineWin });
      } else if (sym === BONUS_SYM) {
        var award = BONUS * perLine;
        bonus += award;
        specials.push({ line: line, lineIndex: i, symbol: sym, kind: "bonus", count: REELS, amount: award });
      } else {   // BALD -- the penalty line
        var hit = PENALTY * perLine;
        penalty += hit;
        specials.push({ line: line, lineIndex: i, symbol: sym, kind: "bald", count: REELS, amount: hit });
      }
    }
    return { payout: payout, bonus: bonus, penalty: penalty, winningLines: winners, specialLines: specials };
  }

  // ---------- Rig math ----------
  // Mean net win (as a multiple of cost) required so that
  //   E[delta] = WIN_RATE*E[netWin] - (1-WIN_RATE)*cost = EDGE*cost.
  // Solving: E[netWin] = ((1-WIN_RATE)+EDGE)/WIN_RATE  (multiples of cost).
  function requiredMeanNet() {
    return ((1 - WIN_RATE) + EDGE) / WIN_RATE;
  }

  // ---- Full-line spreads ----
  // A win is paid across one or more COMPLETE lines at once. On permutation reels
  // a symbol sits once per column, so two full lines can only coexist if they use
  // DIFFERENT symbols -- hence a "spread" is exactly a non-empty subset of distinct
  // symbols, each owning one full line. FULL_SPREADS enumerates every such subset
  // (as a symbol-index array) with its total value (sum of FULL_PAY) and part count
  // (how many lines light up). 31 in all (the non-empty subsets of five symbols).
  function enumerateFullSpreads() {
    var out = [];
    var n = PAY_SYMBOLS;   // wins are spreads of PAYING symbols only (specials never pay a spread)
    for (var mask = 1; mask < (1 << n); mask++) {
      var syms = [], val = 0;
      for (var b = 0; b < n; b++) {
        if (mask & (1 << b)) { syms.push(b); val += FULL_PAY[b]; }
      }
      out.push({ symbols: syms, value: val, parts: syms.length });
    }
    return out;
  }
  var FULL_SPREADS = enumerateFullSpreads();

  // The distinct achievable spread totals reachable with <= maxParts lines,
  // ascending -- the ladder of payouts the draw can hit at a given line cap.
  function fullSpreadValues(maxParts) {
    var set = {};
    for (var i = 0; i < FULL_SPREADS.length; i++) {
      if (FULL_SPREADS[i].parts <= maxParts) set[FULL_SPREADS[i].value] = true;
    }
    var out = [];
    for (var v in set) { if (set.hasOwnProperty(v)) out.push(parseInt(v, 10)); }
    out.sort(function (a, b) { return a - b; });
    return out;
  }

  // The symbol whose single full line nets positive (pays more than the stake) and
  // sits closest to `units` -- the honest amount the single-line fallback pays when
  // a multi-line spread won't place. Crown (the top symbol) always nets positive
  // since its payout exceeds any line count, so a choice always exists.
  function closestSymbolForUnits(units, lines) {
    var best = -1, bestD = Infinity;
    for (var i = 0; i < FULL_PAY.length; i++) {
      if (FULL_PAY[i] <= lines) continue;
      var d = Math.abs(FULL_PAY[i] - units);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best === -1 ? FULL_PAY.length - 1 : best;
  }

  // Order the spread candidates to try for a win paying exactly `units`: a
  // preferred one first (its line-count is random but weighted toward MORE lines,
  // for a livelier board, every count still reachable), then one representative per
  // remaining line-count from most lines down to a single -- a graceful degradation
  // path when the busier spreads can't be placed cleanly within the try budget.
  // Each candidate is a symbol-index array. Empty pool (units off the ladder, which
  // drawWinUnits never produces) falls back to the lone net-positive symbol.
  function orderedSpreadCandidates(rng, units, maxParts) {
    var byParts = {};
    var ks = [];
    for (var i = 0; i < FULL_SPREADS.length; i++) {
      var sp = FULL_SPREADS[i];
      if (sp.value !== units || sp.parts > maxParts) continue;
      if (!byParts[sp.parts]) { byParts[sp.parts] = []; ks.push(sp.parts); }
      byParts[sp.parts].push(sp.symbols);
    }
    if (ks.length === 0) return [[SYMBOLS.length - 1]];
    ks.sort(function (a, b) { return b - a; });        // most lines first
    var total = 0;
    for (var a = 0; a < ks.length; a++) total += ks[a];
    var pick = rng() * total, chosenK = ks[0];
    for (var b = 0; b < ks.length; b++) { pick -= ks[b]; if (pick < 0) { chosenK = ks[b]; break; } }
    var grp = byParts[chosenK];
    var candidates = [grp[Math.floor(rng() * grp.length) % grp.length]];
    for (var c = 0; c < ks.length; c++) {
      if (ks[c] === chosenK) continue;
      var g2 = byParts[ks[c]];
      candidates.push(g2[Math.floor(rng() * g2.length) % g2.length]);
    }
    return candidates;
  }

  // Draw a winning payout, in bet-per-line units, for a spin betting `lines`
  // lines. The result is an achievable full-line spread total strictly greater
  // than `lines` (so the win always NETS positive), drawn from a two-point mixture
  // of the largest qualifying total at or below the EV target (lo) and the smallest
  // at or above it (hi). E[V] = target exactly, independent of the lo/hi swing,
  // which is what makes the 45% win-frequency and the chosen house edge coexist. The line cap
  // (MAX_WIN_LINES) bounds how many lines a single payout may spread across.
  function drawWinUnits(rng, lines) {
    var maxParts = Math.min(lines, MAX_WIN_LINES);
    var all = fullSpreadValues(maxParts);
    var ladder = [];
    for (var i = 0; i < all.length; i++) {
      if (all[i] > lines) ladder.push(all[i]);
    }
    if (ladder.length === 0) return all[all.length - 1];   // unreachable for lines <= 30
    var lo = ladder[0];
    var hi = ladder[ladder.length - 1];
    var target = lines * (1 + requiredMeanNet());     // mean payout in units
    if (target <= lo) return lo;
    if (target >= hi) return hi;
    for (var a = 0; a < ladder.length; a++) { if (ladder[a] <= target) lo = ladder[a]; }
    for (var b = ladder.length - 1; b >= 0; b--) { if (ladder[b] >= target) hi = ladder[b]; }
    if (hi === lo) return lo;
    var p = (hi - target) / (hi - lo);                // P(lo); E[V] = p*lo+(1-p)*hi = target
    return rng() < p ? lo : hi;
  }

  // ---------- Grid synthesis ----------
  // Reels are drawn as independent strips: each column is a random PERMUTATION of
  // the symbol set, so a reel never shows the same symbol twice (no "solid column"
  // tell). Win/lose is decided first (see spin()); the grid is then synthesized to
  // match -- and the credited payout is ALWAYS the evaluator's reading of that
  // grid, so what the reels show is exactly what the player is paid.
  function blankGrid() {
    var g = [];
    for (var r = 0; r < ROWS; r++) {
      var row = [];
      for (var c = 0; c < REELS; c++) row.push(0);
      g.push(row);
    }
    return g;
  }

  function randSym(rng) { return Math.floor(rng() * SYMBOLS.length) % SYMBOLS.length; }

  // A fresh shuffle of all symbol indices (Fisher-Yates on the per-spin RNG).
  function shuffledSymbols(rng) {
    var a = [];
    for (var i = 0; i < SYMBOLS.length; i++) a.push(i);
    for (var k = a.length - 1; k > 0; k--) {
      var j = Math.floor(rng() * (k + 1)) % (k + 1);
      var t = a[k]; a[k] = a[j]; a[j] = t;
    }
    return a;
  }

  // A grid whose every column is an independent permutation of all symbols --
  // each reel shows all five symbols exactly once, in random order (repeat-free).
  function permColumnsGrid(rng) {
    var grid = blankGrid();
    for (var c = 0; c < REELS; c++) {
      var col = shuffledSymbols(rng);     // col[row] = symbol at (row, c)
      for (var r = 0; r < ROWS; r++) grid[r][c] = col[r];
    }
    return grid;
  }

  var SYNTH_TRIES = 200;
  var MAX_WIN_LINES = 3;     // a single spin pays on at most this many full lines

  // A losing grid: permutation reels with NO paying line on the whole catalog.
  // Found by rejection (cheap -- a few draws on average), so the reels stay
  // repeat-free; the guaranteed-no-pay fallback covers the astronomically rare miss.
  function synthesizeLosingGrid(rng) {
    for (var t = 0; t < SYNTH_TRIES; t++) {
      var grid = permColumnsGrid(rng);
      var ev = evaluate(grid, PAYLINES, 1);
      // No paying line AND no special line: a plain loss neither pays, awards, nor
      // deducts -- the stake is simply gone.
      if (ev.payout === 0 && ev.bonus === 0 && ev.penalty === 0) return grid;
    }
    return fallbackLosingGrid(rng);
  }

  // Two lines "cross" when they share a cell -- the same row on some column. Two
  // crossing lines cannot both be full lines of DIFFERENT symbols (the shared cell
  // can hold only one symbol), so a multi-line win must be laid on mutually
  // non-crossing shapes.
  function linesCross(a, b) {
    for (var c = 0; c < REELS; c++) if (a[c] === b[c]) return true;
    return false;
  }

  // Pick `k` pairwise non-crossing active line indexes, greedily over a shuffled
  // order. Returns fewer than `k` only when the shuffle's greedy walk can't reach
  // `k` (rare -- the straight horizontals are always mutually non-crossing, so a
  // valid set exists whenever active >= k); the caller simply retries.
  function pickNonCrossingLines(rng, active, k) {
    var order = [];
    for (var i = 0; i < active; i++) order.push(i);
    for (var s = order.length - 1; s > 0; s--) {
      var j = Math.floor(rng() * (s + 1)) % (s + 1);
      var t = order[s]; order[s] = order[j]; order[j] = t;
    }
    var chosen = [];
    for (var o = 0; o < order.length && chosen.length < k; o++) {
      var ok = true;
      for (var c = 0; c < chosen.length; c++) {
        if (linesCross(PAYLINES[order[o]], PAYLINES[chosen[c]])) { ok = false; break; }
      }
      if (ok) chosen.push(order[o]);
    }
    return chosen;
  }

  // The grid cleanly realizes the intended layout iff every resolved line (paying
  // OR special) is one of the chosen shapes carrying its assigned symbol as a FULL
  // line -- so no stray full line slipped in from a leftover symbol and every
  // intended line completed.
  function symbolLinesMatch(resolved, idxs, owners) {
    var want = {};
    for (var i = 0; i < idxs.length; i++) want[idxs[i]] = owners[i];
    for (var w = 0; w < resolved.length; w++) {
      var e = want[resolved[w].lineIndex];
      if (e === undefined || resolved[w].symbol !== e || resolved[w].count !== REELS) return false;
    }
    return true;
  }

  // Try to lay out `syms` (distinct symbols -- paying for a win spread, or a single
  // special for a bald/bonus line) as that many FULL lines, one per mutually
  // non-crossing active shape: each chosen shape gets its symbol in every column, and
  // the leftover rows of each column take the remaining symbols (so the column stays
  // repeat-free). Accept only when the evaluator reads back exactly those full lines
  // and NOTHING else -- no leftover symbol may accidentally complete another active
  // line, paying or special. Returns the grid or null if the try budget is spent.
  function placeSymbolLines(rng, active, syms) {
    var k = syms.length;
    if (k > active) return null;
    for (var t = 0; t < SYNTH_TRIES; t++) {
      var idxs = pickNonCrossingLines(rng, active, k);
      if (idxs.length < k) continue;
      var owners = syms.slice();                       // which symbol owns which shape
      for (var s = owners.length - 1; s > 0; s--) {
        var j = Math.floor(rng() * (s + 1)) % (s + 1);
        var tmp = owners[s]; owners[s] = owners[j]; owners[j] = tmp;
      }
      var grid = blankGrid();
      for (var c = 0; c < REELS; c++) {
        var taken = {}, usedSym = {};
        for (var w = 0; w < k; w++) {
          var row = PAYLINES[idxs[w]][c];
          grid[row][c] = owners[w];
          taken[row] = true; usedSym[owners[w]] = true;
        }
        var rem = [];                                  // remaining symbols -> leftover rows
        for (var sy = 0; sy < SYMBOLS.length; sy++) if (!usedSym[sy]) rem.push(sy);
        for (var rr = rem.length - 1; rr > 0; rr--) {
          var jj = Math.floor(rng() * (rr + 1)) % (rr + 1);
          var tt = rem[rr]; rem[rr] = rem[jj]; rem[jj] = tt;
        }
        var ri = 0;
        for (var row2 = 0; row2 < ROWS; row2++) { if (!taken[row2]) grid[row2][c] = rem[ri++]; }
      }
      var res = evaluate(grid, PAYLINES.slice(0, active), 1);
      var resolved = res.winningLines.concat(res.specialLines);
      if (resolved.length === k && symbolLinesMatch(resolved, idxs, owners)) {
        return grid;
      }
    }
    return null;
  }

  // A winning grid: permutation reels with one to MAX_WIN_LINES COMPLETE lines of
  // ANY shape -- horizontal, diagonal, chevron, zigzag, W/M -- each a distinct
  // symbol, and nothing else paying. The drawn total `units` selects a spread (a
  // subset of symbols whose full-line payouts sum to it; bigger wins light up more
  // lines), laid on mutually non-crossing shapes so wins land across the whole
  // catalog rather than the straight rows alone. Rejection-sampled per spread, with
  // a degradation path toward fewer lines and finally the single-line fallback for
  // the rare grid that won't place cleanly. Whichever lands, the credited payout is
  // always the evaluator's reading of the shown grid.
  function synthesizeWinningGrid(rng, lines, units) {
    var active = Math.min(lines, MAX_LINES);
    var maxParts = Math.min(active, MAX_WIN_LINES);
    var candidates = orderedSpreadCandidates(rng, units, maxParts);
    for (var i = 0; i < candidates.length; i++) {
      var grid = placeSymbolLines(rng, active, candidates[i]);
      if (grid) return grid;
    }
    return fallbackSingleLineGrid(rng, lines, closestSymbolForUnits(units, lines));
  }

  // A SPECIAL grid: exactly ONE full line of `specialSym` (BALD or BONUS_SYM) on a
  // random active shape, with nothing else resolving -- no paying line and no second
  // special line. The credited charge/award is always the evaluator's reading of the
  // shown grid, so the player is debited/credited exactly what the bald/wig line shows.
  function synthesizeSpecialGrid(rng, lines, specialSym) {
    var active = Math.min(lines, MAX_LINES);
    var grid = placeSymbolLines(rng, active, [specialSym]);
    if (grid) return grid;
    return fallbackSingleLineGrid(rng, lines, specialSym);
  }

  // ---------- Guaranteed fallbacks (used only when rejection exhausts its budget,
  // which is effectively never; they trade reel variety for a provable outcome) ----------

  // No active line can pay: reels 0 and 2 draw from two DISJOINT symbol pools, so
  // reel0 != reel2 on every payline -> a left-anchored run never reaches 3.
  function fallbackLosingGrid(rng) {
    var idx = shuffledSymbols(rng);
    var cut = 1 + (Math.floor(rng() * (idx.length - 1)) % (idx.length - 1));
    var setA = idx.slice(0, cut);                        // reel-0 pool
    var setC = idx.slice(cut);                           // reel-2 pool (disjoint)
    var grid = blankGrid();
    for (var r = 0; r < ROWS; r++) {
      grid[r][0] = setA[Math.floor(rng() * setA.length) % setA.length];
      grid[r][1] = randSym(rng);
      grid[r][2] = setC[Math.floor(rng() * setC.length) % setC.length];
      grid[r][3] = randSym(rng);
      grid[r][4] = randSym(rng);
    }
    return grid;
  }

  // Two distinct symbols, both different from `avoid`.
  function pickTwoDistinct(rng, avoid) {
    var pool = [];
    for (var i = 0; i < SYMBOLS.length; i++) if (i !== avoid) pool.push(i);
    var a = pool[Math.floor(rng() * pool.length) % pool.length];
    var rest = [];
    for (var j = 0; j < pool.length; j++) if (pool[j] !== a) rest.push(pool[j]);
    var b = rest[Math.floor(rng() * rest.length) % rest.length];
    return { a: a, b: b };
  }

  // Plants a single FULL line of `sym` (any symbol -- a net-positive paying symbol
  // for a win, or a special for a bald/bonus line) on one horizontal row: locking
  // columns 0/1 of every other row to two distinct symbols (both != sym) leaves that
  // row the sole full line. Catalog invariant: only a straight horizontal has
  // reel0 == reel1, so for any non-horizontal shape P the cells (P[0],0) and (P[1],1)
  // are different rows -- one holds `a`, the other `b` (or `sym` on row R), never one
  // symbol throughout. The guaranteed safety net for the rare spin whose layout won't
  // place cleanly; honest like every grid -- the credited amount is the evaluator's reading.
  function fallbackSingleLineGrid(rng, lines, sym) {
    var rows = Math.min(lines, ROWS);
    var R = Math.floor(rng() * rows) % rows;
    var grid = blankGrid();
    var c, r;
    for (c = 0; c < REELS; c++) grid[R][c] = sym;                     // the full winning row
    var two = pickTwoDistinct(rng, sym);
    for (r = 0; r < ROWS; r++) {
      if (r === R) continue;
      grid[r][0] = two.a; grid[r][1] = two.b;
      for (c = 2; c < REELS; c++) grid[r][c] = randSym(rng);
    }
    return grid;
  }

  // ---------- Bet helpers ----------
  function betPerLine(game) { return BET_TIERS[game.betIndex]; }
  function spinCost(game) { return game.lines * BET_TIERS[game.betIndex]; }

  // Can this spin be staked? Allowed while the stage is live, the cost is real,
  // and staking it would leave the player no more than DEBT_LIMIT in the red.
  // Single source of truth for both spin()'s guard and the button's enabled state.
  function canSpin(game) {
    if (terminal(game)) return false;
    var cost = spinCost(game);
    return cost > 0 && game.credits - cost >= -DEBT_LIMIT;
  }

  // ---------- Game lifecycle ----------
  // game = { seed, spinNum, credits, lines, betIndex, phase, grid, lastResult,
  //          complete, bust }
  // phase: "idle" (awaiting a spin, bet adjustable) | "result" (spin resolved).
  function createGame(seed) {
    var s = (seed >>> 0) || 1;
    return {
      seed: s,
      spinNum: 0,
      credits: START_CREDITS,
      peakCredits: START_CREDITS,  // high-water mark of credits -- the scoring basis
      lines: MAX_LINES,       // default: every line lit
      betIndex: 0,            // default: minimum per-line bet
      phase: "idle",
      // Decorative resting spread (deterministic, no winning run) so the idle
      // machine reads like real reels, not a misleading all-matching screen.
      // Uses its own RNG stream; per-spin RNG is independent, so determinism holds.
      grid: synthesizeLosingGrid(makeRng(s)),
      lastResult: null,
      complete: false,
      bust: false
    };
  }

  function terminal(game) { return game.complete || game.bust; }

  // Set the number of active paylines (clamped). No-op once the stage resolves.
  function setLines(game, n) {
    if (terminal(game)) return game;
    n = Math.floor(n);
    game.lines = clamp(n, MIN_LINES, MAX_LINES);
    return game;
  }

  // Set bet-per-line by tier index (clamped). No-op once the stage resolves.
  function setBet(game, tierIndex) {
    if (terminal(game)) return game;
    tierIndex = Math.floor(tierIndex);
    game.betIndex = clamp(tierIndex, 0, BET_TIERS.length - 1);
    return game;
  }

  // The spin. Stakes the cost up front (the bankroll may dip as far as
  // -DEBT_LIMIT), decides win/lose, synthesizes a grid, and credits exactly what
  // the evaluator reads off that grid. No-op when the stage has resolved or the
  // stake would exceed the debt limit (the renderer disables the button to match;
  // this guard is the safety net).
  function spin(game) {
    if (!canSpin(game)) return game;
    var cost = spinCost(game);
    game.spinNum += 1;
    var rng = makeRng((game.seed ^ Math.imul(game.spinNum, 0x9e3779b9)) >>> 0);
    game.credits -= cost;                            // stake the bet
    var lines = activeLines(game);
    var per = betPerLine(game);
    var win = rng() < WIN_RATE;
    var kind = "loss";
    if (win) {
      var units = drawWinUnits(rng, game.lines);
      game.grid = synthesizeWinningGrid(rng, game.lines, units);
      kind = "win";
    } else if (rng() < SPECIAL_LINE_RATE) {
      // A non-win spin can still surface a SPECIAL full line on top of the lost
      // stake: half golden-wig bonus, half bald penalty. The bald is suppressed when
      // the spin already staked into debt (credits < 0), so the deduction can never
      // push the bankroll past the debt floor.
      if (rng() < 0.5) {
        game.grid = synthesizeSpecialGrid(rng, game.lines, BONUS_SYM);
        kind = "bonus";
      } else if (game.credits >= 0) {
        game.grid = synthesizeSpecialGrid(rng, game.lines, BALD);
        kind = "bald";
      } else {
        game.grid = synthesizeLosingGrid(rng);
      }
    } else {
      game.grid = synthesizeLosingGrid(rng);
    }
    var res = evaluate(game.grid, lines, per);       // single source of truth
    var credited = res.payout + res.bonus - res.penalty;
    game.credits += credited;                        // apply the actual evaluated grid
    if (game.credits > game.peakCredits) game.peakCredits = game.credits;  // track the best reached
    game.lastResult = {
      kind: kind,                  // "win" | "loss" | "bonus" | "bald"
      win: win,                    // a PAYING win (drives the ~45% net-win frequency)
      payout: res.payout,          // positive paying-line total (0 on loss/special)
      bonus: res.bonus,            // golden-wig award (0 unless a bonus spin)
      penalty: res.penalty,        // bald-head deduction (0 unless a bald spin)
      winningLines: res.winningLines,
      specialLines: res.specialLines,
      delta: credited - cost,
      cost: cost
    };
    game.phase = "result";
    if (game.credits >= TARGET_CREDITS) game.complete = true;
    // Debt is never carried: if the payout didn't clear a staked overdraft, the
    // run ends still in the red.
    else if (game.credits < 0) game.bust = true;
    return game;
  }

  function isComplete(game) { return !!game.complete; }
  function isBust(game) { return !!game.bust; }

  // ---------- Scoring ----------
  // Points this run banks at the slot, graded by the BEST bankroll reached (the
  // high-water mark), not the final one -- the stage only ends at the target or a
  // bust, so scoring the peak is what makes "doing better" pay: a run that climbed
  // to 1900 before busting outscores one that busted at the deal. Progress from
  // the starting bankroll toward the target is scaled so a clear banks the full
  // 10000 and a never-gained bust banks 0 -- the same per-stage cap every leg tops
  // out at, so each contributes equally to the overall score.
  var SCORE_PER_CREDIT = 10;   // (TARGET-START) credits of progress -> 10000 points
  function slotBonus(game) {
    var peak = game.peakCredits;
    return SCORE_PER_CREDIT * clamp(peak - START_CREDITS, 0, TARGET_CREDITS - START_CREDITS);
  }
  function maxScore() { return SCORE_PER_CREDIT * (TARGET_CREDITS - START_CREDITS); }   // 10000

  return {
    REELS: REELS,
    ROWS: ROWS,
    START_CREDITS: START_CREDITS,
    TARGET_CREDITS: TARGET_CREDITS,
    MAX_LINES: MAX_LINES,
    MIN_LINES: MIN_LINES,
    MAX_WIN_LINES: MAX_WIN_LINES,
    BET_TIERS: BET_TIERS,
    DEBT_LIMIT: DEBT_LIMIT,
    WIN_RATE: WIN_RATE,
    EDGE: EDGE,
    SYMBOLS: SYMBOLS,
    FULL_PAY: FULL_PAY,
    PAY_SYMBOLS: PAY_SYMBOLS,
    BALD: BALD,
    BONUS_SYM: BONUS_SYM,
    PENALTY: PENALTY,
    BONUS: BONUS,
    SPECIAL_LINE_RATE: SPECIAL_LINE_RATE,
    maxScore: maxScore,

    createGame: createGame,
    setLines: setLines,
    setBet: setBet,
    spin: spin,
    canSpin: canSpin,
    isComplete: isComplete,
    isBust: isBust,
    slotBonus: slotBonus,
    spinCost: spinCost,
    betPerLine: betPerLine,

    // Exposed for tests and the renderer.
    makeRng: makeRng,
    buildPaylines: buildPaylines,
    activeLines: activeLines,
    evaluate: evaluate,
    synthesizeWinningGrid: synthesizeWinningGrid,
    synthesizeSpecialGrid: synthesizeSpecialGrid,
    synthesizeLosingGrid: synthesizeLosingGrid,
    requiredMeanNet: requiredMeanNet,
    drawWinUnits: drawWinUnits
  };
});
