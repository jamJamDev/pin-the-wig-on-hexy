/*
 * Pin the Wig on Hexy -- post-round-10 pinball bonus phase.
 *
 * After the ten pin-the-wig rounds, the wig becomes a pinball: launch it up a
 * plunger lane and work it with two flippers into the "holder" cup at the top
 * (drawn under Hexy's head). Land it five times. Each successful pin advances to
 * a different table with a different mechanic -- a static wide funnel, a sliding
 * holder, a timed shutter gate, a fart-gust storm, and a moving+shrinking+gated
 * gauntlet. Three balls per table; run out without a capture and the bonus ends.
 *
 * This module is pure and DOM-free: all physics, geometry, the five table
 * definitions, capture/drain detection, and scoring operate on plain objects
 * passed in. Geometry is authored in a normalized table space and projected to
 * pixels by layout(), so it adapts to any canvas size. That keeps the whole
 * core verifiable in Node (see tests/) -- game.js is the thin I/O shell that
 * owns the canvas, input, and audio.
 *
 * Loaded as a plain script in the browser (sets window.PTWOHPinball) and as a
 * CommonJS module in Node tests -- no build step.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.PTWOHPinball = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var TAU = Math.PI * 2;

  // How many captures finish the bonus, and balls allotted per table.
  var CAPTURE_GOAL = 5;
  var BALLS_PER_TABLE = 3;

  // Per-table capture value, indexed by table progression (1st cleared -> 5th).
  // Sums to MAX_PINBALL_SCORE so the bonus is worth exactly the base game when
  // every capture is on the first ball -- see game.js endGame() maxScore.
  var CAPTURE_VALUES = [1000, 1500, 2000, 2500, 3000];
  // Ball-efficiency weighting: capture on ball 1/2/3 pays 100%/80%/60%.
  var BALL_MULT = [1.0, 0.8, 0.6];

  // ---------- Normalized layout constants ----------
  // Table is authored in [0,1] x [0,1]; x is a fraction of table WIDTH, y a
  // fraction of table HEIGHT. Lengths/radii scale with width (rect.w) so
  // circles stay circular in pixels; speeds/gravity scale with height (rect.h)
  // so fall time is size-independent.
  var TABLE_ASPECT = 0.62;        // table width / height (portrait)
  var LEFT_X = 0.04, RIGHT_X = 0.96, TOP_Y = 0.04, BOTTOM_Y = 0.93;
  var LANE_X = 0.85;              // separator between playfield and plunger lane
  var LANE_PARK_X = 0.905, LANE_PARK_Y = 0.88;
  var DRAIN_Y = 0.965;           // ball below this (and live) drains

  // Left kill chute: a narrow channel down the far left. Its inner wall starts at
  // LCHUTE_TOP, leaving a mouth above it; a ball worked left of LCHUTE_X and below
  // the mouth has entered the chute and is lost -- the left-side twin of the lethal
  // right shooter lane.
  var LCHUTE_X = 0.155;          // inner (playfield-side) wall of the chute
  var LCHUTE_TOP = 0.32;         // chute mouth: open above this y

  var BALL_R = 0.030;            // x rect.w
  var BASE_GRAVITY = 1.70;       // x rect.h, px/s^2 (lighter ball / gentler table slant -- easier to loft to the holder)
  var LAUNCH_MIN = 1.9, LAUNCH_MAX = 2.6; // x rect.h, plunger launch speed
  var MAX_SPEED = 3.6;          // x rect.h, hard clamp (correctness guard)
  var CHARGE_TIME = 0.8;        // seconds of hold to full plunger charge

  var FLIPPER_THICK = 0.024;    // x rect.w (collision capsule radius)
  var FLIPPER_SPEED = 24;       // rad/s toward target

  var REST_WALL = 0.74;         // wall restitution
  var REST_BUMPER = 1.18;       // > 1: bumpers add energy
  var REST_FLIPPER = 0.5;       // held flipper catches; moving flipper kicks
  var KICK_FACTOR = 0.95;       // share of flipper surface speed imparted
  var MIN_KICK = 1.35;          // x rect.h, floor kick while actively flipping
  var GUST_ACCEL = 1.7;         // x rect.h, lateral push during a fart gust

  // Two ASYMMETRIC flippers -- deliberately different lengths AND swings so the
  // table plays fun but CLUMSY: floppy, lopsided, imprecise. They are for BATTING
  // the ball, NOT for walling off the drain. The pivots sit closer together than
  // before so the resting tips leave only a tight center gap. Angles in screen
  // space (y down): rest points down toward the center drain; active swings the
  // tip generally up so a flick imparts an upward kick. Geometry (validated in
  // tests/pinball.test.js by simulation):
  //  - At REST the tips leave a center surface gap of ~0.066 -- tighter than
  //    before (was ~0.098) but still wider than the 0.060 ball -- so an UNDEFENDED
  //    ball falls through and drains (no free save).
  //  - Engaging the flippers does NOT permanently wall the center. A HELD flipper
  //    sweeps a full 180 (rest +/- pi); as both tips rotate up and over they open
  //    the center wide. Across that sweep the minimum center surface gap dips below
  //    the ball (down to ~0.030) -- so a clumsy held bat can momentarily block a
  //    ball at the narrowest instant, but it is never a stable seal: a centered
  //    ball still drains because the sweep opens the center as the flippers reach
  //    180. (A lucky clumsy bat can happen; a guaranteed save cannot.)
  //  - Each pivot sits BELOW the funnel-wall line at its x, so the flipper tucks
  //    under the funnel with no under-flipper wedge. The V funnel ends are derived
  //    from the rest tips (flipperRestTipN) so the funnel always meets the tip.
  var FLIPPERS = [
    { side: "left",  px: 0.260, py: 0.86, len: 0.200, rest: 0.530, active: -0.95 },
    { side: "right", px: 0.680, py: 0.86, len: 0.155, rest: 2.850, active: 3.90 }
  ];

  // Normalized rest-tip of a flipper definition (y scaled by aspect to match the
  // width-scaled length). The V funnel walls terminate exactly here.
  function flipperRestTipN(fd) {
    return {
      x: fd.px + Math.cos(fd.rest) * fd.len,
      y: fd.py + Math.sin(fd.rest) * fd.len * TABLE_ASPECT
    };
  }

  // The plunger lane: park point and the straight-up launch direction.
  var PLUNGER = { x: LANE_PARK_X, y: LANE_PARK_Y, dir: -Math.PI / 2 };

  // Shared playfield outline (normalized). The top is solid: the holder cup
  // hangs just below it, so a ball settles into the cup rather than escaping
  // through an opening. The bottom is a forgiving V funnel into a center drain.
  // The plunger lane runs up the right; its angled roof reaches across the full
  // lane width (anchored to the right wall) so a ball launched straight up the
  // lane always strikes it and is redirected down-left into the playfield --
  // the deflection angle is set by the roof slope, so even a soft launch exits
  // the lane rather than rattling back down it.
  function baseWalls() {
    var lt = flipperRestTipN(FLIPPERS[0]);
    var rt = flipperRestTipN(FLIPPERS[1]);
    return [
      { x1: LEFT_X,   y1: TOP_Y,      x2: RIGHT_X,  y2: TOP_Y,    bounce: REST_WALL }, // top (solid)
      { x1: LEFT_X,   y1: TOP_Y,      x2: LEFT_X,   y2: BOTTOM_Y, bounce: REST_WALL }, // far-left / chute outer wall (full height)
      { x1: LCHUTE_X, y1: LCHUTE_TOP, x2: LCHUTE_X, y2: BOTTOM_Y, bounce: REST_WALL }, // kill-chute inner wall (mouth open above LCHUTE_TOP)
      { x1: RIGHT_X,  y1: TOP_Y,      x2: RIGHT_X,  y2: BOTTOM_Y, bounce: REST_WALL }, // right outer wall
      { x1: LANE_X,   y1: 0.34,       x2: LANE_X,   y2: BOTTOM_Y, bounce: REST_WALL }, // lane separator
      { x1: RIGHT_X,  y1: 0.26,       x2: 0.68,     y2: 0.11,     bounce: REST_WALL }, // lane-exit roof: redirects a launched ball left into play
      { x1: 0.68,     y1: 0.11,       x2: 0.68,     y2: TOP_Y,    bounce: REST_WALL }, // roof end-cap: seals the dead pocket above the roof
      { x1: LCHUTE_X, y1: 0.72,       x2: lt.x,     y2: lt.y,     bounce: REST_WALL }, // left V funnel (ends at the left flipper rest tip)
      { x1: LANE_X,   y1: 0.72,       x2: rt.x,     y2: rt.y,     bounce: REST_WALL }  // right V funnel (ends at the right flipper rest tip)
    ];
  }

  // ---------- Table definitions ----------
  // Each table layers a holder, bumpers, optional extra walls, and a rule on top
  // of the shared outline. Coords normalized in [0,1]. The rule.type switch in
  // tickRule/step is what makes each one a different challenge, not a reskin.
  var TABLES = [
    {
      id: "warmup",
      name: "Warm-Up Wiggle",
      hint: "Bounce it up the middle. Try not to overthink it, gamer.",
      gravity: 0.9,
      holder: { x: 0.5, y: 0.17, w: 0.30, h: 0.15, captureSpeed: 0.95 },
      bumpers: [
        { x: 0.38, y: 0.50, r: 0.05, bounce: REST_BUMPER },
        { x: 0.62, y: 0.50, r: 0.05, bounce: REST_BUMPER },
        { x: 0.50, y: 0.38, r: 0.05, bounce: REST_BUMPER }
      ],
      walls: [],
      rule: { type: "static" }
    },
    {
      id: "forehead",
      name: "The Forbidden Forehead",
      hint: "He's sliding now. Lead the shot or kiss that wig goodbye.",
      gravity: 1.0,
      holder: { x: 0.5, y: 0.16, w: 0.19, h: 0.14, captureSpeed: 0.85 },
      bumpers: [
        { x: 0.27, y: 0.62, r: 0.055, bounce: 1.3 },   // slingshots: kick upward
        { x: 0.73, y: 0.62, r: 0.055, bounce: 1.3 }
      ],
      walls: [],
      rule: { type: "moveHolder", amp: 0.26, speed: 1.7 }
    },
    {
      id: "grease",
      name: "Gates of Grease",
      hint: "There's a gate. It opens when it feels like it. Send it through.",
      gravity: 1.05,
      holder: { x: 0.5, y: 0.15, w: 0.20, h: 0.13, captureSpeed: 0.9 },
      bumpers: [
        { x: 0.34, y: 0.60, r: 0.05, bounce: REST_BUMPER },
        { x: 0.66, y: 0.60, r: 0.05, bounce: REST_BUMPER }
      ],
      walls: [],
      rule: { type: "shutter", openMs: 1150, closedMs: 1250 }
    },
    {
      id: "storm",
      name: "Fart Storm",
      hint: "The gusts are diegetic. Launch WITH the fart, not against it.",
      gravity: 1.1,
      lowGravTop: true,
      holder: { x: 0.5, y: 0.14, w: 0.21, h: 0.13, captureSpeed: 1.05 },
      bumpers: [
        { x: 0.40, y: 0.55, r: 0.045, bounce: REST_BUMPER },
        { x: 0.60, y: 0.55, r: 0.045, bounce: REST_BUMPER }
      ],
      walls: [],
      rule: { type: "gust", periodMs: 3600, gustMs: 1300 }
    },
    {
      id: "gauntlet",
      name: "Rat King's Gauntlet",
      hint: "A shrinking hole. A moving skull. A greasy gate. Good luck, Rat King.",
      gravity: 1.15,
      holder: { x: 0.5, y: 0.15, w: 0.22, h: 0.13, captureSpeed: 0.85, minW: 0.13 },
      bumpers: [
        { x: 0.30, y: 0.58, r: 0.05, bounce: 1.25 },
        { x: 0.70, y: 0.58, r: 0.05, bounce: 1.25 },
        { x: 0.50, y: 0.42, r: 0.045, bounce: REST_BUMPER }
      ],
      walls: [],
      rule: { type: "gauntlet", amp: 0.22, speed: 2.0, shrinkMs: 5200, openMs: 1300, closedMs: 1050 }
    }
  ];

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

  // Opener and finale are pinned for a difficulty arc; the middle three shuffle
  // by seed so order varies per playthrough while the ramp roughly holds.
  function pickTables(seed) {
    var middle = [TABLES[1], TABLES[2], TABLES[3]];
    var rng = makeRng((seed >>> 0) || 1);
    for (var i = middle.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var tmp = middle[i]; middle[i] = middle[j]; middle[j] = tmp;
    }
    return [TABLES[0], middle[0], middle[1], middle[2], TABLES[4]];
  }

  // ---------- Geometry helpers ----------
  function px(rect, nx, ny) { return { x: rect.x + nx * rect.w, y: rect.y + ny * rect.h }; }

  // Centered aspect-fit portrait rect inside the view, with a small margin.
  function tableRect(view) {
    var availW = view.w * 0.96;
    var availH = view.h * 0.97;
    var h = availH;
    var w = h * TABLE_ASPECT;
    if (w > availW) { w = availW; h = w / TABLE_ASPECT; }
    return { x: (view.w - w) / 2, y: (view.h - h) / 2, w: w, h: h };
  }

  function closestPointOnSegment(p, a, b) {
    var abx = b.x - a.x, aby = b.y - a.y;
    var len2 = abx * abx + aby * aby;
    var t = len2 > 0 ? ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2 : 0;
    t = clamp(t, 0, 1);
    return { x: a.x + abx * t, y: a.y + aby * t, t: t };
  }

  // Reflect velocity (vx,vy) across a unit normal (nx,ny) with restitution.
  function reflectVel(vx, vy, nx, ny, restitution) {
    var dot = vx * nx + vy * ny;
    return { vx: vx - (1 + restitution) * dot * nx, vy: vy - (1 + restitution) * dot * ny };
  }

  function speedOf(b) { return Math.hypot(b.vx, b.vy); }

  // ---------- Run lifecycle ----------
  function createRun(seed, view) {
    var run = {
      seed: (seed >>> 0) || 1,
      view: view,
      tables: pickTables(seed),
      idx: 0,
      captures: 0,
      balls: BALLS_PER_TABLE,
      ballIndex: 1,        // 1..3, which ball this is (for efficiency scoring)
      score: 0,
      charge: 0,
      rect: null,
      geom: null,
      ball: { x: 0, y: 0, vx: 0, vy: 0, r: 0, live: false, spin: 0 },
      ruleState: null
    };
    layout(run, view);
    resetRuleState(run);
    serveBall(run);
    return run;
  }

  function activeTable(run) { return run.tables[run.idx]; }

  // Project the active table to pixel geometry. Re-derived on every resize; an
  // in-flight ball is rescaled to the new rect so it keeps its place.
  function layout(run, view) {
    run.view = view;
    var prev = run.rect;
    var rect = tableRect(view);
    run.rect = rect;

    var table = activeTable(run);
    var wallsN = baseWalls().concat(table.walls || []);
    var walls = [];
    for (var i = 0; i < wallsN.length; i++) {
      var w = wallsN[i];
      var a = px(rect, w.x1, w.y1), b = px(rect, w.x2, w.y2);
      walls.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, bounce: w.bounce });
    }
    var bumpers = [];
    for (var k = 0; k < table.bumpers.length; k++) {
      var bm = table.bumpers[k];
      var c = px(rect, bm.x, bm.y);
      bumpers.push({ x: c.x, y: c.y, r: bm.r * rect.w, bounce: bm.bounce, flash: 0 });
    }
    var flippers = [];
    for (var f = 0; f < FLIPPERS.length; f++) {
      var fd = FLIPPERS[f];
      var pv = px(rect, fd.px, fd.py);
      // Held target is a FULL 180 flip from rest (rest +/- pi). A tap flicks the
      // flipper up toward the `active` waypoint to bat the ball, then springs back;
      // a hold sweeps the whole 180 arc. Neither permanently walls off the center:
      // the held sweep may pinch narrow for an instant but rotates on to 180,
      // reopening the center so a ball still drains (see FLIPPERS).
      var full = fd.rest + (fd.active >= fd.rest ? 1 : -1) * Math.PI;
      flippers.push({
        side: fd.side, x: pv.x, y: pv.y, len: fd.len * rect.w,
        thick: FLIPPER_THICK * rect.w, rest: fd.rest, active: fd.active, full: full,
        angle: fd.rest, prevAngle: fd.rest, target: fd.rest, angVel: 0
      });
    }
    var pl = px(rect, PLUNGER.x, PLUNGER.y);
    run.geom = {
      walls: walls,
      bumpers: bumpers,
      flippers: flippers,
      plunger: { x: pl.x, y: pl.y, dir: PLUNGER.dir },
      gravity: (table.gravity || 1) * BASE_GRAVITY * rect.h,
      gustAccel: GUST_ACCEL * rect.h,
      holder: holderPx(rect, table.holder),
      ballR: BALL_R * rect.w
    };
    run.ball.r = run.geom.ballR;

    if (prev && run.ball.live && prev.w > 0) {
      run.ball.x = rect.x + (run.ball.x - prev.x) * (rect.w / prev.w);
      run.ball.y = rect.y + (run.ball.y - prev.y) * (rect.h / prev.h);
    } else {
      // No prior rect, a parked ball, or a degenerate 0x0 prev: park at the
      // plunger rather than leave a stale (possibly corner) position.
      run.ball.x = run.geom.plunger.x;
      run.ball.y = run.geom.plunger.y;
    }
  }

  function holderPx(rect, h) {
    return {
      cx: rect.x + h.x * rect.w, cy: rect.y + h.y * rect.h,
      hw: (h.w * rect.w) / 2, hh: (h.h * rect.h) / 2,
      baseHw: (h.w * rect.w) / 2, minHw: ((h.minW || h.w) * rect.w) / 2,
      baseCx: rect.x + h.x * rect.w, captureSpeed: h.captureSpeed * rect.h
    };
  }

  function resetRuleState(run) {
    run.ruleState = {
      t: 0,
      shutterOpen: true,
      gustActive: false,
      gustDir: 1,
      captureOpen: true   // whether the holder currently accepts a capture
    };
  }

  // Park a fresh ball at the plunger; the launch arms when the player charges.
  function serveBall(run) {
    var b = run.ball;
    b.live = false;
    b.vx = 0; b.vy = 0; b.spin = 0;
    b.x = run.geom.plunger.x;
    b.y = run.geom.plunger.y;
    run.charge = 0;
  }

  function chargePlunger(run, dt) {
    run.charge = clamp(run.charge + dt / CHARGE_TIME, 0, 1);
  }

  function launchBall(run) {
    var b = run.ball;
    var rect = run.rect;
    var speed = (LAUNCH_MIN + (LAUNCH_MAX - LAUNCH_MIN) * run.charge) * rect.h;
    b.vx = Math.cos(run.geom.plunger.dir) * speed;
    b.vy = Math.sin(run.geom.plunger.dir) * speed;
    b.live = true;
    run.charge = 0;
  }

  function setFlipper(run, side, down) {
    var fl = run.geom.flippers;
    for (var i = 0; i < fl.length; i++) {
      if (fl[i].side === side) fl[i].target = down ? fl[i].full : fl[i].rest;
    }
  }

  // ---------- Per-rule timing ----------
  function tickRule(run, dt) {
    var table = activeTable(run);
    var rs = run.ruleState;
    var g = run.geom;
    rs.t += dt;
    var type = table.rule.type;

    if (type === "moveHolder" || type === "gauntlet") {
      var amp = table.rule.amp * run.rect.w;
      g.holder.cx = g.holder.baseCx + amp * Math.sin(rs.t * table.rule.speed);
    }
    if (type === "shutter" || type === "gauntlet") {
      var openMs = table.rule.openMs, closedMs = table.rule.closedMs;
      var cycle = openMs + closedMs;
      var phase = (rs.t * 1000) % cycle;
      rs.shutterOpen = phase < openMs;
    } else {
      rs.shutterOpen = true;
    }
    if (type === "gust") {
      var period = table.rule.periodMs / 1000;
      var gustLen = table.rule.gustMs / 1000;
      var ph = rs.t % period;
      rs.gustActive = ph < gustLen;
      // Alternate direction each gust window.
      rs.gustDir = (Math.floor(rs.t / period) % 2 === 0) ? 1 : -1;
    } else {
      rs.gustActive = false;
    }
    if (type === "gauntlet") {
      var sm = table.rule.shrinkMs / 1000;
      // Sawtooth: shrink toward minHw, then snap back wide.
      var frac = (rs.t % sm) / sm;          // 0..1
      g.holder.hw = g.holder.baseHw + (g.holder.minHw - g.holder.baseHw) * frac;
    }
    rs.captureOpen = rs.shutterOpen;
  }

  function integrateFlippers(run, dt) {
    var fl = run.geom.flippers;
    for (var i = 0; i < fl.length; i++) {
      var f = fl[i];
      f.prevAngle = f.angle;
      var diff = f.target - f.angle;
      var step = FLIPPER_SPEED * dt;
      if (Math.abs(diff) <= step) f.angle = f.target;
      else f.angle += (diff > 0 ? step : -step);
      f.angVel = dt > 0 ? (f.angle - f.prevAngle) / dt : 0;
    }
  }

  function flipperTip(f) {
    return { x: f.x + Math.cos(f.angle) * f.len, y: f.y + Math.sin(f.angle) * f.len };
  }

  // ---------- Collision ----------
  function collideWalls(run, ev) {
    var b = run.ball, walls = run.geom.walls;
    for (var i = 0; i < walls.length; i++) {
      var w = walls[i];
      var cp = closestPointOnSegment(b, { x: w.ax, y: w.ay }, { x: w.bx, y: w.by });
      var dx = b.x - cp.x, dy = b.y - cp.y;
      var d = Math.hypot(dx, dy);
      if (d < b.r && d > 1e-6) {
        var nx = dx / d, ny = dy / d;
        b.x = cp.x + nx * b.r;
        b.y = cp.y + ny * b.r;
        var r = reflectVel(b.vx, b.vy, nx, ny, w.bounce);
        b.vx = r.vx; b.vy = r.vy;
        ev.bounced = true;
      }
    }
  }

  function collideBumpers(run, ev) {
    var b = run.ball, bumpers = run.geom.bumpers;
    for (var i = 0; i < bumpers.length; i++) {
      var bm = bumpers[i];
      var dx = b.x - bm.x, dy = b.y - bm.y;
      var d = Math.hypot(dx, dy);
      var min = b.r + bm.r;
      if (d < min && d > 1e-6) {
        var nx = dx / d, ny = dy / d;
        b.x = bm.x + nx * min;
        b.y = bm.y + ny * min;
        var r = reflectVel(b.vx, b.vy, nx, ny, bm.bounce);
        b.vx = r.vx; b.vy = r.vy;
        bm.flash = 1;
        ev.bumper = true;
      }
    }
  }

  function collideFlippers(run, ev) {
    var b = run.ball, fl = run.geom.flippers;
    for (var i = 0; i < fl.length; i++) {
      var f = fl[i];
      var tip = flipperTip(f);
      var cp = closestPointOnSegment(b, { x: f.x, y: f.y }, tip);
      var dx = b.x - cp.x, dy = b.y - cp.y;
      var d = Math.hypot(dx, dy);
      var min = b.r + f.thick;
      if (d < min && d > 1e-6) {
        var nx = dx / d, ny = dy / d;
        b.x = cp.x + nx * min;
        b.y = cp.y + ny * min;
        var rr = reflectVel(b.vx, b.vy, nx, ny, REST_FLIPPER);
        b.vx = rr.vx; b.vy = rr.vy;
        // Impart the flipper's surface speed at the contact point.
        var lever = cp.t * f.len;
        var surf = Math.abs(f.angVel) * lever;
        var moving = Math.abs(f.angVel) > 0.5;
        var kick = surf * KICK_FACTOR;
        if (moving) kick = Math.max(kick, MIN_KICK * run.rect.h);
        b.vx += nx * kick;
        b.vy += ny * kick;
        ev.flipperHit = true;
      }
    }
  }

  // The holder cup: three walls (top + sides, open bottom). When the shutter is
  // closed, a fourth wall seals the mouth so the ball can't enter.
  function collideHolder(run, ev) {
    var b = run.ball, h = run.geom.holder, rs = run.ruleState;
    var l = h.cx - h.hw, rgt = h.cx + h.hw, top = h.cy - h.hh, bot = h.cy + h.hh;
    var segs = [
      [{ x: l, y: top }, { x: rgt, y: top }],
      [{ x: l, y: top }, { x: l, y: bot }],
      [{ x: rgt, y: top }, { x: rgt, y: bot }]
    ];
    if (!rs.shutterOpen) segs.push([{ x: l, y: bot }, { x: rgt, y: bot }]);
    for (var i = 0; i < segs.length; i++) {
      var cp = closestPointOnSegment(b, segs[i][0], segs[i][1]);
      var dx = b.x - cp.x, dy = b.y - cp.y;
      var d = Math.hypot(dx, dy);
      if (d < b.r && d > 1e-6) {
        var nx = dx / d, ny = dy / d;
        b.x = cp.x + nx * b.r;
        b.y = cp.y + ny * b.r;
        var r = reflectVel(b.vx, b.vy, nx, ny, REST_WALL);
        b.vx = r.vx; b.vy = r.vy;
        ev.bounced = true;
      }
    }
  }

  // Capture: ball settled anywhere inside the cup, slow enough, gate open. The
  // catch zone now fills the cup's full width and reaches high under the lid -- a
  // wig lofted into Hexy's cup is slowest at its apex near the top, exactly the
  // band the old tight sweet-spot excluded, so it kept dropping back out uncaught.
  // The speed gate, not a narrow target, is what keeps a fast fly-through from
  // counting. The bottom stays just inside the open mouth so a ball already exiting
  // isn't grabbed on the way down.
  var CATCH_X = 1.0;      // fraction of cup half-width that still catches (full interior)
  var CATCH_TOP = 0.95;   // fraction of half-height above center that still catches
  var CATCH_BOT = 0.9;    // fraction of half-height below center (just inside the mouth)
  function checkCapture(run) {
    var b = run.ball, h = run.geom.holder, rs = run.ruleState;
    if (!rs.captureOpen) return false;
    var insideX = Math.abs(b.x - h.cx) < h.hw * CATCH_X;
    var insideY = b.y > h.cy - h.hh * CATCH_TOP && b.y < h.cy + h.hh * CATCH_BOT;
    return insideX && insideY && speedOf(b) < h.captureSpeed;
  }

  function pointInHolder(run, x, y) {
    var h = run.geom.holder;
    return Math.abs(x - h.cx) < h.hw * CATCH_X &&
      y > h.cy - h.hh * CATCH_TOP && y < h.cy + h.hh * CATCH_BOT;
  }

  // ---------- Step ----------
  function step(run, dt, input) {
    var ev = { bounced: false, bumper: false, captured: false, drained: false, flipperHit: false };
    dt = clamp(dt || 0, 0, 0.05);
    if (dt <= 0) return ev;

    tickRule(run, dt);
    integrateFlippers(run, dt);

    var b = run.ball;
    var bm = run.geom.bumpers;
    for (var i = 0; i < bm.length; i++) if (bm[i].flash > 0) bm[i].flash = Math.max(0, bm[i].flash - dt * 4);

    if (!b.live) {
      if (input && input.launchHeld) chargePlunger(run, dt);
      if (input && input.launchReleased && run.charge > 0.02) launchBall(run);
      if (!b.live) { b.x = run.geom.plunger.x; b.y = run.geom.plunger.y; return ev; }
    }

    var table = activeTable(run);
    var rect = run.rect;
    var rs = run.ruleState;

    // Sub-step so a fast ball can't tunnel through thin geometry.
    var sp = speedOf(b);
    var sub = Math.min(6, Math.max(1, Math.ceil((sp * dt) / (b.r * 0.5))));
    var sdt = dt / sub;
    var maxSpeed = MAX_SPEED * rect.h;

    for (var s = 0; s < sub; s++) {
      // Accelerations.
      var ay = run.geom.gravity;
      var ax = 0;
      var ny = (b.y - rect.y) / rect.h;
      if (table.lowGravTop && ny < 0.42) ay *= 0.28;
      if (rs.gustActive) ax += rs.gustDir * run.geom.gustAccel;
      b.vx += ax * sdt;
      b.vy += ay * sdt;

      b.x += b.vx * sdt;
      b.y += b.vy * sdt;

      collideWalls(run, ev);
      collideHolder(run, ev);
      collideBumpers(run, ev);
      collideFlippers(run, ev);

      // Clamp speed (correctness guard, not a difficulty knob).
      var cs = speedOf(b);
      if (cs > maxSpeed) { b.vx *= maxSpeed / cs; b.vy *= maxSpeed / cs; }

      if (checkCapture(run)) { b.live = false; ev.captured = true; return ev; }
    }

    b.spin += b.vx * 0.0008;

    // Bottom-center drain (the V funnel guides an undefended ball here).
    if (b.y > rect.y + rect.h * DRAIN_Y) { b.live = false; ev.drained = true; return ev; }

    // Left kill chute: worked left of the inner wall and below the mouth -> lost.
    if (b.x < rect.x + LCHUTE_X * rect.w && b.y > rect.y + rect.h * LCHUTE_TOP) {
      b.live = false; ev.drained = true; return ev;
    }

    // Right shooter lane is lethal too: a live ball knocked back down into the
    // plunger/start area (below the park line, descending) is lost. The launch
    // itself rises (vy < 0) up the same lane, so it is never caught here.
    if (b.x > rect.x + LANE_X * rect.w && b.y > rect.y + rect.h * LANE_PARK_Y && b.vy > 0) {
      b.live = false; ev.drained = true; return ev;
    }
    return ev;
  }

  // ---------- Scoring / progression ----------
  // Points for capturing on the current table with the current ball.
  function capturePoints(run) {
    var base = CAPTURE_VALUES[clamp(run.idx, 0, CAPTURE_VALUES.length - 1)];
    var mult = BALL_MULT[clamp(run.ballIndex - 1, 0, BALL_MULT.length - 1)];
    return Math.round(base * mult);
  }

  // Theoretical max pinball score (every capture on ball 1). Feeds endGame()'s
  // combined maxScore so accuracy stays in [0,1].
  function maxScore() {
    var sum = 0;
    for (var i = 0; i < CAPTURE_VALUES.length; i++) sum += CAPTURE_VALUES[i];
    return sum;
  }

  // Record a capture: add points, bump the counter. Returns the points scored.
  function applyCapture(run) {
    var pts = capturePoints(run);
    run.score += pts;
    run.captures += 1;
    return pts;
  }

  // Drop a ball after a drain. Returns balls remaining on the table.
  function loseBall(run) {
    run.balls -= 1;
    run.ballIndex += 1;
    return run.balls;
  }

  // Advance to the next table with a fresh allotment. Returns true if a table
  // remains, false if all five are captured.
  function nextTable(run) {
    run.idx += 1;
    if (run.idx >= run.tables.length) return false;
    run.balls = BALLS_PER_TABLE;
    run.ballIndex = 1;
    layout(run, run.view);
    resetRuleState(run);
    serveBall(run);
    return true;
  }

  function isComplete(run) { return run.captures >= CAPTURE_GOAL; }

  return {
    CAPTURE_GOAL: CAPTURE_GOAL,
    BALLS_PER_TABLE: BALLS_PER_TABLE,
    CAPTURE_VALUES: CAPTURE_VALUES,
    TABLES: TABLES,

    createRun: createRun,
    layout: layout,
    activeTable: activeTable,
    resetRuleState: resetRuleState,
    serveBall: serveBall,
    chargePlunger: chargePlunger,
    launchBall: launchBall,
    setFlipper: setFlipper,
    step: step,
    tickRule: tickRule,

    capturePoints: capturePoints,
    maxScore: maxScore,
    applyCapture: applyCapture,
    loseBall: loseBall,
    nextTable: nextTable,
    isComplete: isComplete,

    // Exposed for tests and the renderer.
    pickTables: pickTables,
    makeRng: makeRng,
    tableRect: tableRect,
    flipperTip: flipperTip,
    closestPointOnSegment: closestPointOnSegment,
    reflectVel: reflectVel,
    pointInHolder: pointInHolder
  };
});
