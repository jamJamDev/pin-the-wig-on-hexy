/*
 * Pin the Wig on Hexy -- stacking movement-variation subsystem.
 *
 * Ten movement "variations" for Hexy. Each round introduces one; every
 * variation introduced so far stays active, so they STACK -- by round 10 all
 * ten run at once. A per-game seed fixes which variation maps to which round
 * and freezes each one's control parameters, so a playthrough is internally
 * consistent while every new game feels different.
 *
 * This module is pure and DOM-free: every function operates on plain objects
 * passed in. That keeps the whole movement core verifiable in Node (see
 * tests/) -- game.js is the thin I/O shell that owns the canvas and input.
 *
 * Loaded as a plain script in the browser (sets window.PTWOHModifiers) and as
 * a CommonJS module in Node tests -- no build step.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.PTWOHModifiers = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var TAU = Math.PI * 2;

  // Global per-round difficulty ramp endpoints. roundRamp(round) scales EVERY
  // active variation: round 1 barely registers, round 10 is the brutal wall.
  // This -- not per-variation age -- drives a smooth, progressive escalation
  // instead of a flat "medium, medium, medium, super-hard" curve.
  var RAMP_MIN = 0.16;
  var RAMP_MAX = 1.7;

  // Center bias: a restoring push toward mid-arena so Hexy never parks in a
  // corner. No pull inside the central CENTER_DEADZONE band; beyond it the
  // push ramps quadratically, strongest at the wall.
  var CENTER_DEADZONE = 0.4;
  var CENTER_PULL = 7.0;

  // Speed clamp bounds, as fractions of the round's base speed. Correctness
  // guards, not difficulty knobs: they stop the stack from freezing Hexy
  // permanently or launching him off-screen.
  var MIN_SPEED_FRAC = 0.25;
  var MAX_SPEED_FRAC = 2.2;

  // Hard per-frame displacement cap, as a fraction of the smaller view axis.
  // Neutralizes multiplicative stacking blow-ups regardless of which
  // variations are active. Warp teleports bypass it (they have their own
  // safe-rect clamp).
  var MAX_STEP_FRAC = 0.12;

  // ---------- Helpers ----------

  // mulberry32 -- a tiny, fast, well-distributed seeded PRNG. Deterministic
  // across browsers and Node, so a seed reproduces an entire playthrough.
  function makeRng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  // Linear difficulty ramp across the 10 rounds: round 1 -> RAMP_MIN,
  // round 10 -> RAMP_MAX. Out-of-range rounds clamp to the endpoints.
  function roundRamp(round) {
    var r = round < 1 ? 1 : round > 10 ? 10 : round;
    return RAMP_MIN + (RAMP_MAX - RAMP_MIN) * ((r - 1) / 9);
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  // Fisher-Yates. Returns a new array; does not mutate the input.
  function shuffle(arr, rng) {
    var out = arr.slice();
    for (var i = out.length - 1; i > 0; i--) {
      var j = (rng() * (i + 1)) | 0;
      var tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }

  // 0.2..1 factor that fades an offset variation as Hexy nears a wall, so
  // orbit/jitter ride the edge instead of fighting the bounds clamp.
  function wallMargin(hexy, view) {
    var m = Math.max(1, hexy.w * 0.6);
    var dx = Math.min(hexy.x, view.w - hexy.w - hexy.x);
    var dy = Math.min(hexy.y, view.h - hexy.h - hexy.y);
    return clamp(Math.min(dx, dy) / m, 0.2, 1);
  }

  // Restoring push (as a fraction of base speed) that keeps Hexy weighted
  // toward the arena center along one axis. Zero inside the deadzone, then a
  // quadratic ramp pointing back to center, strongest at the wall.
  function centerBias(pos, size) {
    if (size <= 0) return 0;
    var f = (pos - size * 0.5) / (size * 0.5);
    var a = f < 0 ? -f : f;
    if (a <= CENTER_DEADZONE) return 0;
    var t = (a - CENTER_DEADZONE) / (1 - CENTER_DEADZONE);
    return (f < 0 ? 1 : -1) * t * t * CENTER_PULL;
  }

  // Re-seed a per-(modifier,round) RNG stream for event-based variations
  // (swerve kicks, warp destinations) so their events are reproducible.
  function streamRng(seed, salt, introRound, round) {
    return makeRng(
      (((seed ^ salt) + introRound * 0x2545f491 + round * 0x9e3779b1) >>> 0) || 1
    );
  }

  // Pick warp's next teleport destination -- a short blink within `range`,
  // clamped into a safe inset rect so Hexy never warps into a wall.
  function warpDest(p, rt, hexy, view, eff) {
    var margin = hexy.w * 0.5;
    var ang = rt.rng() * TAU;
    // Longer blinks as the difficulty ramp climbs.
    var reach = p.range * lerp(0.7, 1.35, clamp(eff, 0.2, RAMP_MAX) / RAMP_MAX);
    var dist = lerp(0.5, 1.0, rt.rng()) * reach * Math.min(view.w, view.h);
    var px = clamp(hexy.x + Math.cos(ang) * dist, margin, Math.max(margin, view.w - hexy.w - margin));
    var py = clamp(hexy.y + Math.sin(ang) * dist, margin, Math.max(margin, view.h - hexy.h - margin));
    // Bias the blink toward mid-arena so a teleport never strands Hexy on a wall.
    rt.pendingX = lerp(px, view.w * 0.5 - hexy.w * 0.5, 0.3);
    rt.pendingY = lerp(py, view.h * 0.5 - hexy.h * 0.5, 0.3);
  }

  // ---------- The ten variations ----------
  //
  // Each variation declares:
  //   phase     -- when it runs: heading | speedMul | speedGate | offset | warp
  //   tier      -- gentle (rounds 1-4) or spicy (rounds 5-10)
  //   roll(rng)            -> frozen control params (its "brand of randomness")
  //   initRuntime()        -> fresh mutable state object
  //   resetRuntime(rt,p,e,seed,round) -> zero clocks/timers at a round start
  //   apply(ctx,p,rt,dt,eff)          -> mutate ctx for one frame
  //   rmDamp / rmApply / rmDisable    -> prefers-reduced-motion behaviour

  var MODIFIERS = {
    // 1. drift -- heading sways on a bounded sine. Slow, smooth, predictable.
    drift: {
      key: "drift", phase: "heading", tier: "gentle", rmDamp: 0.6,
      roll: function (rng) {
        return {
          baseIntensity: lerp(0.75, 1.0, rng()),
          amp: lerp(0.2, 0.5, rng()),
          period: lerp(2.2, 4.6, rng()),
          phase0: rng() * TAU,
        };
      },
      initRuntime: function () { return { phase: 0 }; },
      resetRuntime: function (rt, p) { rt.phase = p.phase0; },
      apply: function (ctx, p, rt, dt, eff) {
        rt.phase += dt * (TAU / p.period);
        ctx.heading += Math.sin(rt.phase) * p.amp * eff;
      },
    },

    // 2. pulse -- speed breathes up and down sinusoidally.
    pulse: {
      key: "pulse", phase: "speedMul", tier: "gentle", rmDamp: 0.5,
      roll: function (rng) {
        return {
          baseIntensity: lerp(0.75, 1.0, rng()),
          depth: lerp(0.28, 0.58, rng()),
          period: lerp(0.7, 1.8, rng()),
          phase0: rng() * TAU,
        };
      },
      initRuntime: function () { return { phase: 0 }; },
      resetRuntime: function (rt, p) { rt.phase = p.phase0; },
      apply: function (ctx, p, rt, dt, eff) {
        rt.phase += dt * (TAU / p.period);
        ctx.speed *= Math.max(0.05, 1 + p.depth * eff * Math.sin(rt.phase));
      },
    },

    // 3. spiral -- heading rotates at a constant rate; Hexy curls into loops.
    spiral: {
      key: "spiral", phase: "heading", tier: "gentle", rmDamp: 0.5,
      roll: function (rng) {
        return {
          baseIntensity: lerp(0.7, 1.0, rng()),
          rotSpeed: lerp(0.6, 1.7, rng()),
          dir: rng() < 0.5 ? -1 : 1,
        };
      },
      initRuntime: function () { return { angle: 0 }; },
      resetRuntime: function (rt) { rt.angle = 0; },
      apply: function (ctx, p, rt, dt, eff) {
        // ctx.heading is rebuilt from the base velocity every frame, so the
        // rotation has to accumulate in runtime to actually curl into loops.
        rt.angle += p.rotSpeed * p.dir * dt;
        ctx.heading += rt.angle * eff;
      },
    },

    // 4. orbit -- a circular positional offset added on top of the base path.
    // The previous offset is subtracted each frame so it never accumulates.
    orbit: {
      key: "orbit", phase: "offset", tier: "gentle", rmDamp: 0.5,
      roll: function (rng) {
        return {
          baseIntensity: lerp(0.7, 1.0, rng()),
          radius: lerp(0.06, 0.15, rng()),
          angSpeed: lerp(1.4, 3.4, rng()),
          dir: rng() < 0.5 ? -1 : 1,
          phase0: rng() * TAU,
        };
      },
      initRuntime: function () { return { phase: 0, prevX: 0, prevY: 0, lastMin: 0 }; },
      resetRuntime: function (rt, p) {
        rt.phase = p.phase0; rt.prevX = 0; rt.prevY = 0; rt.lastMin = 0;
      },
      apply: function (ctx, p, rt, dt, eff) {
        var vmin = Math.min(ctx.view.w, ctx.view.h);
        // A viewport resize rescales the offset's pixel magnitude -- rescale
        // the stored previous offset so the delta absorbs it instead of
        // teleporting Hexy by the size change.
        if (rt.lastMin > 0 && rt.lastMin !== vmin) {
          var f = vmin / rt.lastMin;
          rt.prevX *= f;
          rt.prevY *= f;
        }
        rt.lastMin = vmin;
        rt.phase += dt * p.angSpeed * p.dir;
        var r = p.radius * eff * vmin * wallMargin(ctx.hexy, ctx.view);
        var ox = Math.cos(rt.phase) * r;
        var oy = Math.sin(rt.phase) * r;
        ctx.posDX += ox - rt.prevX;
        ctx.posDY += oy - rt.prevY;
        rt.prevX = ox;
        rt.prevY = oy;
      },
    },

    // 5. zigzag -- sharp square-wave heading flips. Substituted with a smooth
    // sway under reduced motion.
    zigzag: {
      key: "zigzag", phase: "heading", tier: "spicy",
      roll: function (rng) {
        return {
          baseIntensity: lerp(0.8, 1.0, rng()),
          period: lerp(0.5, 1.2, rng()),
          theta: lerp(0.35, 0.85, rng()),
        };
      },
      initRuntime: function () { return { clock: 0 }; },
      resetRuntime: function (rt) { rt.clock = 0; },
      apply: function (ctx, p, rt, dt, eff) {
        rt.clock += dt;
        var s = (rt.clock % p.period) < p.period * 0.5 ? 1 : -1;
        ctx.heading += s * p.theta * eff;
      },
      rmApply: function (ctx, p, rt, dt, eff) {
        rt.clock += dt;
        ctx.heading += Math.sin(rt.clock * (TAU / p.period)) * p.theta * eff * 0.7;
      },
    },

    // 6. stutter -- dash/freeze speed gate. Freeze is duration-bounded (never a
    // permanent stop). Substituted with an eased speed ramp under reduced motion.
    stutter: {
      key: "stutter", phase: "speedGate", tier: "spicy",
      roll: function (rng) {
        return {
          baseIntensity: lerp(0.8, 1.0, rng()),
          dashTime: lerp(0.45, 0.95, rng()),
          freezeTime: lerp(0.18, 0.34, rng()),
          dashBoost: lerp(1.5, 2.3, rng()),
          freezeMul: lerp(0.06, 0.14, rng()),
        };
      },
      initRuntime: function () { return { clock: 0 }; },
      resetRuntime: function (rt) { rt.clock = 0; },
      apply: function (ctx, p, rt, dt, eff) {
        rt.clock += dt;
        var cycle = p.dashTime + p.freezeTime;
        var t = rt.clock % cycle;
        var e = Math.min(1.6, eff);
        if (t < p.dashTime) {
          ctx.speed *= 1 + (p.dashBoost - 1) * e;
        } else {
          ctx.speed *= Math.max(0.03, 1 + (p.freezeMul - 1) * e);
        }
      },
      rmApply: function (ctx, p, rt, dt, eff) {
        rt.clock += dt;
        var cycle = p.dashTime + p.freezeTime;
        ctx.speed *= 1 + 0.4 * eff * Math.sin(rt.clock * (TAU / cycle));
      },
    },

    // 7. swerve -- random impulse kicks into a decaying, hard-clamped heading
    // offset. Disabled under reduced motion (sudden kicks are a trigger).
    swerve: {
      key: "swerve", phase: "heading", tier: "spicy", rmDisable: true,
      roll: function (rng) {
        return {
          baseIntensity: lerp(0.8, 1.0, rng()),
          interval: lerp(0.6, 1.4, rng()),
          kick: lerp(0.4, 0.9, rng()),
          decay: lerp(0.12, 0.4, rng()),
        };
      },
      initRuntime: function () { return { offset: 0, timer: 0, rng: makeRng(1) }; },
      resetRuntime: function (rt, p, e, seed, round) {
        rt.offset = 0;
        rt.timer = p.interval;
        rt.rng = streamRng(seed, 0x51ed270b, e.introRound, round);
      },
      apply: function (ctx, p, rt, dt, eff) {
        rt.timer -= dt;
        if (rt.timer <= 0) {
          rt.offset += (rt.rng() < 0.5 ? -1 : 1) * p.kick;
          rt.timer = p.interval * lerp(0.6, 1.4, rt.rng());
        }
        rt.offset *= Math.pow(p.decay, dt);
        rt.offset = clamp(rt.offset, -1.2, 1.2);
        ctx.heading += rt.offset * eff;
      },
    },

    // 8. gravity -- a capped pull toward a slow Lissajous attractor kept in a
    // centre inset rect. Smooth; kept (lightly damped) under reduced motion.
    gravity: {
      key: "gravity", phase: "offset", tier: "spicy", rmDamp: 0.8,
      roll: function (rng) {
        return {
          baseIntensity: lerp(0.7, 1.0, rng()),
          strength: lerp(1.6, 4.0, rng()),
          fx: lerp(0.25, 0.8, rng()),
          fy: lerp(0.25, 0.8, rng()),
          phx: rng() * TAU,
          phy: rng() * TAU,
        };
      },
      initRuntime: function () { return { t: 0, pullVx: 0, pullVy: 0 }; },
      resetRuntime: function (rt) { rt.t = 0; rt.pullVx = 0; rt.pullVy = 0; },
      apply: function (ctx, p, rt, dt, eff) {
        rt.t += dt;
        var view = ctx.view, hexy = ctx.hexy;
        var cx = view.w * 0.5 + Math.sin(rt.t * p.fx + p.phx) * view.w * 0.25;
        var cy = view.h * 0.5 + Math.sin(rt.t * p.fy + p.phy) * view.h * 0.25;
        var dx = cx - (hexy.x + hexy.w * 0.5);
        var dy = cy - (hexy.y + hexy.h * 0.5);
        var d = Math.hypot(dx, dy) || 1;
        var accel = p.strength * eff * ctx.baseSpeed;
        rt.pullVx += (dx / d) * accel * dt;
        rt.pullVy += (dy / d) * accel * dt;
        var pull = Math.hypot(rt.pullVx, rt.pullVy);
        var cap = ctx.baseSpeed * 0.6;
        if (pull > cap) {
          rt.pullVx *= cap / pull;
          rt.pullVy *= cap / pull;
        }
        var bleed = Math.pow(0.4, dt);
        rt.pullVx *= bleed;
        rt.pullVy *= bleed;
        ctx.posDX += rt.pullVx * dt;
        ctx.posDY += rt.pullVy * dt;
      },
    },

    // 9. jitter -- a fast, jagged shake biased perpendicular to Hexy's travel,
    // so he visibly judders sideways as he moves. Disabled under reduced
    // motion (high-frequency motion has no safe damped form).
    jitter: {
      key: "jitter", phase: "offset", tier: "spicy", rmDisable: true,
      roll: function (rng) {
        return {
          baseIntensity: lerp(0.8, 1.0, rng()),
          amplitude: lerp(0.012, 0.03, rng()),
          perpBias: lerp(0.65, 0.95, rng()),
        };
      },
      initRuntime: function () { return { rng: makeRng(1) }; },
      resetRuntime: function (rt, p, e, seed, round) {
        rt.rng = streamRng(seed, 0x27d4eb2f, e.introRound, round);
      },
      apply: function (ctx, p, rt, dt, eff) {
        // dt-normalized to a 60fps reference so the shake is identical on any
        // display (every other timed variation scales with dt).
        var amp = p.amplitude * eff * Math.min(ctx.view.w, ctx.view.h) *
          wallMargin(ctx.hexy, ctx.view) * dt * 60;
        var perp = ctx.heading + Math.PI * 0.5;
        var jp = (rt.rng() * 2 - 1) * amp * p.perpBias;        // sideways jag
        var ja = (rt.rng() * 2 - 1) * amp * (1 - p.perpBias);  // along-track jag
        ctx.posDX += Math.cos(perp) * jp + Math.cos(ctx.heading) * ja;
        ctx.posDY += Math.sin(perp) * jp + Math.sin(ctx.heading) * ja;
      },
    },

    // 10. warp -- telegraphed short teleport blink. Suppressed outside the
    // playing state. Substituted with a fast continuous glide under reduced
    // motion (no disorienting flash).
    warp: {
      key: "warp", phase: "warp", tier: "spicy",
      roll: function (rng) {
        return {
          baseIntensity: lerp(0.85, 1.0, rng()),
          interval: lerp(2.4, 4.4, rng()),
          telegraphTime: lerp(0.34, 0.58, rng()),
          range: lerp(0.28, 0.5, rng()),
        };
      },
      initRuntime: function () {
        return {
          timer: 0, telegraph: 0, pendingX: 0, pendingY: 0,
          gliding: false, glideT: 0, glideFromX: 0, glideFromY: 0, rng: makeRng(1),
        };
      },
      resetRuntime: function (rt, p, e, seed, round) {
        rt.timer = p.interval;
        rt.telegraph = 0;
        rt.gliding = false;
        rt.glideT = 0;
        rt.rng = streamRng(seed, 0x6c8e9cf5, e.introRound, round);
      },
      apply: function (ctx, p, rt, dt, eff) {
        if (ctx.state !== "playing") return;
        if (rt.telegraph > 0) {
          rt.telegraph -= dt;
          if (rt.telegraph <= 0) {
            ctx.warped = true;
            ctx.warpX = rt.pendingX;
            ctx.warpY = rt.pendingY;
          }
          return;
        }
        rt.timer -= dt;
        if (rt.timer <= 0) {
          warpDest(p, rt, ctx.hexy, ctx.view, eff);
          rt.telegraph = p.telegraphTime;
          // Warps fire faster as the ramp climbs -- a flurry of blinks by round 10.
          var pace = lerp(1.45, 0.5, clamp(eff, 0.2, RAMP_MAX) / RAMP_MAX);
          rt.timer = p.interval * pace * lerp(0.7, 1.3, rt.rng());
        }
      },
      rmApply: function (ctx, p, rt, dt, eff) {
        if (ctx.state !== "playing") return;
        if (rt.gliding) {
          rt.glideT += dt;
          var k = Math.min(1, rt.glideT / 0.28);
          var e = k * k * (3 - 2 * k);
          ctx.warped = true;
          ctx.warpX = lerp(rt.glideFromX, rt.pendingX, e);
          ctx.warpY = lerp(rt.glideFromY, rt.pendingY, e);
          if (k >= 1) rt.gliding = false;
          return;
        }
        rt.timer -= dt;
        if (rt.timer <= 0) {
          warpDest(p, rt, ctx.hexy, ctx.view, eff);
          rt.gliding = true;
          rt.glideT = 0;
          rt.glideFromX = ctx.hexy.x;
          rt.glideFromY = ctx.hexy.y;
          var pace = lerp(1.45, 0.5, clamp(eff, 0.2, RAMP_MAX) / RAMP_MAX);
          rt.timer = p.interval * pace * lerp(0.7, 1.3, rt.rng());
        }
      },
    },
  };

  var GENTLE_KEYS = ["drift", "pulse", "spiral", "orbit"];
  var SPICY_KEYS = ["zigzag", "stutter", "swerve", "gravity", "jitter", "warp"];
  var MODIFIER_KEYS = GENTLE_KEYS.concat(SPICY_KEYS);

  // ---------- Plan ----------

  // Build the whole 10-round variation plan from one seed. Gentle variations
  // land in rounds 1-4, spicy in rounds 5-10 -- a monotonic escalation arc
  // that still varies per seed. Each variation's control params are rolled
  // ONCE here and frozen for the playthrough.
  function buildPlan(seed) {
    var rng = makeRng((seed >>> 0) || 1);
    var order = shuffle(GENTLE_KEYS, rng).concat(shuffle(SPICY_KEYS, rng));
    var plan = [];
    for (var i = 0; i < order.length; i++) {
      var mod = MODIFIERS[order[i]];
      plan.push({
        key: order[i],
        mod: mod,
        params: mod.roll(rng),
        runtime: mod.initRuntime(),
        introRound: i + 1,
      });
    }
    return plan;
  }

  // Cumulative active set for a round: the first `round` variations, each with
  // its per-round runtime (phase clocks, timers, RNG streams) reset. Params
  // are untouched, so a variation behaves identically every round it is active.
  function resetPlanForRound(plan, round, seed) {
    var active = plan.slice(0, round);
    for (var i = 0; i < active.length; i++) {
      var e = active[i];
      e.mod.resetRuntime(e.runtime, e.params, e, seed >>> 0, round);
    }
    return active;
  }

  // ---------- Per-frame application ----------

  function runPhase(phase, ctx, active, round, reduceMotion, dt) {
    for (var i = 0; i < active.length; i++) {
      var e = active[i];
      if (e.mod.phase !== phase) continue;
      var eff = e.params.baseIntensity * roundRamp(round);
      var fn = e.mod.apply;
      if (reduceMotion) {
        if (e.mod.rmDisable) continue;
        if (e.mod.rmApply) fn = e.mod.rmApply;
        else if (typeof e.mod.rmDamp === "number") eff *= e.mod.rmDamp;
      }
      fn(ctx, e.params, e.runtime, dt, eff);
    }
  }

  // Run every active variation against a movement context for one frame.
  // Layer order is fixed regardless of plan order: heading shapers, speed
  // multipliers, the correctness speed clamp, the speed gate, positional
  // offsets, then warp.
  function applyModifiers(ctx, active, round, reduceMotion, dt) {
    active = active || [];
    runPhase("heading", ctx, active, round, reduceMotion, dt);
    runPhase("speedMul", ctx, active, round, reduceMotion, dt);
    ctx.speed = clamp(ctx.speed, ctx.baseSpeed * MIN_SPEED_FRAC, ctx.baseSpeed * MAX_SPEED_FRAC);
    runPhase("speedGate", ctx, active, round, reduceMotion, dt);
    runPhase("offset", ctx, active, round, reduceMotion, dt);
    runPhase("warp", ctx, active, round, reduceMotion, dt);
  }

  // Wall handling: flip the (immutable-per-round) base velocity only when it
  // is actually heading into a wall, with a per-axis debounce so an offset
  // variation poking past a wall does not buzz the bounce every frame.
  function bounceWalls(sim, dt) {
    var hexy = sim.hexy, view = sim.view;
    if (sim.bounceX > 0) sim.bounceX -= dt;
    if (sim.bounceY > 0) sim.bounceY -= dt;
    var bounced = false;
    if (hexy.x <= 0 && hexy.vx < 0 && sim.bounceX <= 0) {
      hexy.vx = Math.abs(hexy.vx); sim.bounceX = 0.1; bounced = true;
    } else if (hexy.x + hexy.w >= view.w && hexy.vx > 0 && sim.bounceX <= 0) {
      hexy.vx = -Math.abs(hexy.vx); sim.bounceX = 0.1; bounced = true;
    }
    if (hexy.y <= 0 && hexy.vy < 0 && sim.bounceY <= 0) {
      hexy.vy = Math.abs(hexy.vy); sim.bounceY = 0.1; bounced = true;
    } else if (hexy.y + hexy.h >= view.h && hexy.vy > 0 && sim.bounceY <= 0) {
      hexy.vy = -Math.abs(hexy.vy); sim.bounceY = 0.1; bounced = true;
    }
    return bounced;
  }

  // Advance Hexy one frame: the complete layered movement integration.
  // `sim` carries hexy {x,y,w,h,vx,vy,wobble}, view {w,h}, baseSpeed, round,
  // activeModifiers, state, and the bounce-debounce timers. Mutates sim.hexy
  // and the timers; returns { bounced } so the shell can fire a squash.
  function stepHexy(sim, dt, speedScale, reduceMotion) {
    var hexy = sim.hexy, view = sim.view;
    var wobAmp = Math.min(0.32, 0.06 + sim.round * 0.03);
    hexy.wobble += dt * (2 + sim.round * 0.4);

    var ctx = {
      heading: Math.atan2(hexy.vy, hexy.vx),
      speed: Math.hypot(hexy.vx, hexy.vy),
      posDX: 0, posDY: 0,
      warped: false, warpX: 0, warpY: 0,
      state: sim.state,
      hexy: hexy, view: view, baseSpeed: sim.baseSpeed,
    };
    applyModifiers(ctx, sim.activeModifiers, sim.round, reduceMotion, dt);

    var wvx = Math.cos(ctx.heading) * ctx.speed;
    var wvy = Math.sin(ctx.heading) * ctx.speed;
    // Center bias -- pull Hexy back toward mid-arena so he never corner-parks.
    var cbx = centerBias(hexy.x + hexy.w * 0.5, view.w) * sim.baseSpeed;
    var cby = centerBias(hexy.y + hexy.h * 0.5, view.h) * sim.baseSpeed;
    var dx = (wvx * dt + ctx.posDX + cbx * dt) * speedScale;
    var dy = ((wvy + Math.sin(hexy.wobble) * hexy.h * wobAmp) * dt + ctx.posDY + cby * dt) * speedScale;

    var maxStep = Math.min(view.w, view.h) * MAX_STEP_FRAC;
    var stepLen = Math.hypot(dx, dy);
    if (stepLen > maxStep) {
      var k = maxStep / stepLen;
      dx *= k;
      dy *= k;
    }

    hexy.x += dx;
    hexy.y += dy;
    if (ctx.warped) {
      hexy.x = ctx.warpX;
      hexy.y = ctx.warpY;
    }

    // Correctness fail-safe: never let a NaN strand the game.
    if (!Number.isFinite(hexy.x)) hexy.x = view.w / 2 - hexy.w / 2;
    if (!Number.isFinite(hexy.y)) hexy.y = view.h / 2 - hexy.h / 2;

    var bounced = bounceWalls(sim, dt);
    hexy.x = clamp(hexy.x, 0, Math.max(0, view.w - hexy.w));
    hexy.y = clamp(hexy.y, 0, Math.max(0, view.h - hexy.h));
    return { bounced: bounced };
  }

  return {
    TAU: TAU,
    roundRamp: roundRamp,
    MIN_SPEED_FRAC: MIN_SPEED_FRAC,
    MAX_SPEED_FRAC: MAX_SPEED_FRAC,
    MAX_STEP_FRAC: MAX_STEP_FRAC,
    makeRng: makeRng,
    lerp: lerp,
    clamp: clamp,
    shuffle: shuffle,
    wallMargin: wallMargin,
    MODIFIERS: MODIFIERS,
    MODIFIER_KEYS: MODIFIER_KEYS,
    GENTLE_KEYS: GENTLE_KEYS,
    SPICY_KEYS: SPICY_KEYS,
    buildPlan: buildPlan,
    resetPlanForRound: resetPlanForRound,
    applyModifiers: applyModifiers,
    bounceWalls: bounceWalls,
    stepHexy: stepHexy,
  };
});
