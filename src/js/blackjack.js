/*
 * Pin the Wig on Hexy -- the God Gamer final boss: blackjack against the True God Gamer.
 *
 * Reaching here means the player qualified on base score (>75%) AND cleared all
 * five pinball tables. This is the last gate: blackjack against the True God Gamer (the dealer).
 * You must WIN FOUR hands to be crowned GOD GAMER, which means you can afford at
 * most TWO losses -- a third loss ends the run on the spot (you can no longer
 * reach four within the six-round match). A push doesn't count -- that hand
 * re-deals, so ties never cost you the title and never advance you either.
 *
 * Standard single-hand rules: dealer stands on 17 (including soft 17), a natural
 * two-card 21 beats a drawn 21 and pushes another natural. Each hand is dealt
 * from its own freshly shuffled 52-card deck (seeded off the run seed + hand
 * number) so a hand can never run the shoe dry and replays are deterministic.
 *
 * Pure and DOM-free: deck building, hand valuation, the dealer policy, settle,
 * and the win-all-three progression are all verifiable in Node (see tests/).
 * game.js is the thin shell that renders the felt and wires the buttons. Loaded
 * as a plain script in the browser (sets window.PTWOHBlackjack) and as a
 * CommonJS module in Node tests -- no build step.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.PTWOHBlackjack = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var ROUNDS_TOTAL = 6;     // win four before a third loss (up to six rounds)
  var ROUNDS_TO_WIN = 4;    // hands you must win to be crowned GOD GAMER
  var LOSSES_ALLOWED = ROUNDS_TOTAL - ROUNDS_TO_WIN; // 2 -- a third loss is elimination
  var DEALER_STANDS_ON = 17; // dealer draws while its total is below this
  var WIN_POINTS = 2000;    // score banked per hand won off the True God Gamer
  var SWEEP_BONUS = 2000;   // extra banked for a flawless 4-0 match (zero losses) -- the
                            // "doing better" reward: a clean sweep tops a 4-1 win

  var RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  var SUITS = ["S", "H", "D", "C"];   // spade, heart, diamond, club

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

  function rankValue(rank) {
    if (rank === "A") return 11;          // soft-counted; handValue demotes to 1 as needed
    if (rank === "K" || rank === "Q" || rank === "J") return 10;
    return parseInt(rank, 10);
  }

  function makeCard(rank, suit) {
    suit = suit || "S";
    return { rank: rank, suit: suit, value: rankValue(rank), red: suit === "H" || suit === "D" };
  }

  function buildDeck() {
    var d = [];
    for (var s = 0; s < SUITS.length; s++) {
      for (var r = 0; r < RANKS.length; r++) d.push(makeCard(RANKS[r], SUITS[s]));
    }
    return d;
  }

  function shuffle(deck, rng) {
    for (var i = deck.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var tmp = deck[i]; deck[i] = deck[j]; deck[j] = tmp;
    }
    return deck;
  }

  // Best total <= 21 for the cards, demoting aces from 11 to 1 as needed. `soft`
  // means an ace is still counted as 11 (so the hand can't bust on the next hit).
  function handValue(cards) {
    var total = 0, aces = 0;
    for (var i = 0; i < cards.length; i++) {
      total += cards[i].value;
      if (cards[i].rank === "A") aces++;
    }
    while (total > 21 && aces > 0) { total -= 10; aces--; }
    return { total: total, soft: aces > 0 && total <= 21 };
  }

  function isBust(cards) { return handValue(cards).total > 21; }
  function isBlackjack(cards) { return cards.length === 2 && handValue(cards).total === 21; }
  function dealerShouldHit(cards) { return handValue(cards).total < DEALER_STANDS_ON; }

  // ---------- Game lifecycle ----------
  // game = { seed, handNum, roundsWon, roundsLost, complete, failed, phase,
  //          player[], dealer[], deck[], drawIdx, dealerHole, result }
  // phase: "player" (awaiting hit/stand) | "result" (hand settled, awaiting next)
  function createGame(seed) {
    var game = {
      seed: (seed >>> 0) || 1,
      handNum: 0,
      roundsWon: 0,
      roundsLost: 0,
      complete: false,
      failed: false,
      phase: "player",
      player: [],
      dealer: [],
      deck: [],
      drawIdx: 0,
      dealerHole: true,
      result: null
    };
    newHand(game);
    return game;
  }

  function draw(game) { return game.deck[game.drawIdx++]; }

  // Deal a fresh hand from a freshly shuffled deck. A two-card natural for either
  // side settles the hand immediately (no player turn).
  function newHand(game) {
    game.handNum += 1;
    var rng = makeRng((game.seed ^ Math.imul(game.handNum, 0x9e3779b9)) >>> 0);
    game.deck = shuffle(buildDeck(), rng);
    game.drawIdx = 0;
    game.player = [draw(game), draw(game)];
    game.dealer = [draw(game), draw(game)];
    game.dealerHole = true;
    game.result = null;
    if (isBlackjack(game.player) || isBlackjack(game.dealer)) {
      game.dealerHole = false;
      game.phase = "result";
      game.result = settle(game);
    } else {
      game.phase = "player";
    }
    return game;
  }

  // Player takes a card. Busting settles as a loss; hitting to 21 auto-stands so
  // the player never has to manually stand on a hand that can't improve.
  function hit(game) {
    if (game.phase !== "player") return game;
    game.player.push(draw(game));
    var v = handValue(game.player);
    if (v.total > 21) {
      game.dealerHole = false;
      game.phase = "result";
      game.result = settle(game);
    } else if (v.total === 21) {
      stand(game);
    }
    return game;
  }

  // Player stands: reveal the hole card, play out the dealer policy, settle.
  function stand(game) {
    if (game.phase !== "player") return game;
    game.dealerHole = false;
    while (dealerShouldHit(game.dealer)) game.dealer.push(draw(game));
    game.phase = "result";
    game.result = settle(game);
    return game;
  }

  // Compare the settled hands -> "win" | "lose" | "push" (from the player's view).
  function settle(game) {
    var p = game.player, d = game.dealer;
    var pBJ = isBlackjack(p), dBJ = isBlackjack(d);
    if (pBJ && dBJ) return "push";
    if (pBJ) return "win";
    if (dBJ) return "lose";
    var pt = handValue(p).total, dt = handValue(d).total;
    if (pt > 21) return "lose";
    if (dt > 21) return "win";
    if (pt > dt) return "win";
    if (pt < dt) return "lose";
    return "push";
  }

  // Fold the settled hand into the match: a win advances (and a fourth completes
  // the four needed), a loss spends one of the allowed -- a third loss fails the
  // whole challenge -- and a push leaves the tally untouched (the caller
  // re-deals). Returns the result string.
  function applyResult(game) {
    if (game.phase !== "result" || !game.result) return null;
    if (game.result === "win") {
      game.roundsWon += 1;
      if (game.roundsWon >= ROUNDS_TO_WIN) game.complete = true;
    } else if (game.result === "lose") {
      game.roundsLost += 1;
      if (game.roundsLost > LOSSES_ALLOWED) game.failed = true;
    }
    return game.result;
  }

  function isComplete(game) { return !!game.complete; }
  function isFailed(game) { return !!game.failed; }

  // The sweep reward: a match clinched without dropping a single hand banks an
  // extra SWEEP_BONUS on top of the four wins. Zero for any match still in
  // progress or won 4-1, so a flawless run scores strictly higher than a lossy one.
  function sweepBonus(game) {
    return (game.complete && game.roundsLost === 0) ? SWEEP_BONUS : 0;
  }

  // Most points a run can bank at blackjack: a flawless 4-0 match (four wins plus
  // the sweep bonus). Each stage's maxScore() tops out at the same 10000 so every
  // leg contributes equally to the overall score and the rank ladder's denominator.
  function maxScore() { return ROUNDS_TO_WIN * WIN_POINTS + SWEEP_BONUS; }

  return {
    ROUNDS_TOTAL: ROUNDS_TOTAL,
    ROUNDS_TO_WIN: ROUNDS_TO_WIN,
    LOSSES_ALLOWED: LOSSES_ALLOWED,
    DEALER_STANDS_ON: DEALER_STANDS_ON,
    WIN_POINTS: WIN_POINTS,
    SWEEP_BONUS: SWEEP_BONUS,
    sweepBonus: sweepBonus,
    maxScore: maxScore,
    RANKS: RANKS,
    SUITS: SUITS,

    createGame: createGame,
    newHand: newHand,
    hit: hit,
    stand: stand,
    applyResult: applyResult,
    isComplete: isComplete,
    isFailed: isFailed,

    // Exposed for the renderer and tests.
    handValue: handValue,
    isBust: isBust,
    isBlackjack: isBlackjack,
    dealerShouldHit: dealerShouldHit,
    settle: settle,
    makeCard: makeCard,
    buildDeck: buildDeck,
    makeRng: makeRng
  };
});
