/*
 * Pin the Wig on Hexy -- "Feed Molly" bonus mode (pure logic).
 *
 * Molly is Hexy's fluffy black cat. The chat running joke is that he never
 * feeds her (he of course spoils her rotten). This mode is the bit: open her
 * wet-food cans before she loses patience.
 *
 * Mechanic -- the CAN-RIM OPENER. A pointer sweeps around the can's lid; you
 * tap when it crosses the green pull-tab. Each "can" stacks one more hazard:
 *   1. baseline          slow sweep, fat tab
 *   2. faster + thinner
 *   3. drifting tab       the sweet spot slides around the rim
 *   4. Molly interferes   telegraphed head-lunges jolt the rim
 *   5. the spoiled finale multi-stop + drift + lunge AND a drawn paw swipe AND
 *                         a "kibble" decoy arc she refuses to eat
 * A draining PATIENCE meter is the comedic fail state: empty it and she stalks
 * off (the "he never feeds her" punchline), ending the run at the scoreboard.
 *
 * Like modifiers.js / pinball.js this module is pure and DOM-free: every
 * function takes plain objects, so the whole thing is verifiable in Node (see
 * tests/). game.js is the I/O shell that owns the canvas, input, and audio.
 *
 * Loaded as a plain script in the browser (sets window.PTWOHFeedMolly) and as
 * a CommonJS module in Node tests -- no build step.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.PTWOHFeedMolly = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var TAU = Math.PI * 2;

  // ---------- Scoring ----------
  // Tuned so a flawless run (every required strike a bullseye, every can opened)
  // banks exactly 10000 -- the same per-stage cap every leg of the run tops out
  // at, so each contributes equally to the overall score (see maxScore).
  var BULLSEYE = 1000; // struck the bonus zone dead-center of the green tab
  var PERFECT = 540;   // tab struck near-center
  var GOOD = 240;      // tab struck within the green arc
  var KIBBLE = -160;   // struck the decoy "cheap kibble" arc -- she won't touch it
  var WHIFF = 0;       // struck bare rim
  var OPEN_BONUS = 200; // banked when a can is fully opened

  // The bonus zone is the central fraction of the green tab's half-width. The
  // shell draws it (FEED.BULLSEYE_FRAC) so the visual and the scoring agree.
  var BULLSEYE_FRAC = 0.20;

  // Telegraph window before a hazard strike lands (seconds). Long enough to be
  // a fair tell, like the warp telegraph in modifiers.js.
  var TELE = 0.55;

  // Patience deltas. The drain rate is per-can (rule.drain); these are the
  // per-event nudges a tap applies on top of it.
  var PAT_BULLSEYE = 0.06;
  var PAT_PERFECT = 0.05;
  var PAT_GOOD = 0.02;
  var PAT_KIBBLE = -0.04;
  // A bare-rim miss -- a tap nowhere near the tab -- is a HIT: she swats back and
  // a real bite of patience (the run's time bar) is torn off. Tuned to sting hard
  // enough to feel like damage, but a single can-open (PAT_OPEN) still recovers it.
  var PAT_WHIFF = -0.12;
  // Opening a can refills patience -- she's briefly pleased to be fed. Without
  // this the single run-long bar can't survive all five cans (drain outpaces
  // per-hit gains), which made the mode near-impossible.
  var PAT_OPEN = 0.45;

  // ---------- RNG (mulberry32) ----------
  // Deterministic across Node and browsers, so a seed reproduces a playthrough.
  function makeRng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // Wrap an angle to [0, TAU).
  function normalizeAngle(a) {
    a = a % TAU;
    return a < 0 ? a + TAU : a;
  }

  // Smallest signed difference a-b, in (-PI, PI].
  function angDiff(a, b) {
    var d = normalizeAngle(a - b);
    return d > Math.PI ? d - TAU : d;
  }

  // Fisher-Yates; returns a new array.
  function shuffle(arr, rng) {
    var out = arr.slice();
    for (var i = out.length - 1; i > 0; i--) {
      var j = (rng() * (i + 1)) | 0;
      var t = out[i]; out[i] = out[j]; out[j] = t;
    }
    return out;
  }

  // ---------- The cans ----------
  //
  // Each can declares display copy plus a `rule` of difficulty knobs:
  //   sweep    base pointer angular speed (rad/s)
  //   notch    half-width of the green pull-tab arc (rad)
  //   drift    tab drift speed around the rim (rad/s); 0 = static
  //   hits     successful strikes needed to pop the lid
  //   hazard   null | "lunge" | "paw" | "both"  -- how Molly interferes
  //   every    seconds between hazard strikes
  //   jolt     rim jolt magnitude when a hazard lands (rad)
  //   kibble   half-width of the red decoy arc (rad); 0 = none
  //   drain    patience drained per second
  //   flip     full revolutions the opener must sweep before it may reverse
  //            (0 = never reverses). Distance-based, not time-based, so every
  //            segment crosses the whole rim -- the tab is always reachable.
  var CANS = [
    {
      key: "crack", name: "Just Crack It",
      hint: "Tap or press Space when the pointer hits the green tab. Bonus for the yellow. That's the whole game, gamer.",
      rule: { sweep: 3.5, notch: 0.20, drift: 0, hits: 1, hazard: null, every: 0, jolt: 0, kibble: 0, drain: 0.078 },
    },
    {
      key: "flip", name: "Second Thoughts",
      hint: "The opener keeps reversing. Read the flip -- don't just mash a rhythm.",
      rule: { sweep: 4.0, notch: 0.19, drift: 0, hits: 2, hazard: null, every: 0, jolt: 0, kibble: 0, drain: 0.082, flip: 1.25 },
    },
    {
      key: "slip", name: "Moving Target",
      hint: "The tab won't sit still. Neither will she.",
      rule: { sweep: 4.1, notch: 0.20, drift: 1.1, hits: 1, hazard: null, every: 0, jolt: 0, kibble: 0, drain: 0.087 },
    },
    {
      key: "swat", name: "Cat Got Your Can",
      hint: "She lunges at the can -- watch the tell, the rim jolts when she connects.",
      rule: { sweep: 4.5, notch: 0.17, drift: 0.9, hits: 2, hazard: "lunge", every: 1.4, jolt: 0.8, kibble: 0, drain: 0.098 },
    },
    {
      key: "diva", name: "The Spoiled Diva",
      hint: "Three pops, a reversing wandering tab, a swatting paw, and she snubs cheap kibble. Spoil her.",
      rule: { sweep: 5.5, notch: 0.15, drift: 1.4, hits: 3, hazard: "both", every: 1.1, jolt: 1.0, kibble: 0.30, drain: 0.108, flip: 1.15 },
    },
  ];

  var CANS_GOAL = CANS.length;

  // Opener and finale are pinned for a clean difficulty arc; the middle cans
  // shuffle per seed so each playthrough's order varies.
  function pickCans(seed) {
    var rng = makeRng((seed >>> 0) || 1);
    var middle = shuffle([CANS[1], CANS[2], CANS[3]], rng);
    return [CANS[0], middle[0], middle[1], middle[2], CANS[4]];
  }

  // Best achievable total: every required strike a BULLSEYE, every can opened.
  // Kept in sync with endGame()'s accuracy denominator (game.js).
  function maxScore() {
    var total = 0;
    for (var i = 0; i < CANS.length; i++) {
      total += CANS[i].rule.hits * BULLSEYE + OPEN_BONUS;
    }
    return total;
  }

  // ---------- Run state ----------
  function createRun(seed) {
    var s = (seed >>> 0) || 1;
    var run = {
      seed: s,
      cans: pickCans(s),
      idx: 0,
      opened: 0,        // cans fully popped (0..CANS_GOAL)
      bonus: 0,         // points earned in this mode
      patience: 1,      // 1 full -> 0 she stalks off
      failed: false,    // patience hit zero
      // per-can runtime (set by resetCan):
      theta: 0, dir: 1, flipDist: 0, notch: 0, kibble: 0, hitsDone: 0,
      haz: { phase: "idle", timer: 0, tele: 0, type: "lunge", count: 0, pawAngle: 0 },
      rng: makeRng(s),
    };
    resetCan(run);
    return run;
  }

  function activeCan(run) { return run.cans[run.idx]; }

  // Zero the per-can clocks/positions at the start of a can. Patience and the
  // opened/bonus tallies persist across cans (they are the run's progress).
  function resetCan(run) {
    var c = activeCan(run);
    var r = c.rule;
    run.theta = 0;
    run.dir = run.rng() < 0.5 ? -1 : 1;
    // Sweep distance (radians) remaining before the opener may reverse.
    run.flipDist = r.flip ? TAU * r.flip : 0;
    run.notch = run.rng() * TAU;
    // Seat the decoy roughly opposite the tab so it is a real alternative, not
    // an overlap.
    run.kibble = normalizeAngle(run.notch + Math.PI + (run.rng() - 0.5) * 1.0);
    run.hitsDone = 0;
    run.haz.phase = "idle";
    // First hazard comes quickly so it actually shows before a fast can closes.
    run.haz.timer = r.every > 0 ? r.every * 0.45 : 0;
    run.haz.tele = 0;
    run.haz.count = 0;
    run.haz.type = "lunge";
    run.haz.pawAngle = run.notch;
  }

  // Advance one frame. Mutates run; returns event flags for the shell's juice:
  //   { patienceOut, telegraph, strike, hazType }
  function step(run, dt, reduceMotion) {
    var c = activeCan(run);
    var r = c.rule;
    var ev = { patienceOut: false, telegraph: false, strike: false, hazType: null };
    if (run.failed) { ev.patienceOut = true; return ev; }

    // The opener reverses direction (the "flip" mechanic) so the player can't
    // lock into a rhythm -- but only AFTER sweeping at least one full revolution,
    // so the tab is always crossed and never trapped out of reach.
    if (r.flip) {
      run.flipDist -= r.sweep * dt;
      if (run.flipDist <= 0) {
        run.dir *= -1;
        run.flipDist = TAU * lerp(r.flip, r.flip + 0.6, run.rng());
      }
    }

    // Sweep the opener around the rim.
    run.theta = normalizeAngle(run.theta + run.dir * r.sweep * dt);
    // Drift the tab (and its decoy) around the rim.
    if (r.drift) {
      run.notch = normalizeAngle(run.notch + r.drift * dt);
      if (r.kibble) run.kibble = normalizeAngle(run.kibble + r.drift * dt);
    }

    // Patience always drains; whiffs/kibble cost extra in attempt().
    run.patience = clamp(run.patience - r.drain * dt, 0, 1);

    // Hazard state machine: idle -> telegraph -> (strike, jolt) -> idle.
    if (r.hazard) {
      var h = run.haz;
      if (h.phase === "idle") {
        h.timer -= dt;
        if (h.timer <= 0) {
          h.phase = "telegraph";
          h.tele = TELE;
          h.type = pickHazType(r.hazard, h.count);
          h.pawAngle = run.rng() * TAU;   // paw swipes in from a fresh random direction each strike
          ev.telegraph = true;
          ev.hazType = h.type;
        }
      } else if (h.phase === "telegraph") {
        h.tele -= dt;
        if (h.tele <= 0) {
          h.phase = "idle";
          h.count += 1;
          h.timer = r.every * lerp(0.8, 1.3, run.rng());
          // The strike jolts the rim -- a shot you lined up is suddenly off.
          // Reduced motion keeps the telegraph but drops the disorienting snap.
          if (!reduceMotion && r.jolt) {
            run.notch = normalizeAngle(run.notch + (run.rng() < 0.5 ? -1 : 1) * r.jolt);
            if (r.kibble) run.kibble = normalizeAngle(run.kibble + (run.rng() < 0.5 ? -1 : 1) * r.jolt * 0.5);
          }
          ev.strike = true;
          ev.hazType = h.type;
        }
      }
    }

    if (run.patience <= 0) { run.failed = true; ev.patienceOut = true; }
    return ev;
  }

  // "both" alternates head-lunge and paw so each reads distinctly.
  function pickHazType(hazard, count) {
    if (hazard === "both") return (count % 2 === 0) ? "lunge" : "paw";
    return hazard;
  }

  // Evaluate a tap at the opener's current angle. Mutates run (hits, patience,
  // opened/bonus). Returns:
  //   { tier, points, opened (this tap popped the can?), complete (all cans done?),
  //     hitsDone, hitsNeeded }
  // tier in "perfect" | "good" | "kibble" | "whiff".
  function attempt(run) {
    var c = activeCan(run);
    var r = c.rule;
    var dN = Math.abs(angDiff(run.theta, run.notch));
    var dK = r.kibble ? Math.abs(angDiff(run.theta, run.kibble)) : Infinity;

    var tier, points;
    if (dN <= r.notch * BULLSEYE_FRAC) { tier = "bullseye"; points = BULLSEYE; }
    else if (dN <= r.notch * 0.5) { tier = "perfect"; points = PERFECT; }
    else if (dN <= r.notch) { tier = "good"; points = GOOD; }
    else if (dK <= r.kibble) { tier = "kibble"; points = KIBBLE; }
    else { tier = "whiff"; points = WHIFF; }

    var hit = (tier === "bullseye" || tier === "perfect" || tier === "good");
    if (hit) {
      run.hitsDone += 1;
      var gain = tier === "bullseye" ? PAT_BULLSEYE : (tier === "perfect" ? PAT_PERFECT : PAT_GOOD);
      run.patience = clamp(run.patience + gain, 0, 1);
    } else {
      run.patience = clamp(run.patience + (tier === "kibble" ? PAT_KIBBLE : PAT_WHIFF), 0, 1);
    }

    var opened = false;
    if (hit && run.hitsDone >= r.hits) {
      opened = true;
      points += OPEN_BONUS;
      run.opened += 1;
      run.patience = clamp(run.patience + PAT_OPEN, 0, 1);   // a fed can buys time for the next
    }

    run.bonus += points;
    if (run.patience <= 0) { run.failed = true; }

    return {
      tier: tier,
      points: points,
      opened: opened,
      complete: opened && run.opened >= CANS_GOAL,
      hitsDone: run.hitsDone,
      hitsNeeded: r.hits,
    };
  }

  // Move to the next can. Returns false when the last can is done.
  function nextCan(run) {
    if (run.idx + 1 >= run.cans.length) return false;
    run.idx += 1;
    resetCan(run);
    return true;
  }

  function isComplete(run) { return run.opened >= CANS_GOAL; }

  return {
    TAU: TAU,
    BULLSEYE: BULLSEYE, PERFECT: PERFECT, GOOD: GOOD, KIBBLE: KIBBLE, WHIFF: WHIFF,
    OPEN_BONUS: OPEN_BONUS, BULLSEYE_FRAC: BULLSEYE_FRAC,
    TELE: TELE,
    CANS: CANS,
    CANS_GOAL: CANS_GOAL,
    makeRng: makeRng,
    lerp: lerp,
    clamp: clamp,
    normalizeAngle: normalizeAngle,
    angDiff: angDiff,
    shuffle: shuffle,
    pickCans: pickCans,
    maxScore: maxScore,
    createRun: createRun,
    activeCan: activeCan,
    resetCan: resetCan,
    step: step,
    attempt: attempt,
    nextCan: nextCan,
    isComplete: isComplete,
  };
});
