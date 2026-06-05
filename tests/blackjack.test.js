"use strict";

// The God Gamer blackjack finale in isolation: the deck is well-formed, hand
// valuation handles aces both ways, the dealer policy stands on (soft) 17,
// settle ranks every outcome including naturals, the win-four-of-five
// progression spends exactly one allowed loss before failing, and a fixed seed
// reproduces an identical deal and play-out.

const test = require("node:test");
const assert = require("node:assert/strict");
const BJ = require("../src/js/blackjack.js");

const card = (rank, suit) => BJ.makeCard(rank, suit);
const hand = (...ranks) => ranks.map((r) => card(r));
// settle() reads only .player and .dealer, so a bare pair drives it directly.
const settleHands = (p, d) => BJ.settle({ player: p, dealer: d });

test("the match constants are best-of-five, win four, one loss allowed", () => {
  assert.equal(BJ.ROUNDS_TOTAL, 5);
  assert.equal(BJ.ROUNDS_TO_WIN, 4);
  assert.equal(BJ.LOSSES_ALLOWED, 1);
  assert.equal(BJ.DEALER_STANDS_ON, 17);
});

test("buildDeck yields 52 unique, correctly valued cards", () => {
  const deck = BJ.buildDeck();
  assert.equal(deck.length, 52);
  const seen = new Set();
  for (const c of deck) {
    const key = c.rank + c.suit;
    assert.ok(!seen.has(key), "duplicate card " + key);
    seen.add(key);
    if (c.rank === "A") assert.equal(c.value, 11);
    else if (["K", "Q", "J"].includes(c.rank)) assert.equal(c.value, 10);
    else assert.equal(c.value, parseInt(c.rank, 10));
    assert.equal(c.red, c.suit === "H" || c.suit === "D");
  }
  // 13 ranks x 4 suits, four of each rank.
  assert.equal(seen.size, 52);
});

test("handValue counts aces high then demotes them as needed", () => {
  assert.deepEqual(BJ.handValue(hand("A", "K")), { total: 21, soft: true });   // natural
  assert.deepEqual(BJ.handValue(hand("A", "6")), { total: 17, soft: true });   // soft 17
  assert.deepEqual(BJ.handValue(hand("A", "6", "K")), { total: 17, soft: false }); // ace demoted
  assert.deepEqual(BJ.handValue(hand("A", "A", "9")), { total: 21, soft: true }); // one ace 11, one 1
  assert.deepEqual(BJ.handValue(hand("A", "A", "A", "8")), { total: 21, soft: true });
  assert.deepEqual(BJ.handValue(hand("K", "Q", "5")), { total: 25, soft: false }); // hard bust
  assert.deepEqual(BJ.handValue([]), { total: 0, soft: false });
});

test("isBlackjack is a two-card 21 only; isBust is over 21", () => {
  assert.equal(BJ.isBlackjack(hand("A", "K")), true);
  assert.equal(BJ.isBlackjack(hand("A", "7", "3")), false);   // 21 but three cards
  assert.equal(BJ.isBlackjack(hand("10", "9")), false);
  assert.equal(BJ.isBust(hand("K", "Q", "2")), true);
  assert.equal(BJ.isBust(hand("A", "K")), false);
});

test("the dealer hits below 17 and stands on 17, including soft 17", () => {
  assert.equal(BJ.dealerShouldHit(hand("10", "6")), true);    // hard 16
  assert.equal(BJ.dealerShouldHit(hand("10", "7")), false);   // hard 17
  assert.equal(BJ.dealerShouldHit(hand("A", "5")), true);     // soft 16
  assert.equal(BJ.dealerShouldHit(hand("A", "6")), false);    // soft 17 -> stand
  assert.equal(BJ.dealerShouldHit(hand("A", "A")), true);     // 12
});

test("settle ranks every outcome from the player's point of view", () => {
  assert.equal(settleHands(hand("K", "Q", "5"), hand("10", "8")), "lose"); // player bust
  assert.equal(settleHands(hand("10", "8"), hand("K", "Q", "5")), "win");  // dealer bust
  assert.equal(settleHands(hand("10", "9"), hand("10", "8")), "win");      // 19 > 18
  assert.equal(settleHands(hand("10", "7"), hand("10", "9")), "lose");     // 17 < 19
  assert.equal(settleHands(hand("10", "8"), hand("10", "8")), "push");     // 18 = 18
  assert.equal(settleHands(hand("A", "K"), hand("A", "K")), "push");       // both naturals
  assert.equal(settleHands(hand("A", "K"), hand("10", "9")), "win");       // player natural
  assert.equal(settleHands(hand("10", "9"), hand("A", "K")), "lose");      // dealer natural
  // A natural 21 beats a drawn 21.
  assert.equal(settleHands(hand("A", "K"), hand("7", "7", "7")), "win");
  assert.equal(settleHands(hand("7", "7", "7"), hand("A", "K")), "lose");
});

test("hit busts into a loss and auto-stands on 21", () => {
  // Bust: 19 + a King = 29 -> immediate loss, hole revealed.
  const g = BJ.createGame(1);
  g.phase = "player";
  g.player = hand("10", "9");
  g.dealer = hand("10", "8");
  g.deck = hand("K");
  g.drawIdx = 0;
  BJ.hit(g);
  assert.equal(g.phase, "result");
  assert.equal(g.result, "lose");
  assert.equal(g.dealerHole, false);

  // Auto-stand: 14 + 7 = 21 ends the player's turn and plays the dealer out.
  const g2 = BJ.createGame(1);
  g2.phase = "player";
  g2.player = hand("7", "7");
  g2.dealer = hand("10", "8");      // 18, dealer stands
  g2.deck = hand("7");
  g2.drawIdx = 0;
  BJ.hit(g2);
  assert.equal(g2.phase, "result");
  assert.equal(g2.dealerHole, false);
  assert.equal(BJ.handValue(g2.player).total, 21);
  assert.equal(g2.result, "win");   // 21 vs 18
});

test("stand reveals the hole and draws the dealer up to its policy", () => {
  const g = BJ.createGame(1);
  g.phase = "player";
  g.player = hand("10", "8");       // 18, stands
  g.dealer = hand("10", "6");       // 16, must draw
  g.deck = hand("5");               // -> 21
  g.drawIdx = 0;
  BJ.stand(g);
  assert.equal(g.phase, "result");
  assert.equal(g.dealerHole, false);
  assert.equal(BJ.handValue(g.dealer).total, 21);
  assert.equal(g.result, "lose");   // 18 < 21
});

test("a two-card natural settles the hand at the deal with no player turn", () => {
  // Force a deck whose first four dealt cards give the player a natural.
  const g = BJ.createGame(1);
  g.handNum = 0;
  // deal order is player, player, dealer, dealer.
  g.deck = hand("A", "K", "9", "7").concat(BJ.buildDeck());
  g.drawIdx = 0;
  // Re-run the post-deal portion of newHand by hand to use our stacked deck.
  g.player = [g.deck[g.drawIdx++], g.deck[g.drawIdx++]];
  g.dealer = [g.deck[g.drawIdx++], g.deck[g.drawIdx++]];
  g.dealerHole = true;
  if (BJ.isBlackjack(g.player) || BJ.isBlackjack(g.dealer)) {
    g.dealerHole = false; g.phase = "result"; g.result = BJ.settle(g);
  }
  assert.equal(g.phase, "result");
  assert.equal(g.result, "win");
  assert.equal(g.dealerHole, false);
});

test("applyResult: four wins crowns the player, one loss is survivable", () => {
  const g = BJ.createGame(7);
  function play(result) { g.phase = "result"; g.result = result; return BJ.applyResult(g); }

  assert.equal(play("win"), "win");
  assert.equal(g.roundsWon, 1);
  play("push");                       // pushes never move the tally
  assert.equal(g.roundsWon, 1);
  assert.equal(g.roundsLost, 0);
  play("lose");                       // the one allowed loss
  assert.equal(g.roundsLost, 1);
  assert.equal(g.failed, false);
  play("win"); play("win");
  assert.equal(g.roundsWon, 3);
  assert.equal(g.complete, false);
  play("win");                        // fourth win
  assert.equal(g.roundsWon, 4);
  assert.equal(g.complete, true);
  assert.equal(g.failed, false);
});

test("win points are positive and a flawless match caps the blackjack bonus", () => {
  assert.ok(BJ.WIN_POINTS > 0, "a hand won must be worth something");
  // maxScore is the rank-ladder denominator: a flawless 4-0 match (four wins plus
  // the sweep bonus) is the most a run can bank -- no more, no less. Every stage
  // tops out at the same 10000 so each leg contributes equally to the overall score.
  assert.equal(BJ.maxScore(), BJ.ROUNDS_TO_WIN * BJ.WIN_POINTS + BJ.SWEEP_BONUS);
  assert.equal(BJ.maxScore(), 10000);
});

test("the sweep bonus rewards a flawless match: 4-0 banks more than 4-1", () => {
  // A clean 4-0 sweep pays the bonus on top of the four wins.
  const clean = BJ.createGame(7);
  function play(g, result) { g.phase = "result"; g.result = result; return BJ.applyResult(g); }
  play(clean, "win"); play(clean, "win"); play(clean, "win"); play(clean, "win");
  assert.equal(clean.complete, true);
  assert.equal(clean.roundsLost, 0);
  assert.equal(BJ.sweepBonus(clean), BJ.SWEEP_BONUS);

  // A 4-1 win clinches the match but drops a hand -- no sweep.
  const lossy = BJ.createGame(7);
  play(lossy, "win"); play(lossy, "lose"); play(lossy, "win"); play(lossy, "win"); play(lossy, "win");
  assert.equal(lossy.complete, true);
  assert.equal(lossy.roundsLost, 1);
  assert.equal(BJ.sweepBonus(lossy), 0);

  // A match still in progress never pays the sweep, even at zero losses.
  const mid = BJ.createGame(7);
  play(mid, "win"); play(mid, "win");
  assert.equal(mid.complete, false);
  assert.equal(BJ.sweepBonus(mid), 0);

  // Doing better strictly out-scores: a flawless run banks more than a 4-1 win.
  const cleanTotal = BJ.ROUNDS_TO_WIN * BJ.WIN_POINTS + BJ.sweepBonus(clean);
  const lossyTotal = BJ.ROUNDS_TO_WIN * BJ.WIN_POINTS + BJ.sweepBonus(lossy);
  assert.ok(cleanTotal > lossyTotal, "a sweep must beat a lossy win");
});

test("applyResult: a second loss fails the whole challenge", () => {
  const g = BJ.createGame(7);
  function play(result) { g.phase = "result"; g.result = result; return BJ.applyResult(g); }
  play("win");
  play("lose");
  assert.equal(g.failed, false);      // first loss survivable
  play("lose");
  assert.equal(g.roundsLost, 2);
  assert.equal(g.failed, true);       // second loss is elimination
  assert.equal(g.complete, false);
});

test("a fixed seed reproduces an identical deal and play-out", () => {
  function cardsKey(cards) { return cards.map((c) => c.rank + c.suit).join(" "); }
  const a = BJ.createGame(424242);
  const b = BJ.createGame(424242);
  assert.equal(cardsKey(a.player), cardsKey(b.player), "same seed deals the same player hand");
  assert.equal(cardsKey(a.dealer), cardsKey(b.dealer), "same seed deals the same dealer hand");

  // Same scripted decisions from the same start must reach the same result.
  function playOut(g) {
    let guard = 0;
    while (g.phase === "player" && guard++ < 20) {
      if (BJ.handValue(g.player).total < 17) BJ.hit(g); else BJ.stand(g);
    }
    return g.result + ":" + cardsKey(g.player) + ":" + cardsKey(g.dealer);
  }
  assert.equal(playOut(a), playOut(b));
});

test("an end-to-end best-of-five always resolves to complete or failed without error", () => {
  for (let seed = 1; seed <= 60; seed++) {
    const g = BJ.createGame(seed);
    let guard = 0;
    while (!g.complete && !g.failed && guard++ < 200) {
      let inner = 0;
      while (g.phase === "player" && inner++ < 25) {
        const v = BJ.handValue(g.player);
        assert.ok(Number.isFinite(v.total), "seed " + seed + " produced a non-finite total");
        if (v.total < 17) BJ.hit(g); else BJ.stand(g);
      }
      assert.equal(g.phase, "result", "seed " + seed + " stuck out of a player turn");
      assert.ok(["win", "lose", "push"].includes(g.result), "seed " + seed + " bad result");
      BJ.applyResult(g);
      if (!g.complete && !g.failed) BJ.newHand(g);
    }
    assert.ok(g.complete || g.failed, "seed " + seed + " never resolved");
    // Can't be both, and the tallies respect the match shape.
    assert.ok(!(g.complete && g.failed));
    assert.ok(g.roundsWon <= BJ.ROUNDS_TO_WIN);
    assert.ok(g.roundsLost <= BJ.LOSSES_ALLOWED + 1);
  }
});
