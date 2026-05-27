"use strict";

(() => {
  const TOTAL_ROUNDS = 10;
  const BEST_KEY = "ptwoh.best";
  const MUTE_KEY = "ptwoh.muted";

  const MOD = window.PTWOHModifiers;
  if (!MOD || typeof MOD.buildPlan !== "function" || typeof MOD.stepHexy !== "function") {
    throw new Error("Pin the Wig on Hexy: src/js/modifiers.js failed to load");
  }

  // Anchor geometry, expressed as fractions of each sprite's own box.
  // Tuned for assets/bald.webp (448x544) + assets/wig.png (497x450).
  // The seat point is deliberately HIGH on his crown -- a perfect pin leaves
  // Hexy's forehead visible (it's a chat in-joke). WIG_ANCHOR.x matches the
  // wig's parting line so a bullseye centers the part on the head.
  // If you swap the art and the wig sits off, nudge these two.
  const HEAD_ANCHOR = { x: 0.48, y: 0.11 }; // crown perch -- high, so the forehead joke stays visible
  const WIG_ANCHOR  = { x: 0.48, y: 0.46 }; // wig's parting line, so a bullseye centers the part on his head

  const SCORE_TIERS = [
    { maxR: 0.5, points: 1000, headline: "BULLSEYE!",  detail: "Pinned it dead center." },
    { maxR: 1.0, points: 650,  headline: "Snug fit!",  detail: "Hexy barely felt a thing." },
    { maxR: 1.7, points: 350,  headline: "It'll do.",  detail: "A little crooked, but on." },
  ];
  const MISS = { points: 0, headline: "Whiff!", detail: "The wig hit nothing but air." };

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const canvas = document.getElementById("stage");
  const ctx = canvas.getContext("2d");

  const el = {
    hud: document.getElementById("hud"),
    round: document.getElementById("hud-round"),
    score: document.getElementById("hud-score"),
    best: document.getElementById("hud-best"),
    timerFill: document.getElementById("hud-timer-fill"),
    mute: document.getElementById("btn-mute"),
    muteGlyph: document.getElementById("mute-glyph"),
    screenStart: document.getElementById("screen-start"),
    screenRound: document.getElementById("screen-round"),
    screenOver: document.getElementById("screen-over"),
    btnStart: document.getElementById("btn-start"),
    btnAgain: document.getElementById("btn-again"),
    btnRoundNext: document.getElementById("btn-round-next"),
    roundHeadline: document.getElementById("round-headline"),
    roundDetail: document.getElementById("round-detail"),
    roundPoints: document.getElementById("round-points"),
    finalScore: document.getElementById("final-score"),
    finalAcc: document.getElementById("final-acc"),
    finalBestRound: document.getElementById("final-best-round"),
    finalVerdict: document.getElementById("final-verdict"),
    finalRecord: document.getElementById("final-record"),
  };

  // ---------- Layout ----------
  const view = { w: 0, h: 0, dpr: 1 };

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    view.dpr = dpr;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const prevW = view.w;
    const prevH = view.h;
    view.w = w;
    view.h = h;

    sizeSprites();
    if (game.state === "playing" && prevW > 0 && prevH > 0) {
      hexy.x *= w / prevW;
      hexy.y *= h / prevH;
      clampHexy();
    }
    // Hexy moved in the rescale -- re-sync the smoothed reticle so it does not
    // glide across the canvas. Offset variations self-absorb the resize.
    if (hexy.w > 0) {
      const ht = headTarget();
      game.aimX = ht.x;
      game.aimY = ht.y;
    }
    parkWig();
  }

  // ---------- Assets ----------
  const sprites = { bald: null, wig: null };

  function loadImage(src, timeout = 6000) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      let done = false;
      const timer = setTimeout(() => {
        if (!done) { done = true; reject(new Error("timeout " + src)); }
      }, timeout);
      img.onload = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        (img.naturalWidth > 0 ? resolve(img) : reject(new Error("empty " + src)));
      };
      img.onerror = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(new Error("error " + src));
      };
      img.src = src;
    });
  }

  async function loadFirst(candidates, fallbackFactory) {
    for (const src of candidates) {
      try { return await loadImage(src); }
      catch (_) { /* try next */ }
    }
    return fallbackFactory();
  }

  function fallbackImage(w, h, draw) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    draw(c.getContext("2d"));
    const img = new Image();
    img.src = c.toDataURL();
    return img;
  }

  function loadAssets() {
    return Promise.all([
      loadFirst(
        ["assets/bald.png", "assets/bald.webp", "assets/bald.jpg", "assets/bald.svg"],
        () => fallbackImage(300, 360, (g) => {
          g.fillStyle = "#f3bd97";
          g.beginPath();
          g.ellipse(150, 168, 92, 130, 0, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = "#3b2a1c";
          g.beginPath(); g.arc(116, 190, 9, 0, 7); g.arc(184, 190, 9, 0, 7); g.fill();
          g.strokeStyle = "#5a2a2a"; g.lineWidth = 6;
          g.beginPath(); g.arc(150, 240, 36, 0.15, Math.PI - 0.15); g.stroke();
        })
      ),
      loadFirst(
        ["assets/wig.png", "assets/wig.webp", "assets/wig.jpg", "assets/wig.svg"],
        () => fallbackImage(320, 240, (g) => {
          g.fillStyle = "#b06bff";
          g.beginPath();
          g.ellipse(160, 120, 130, 96, 0, 0, Math.PI * 2);
          g.fill();
        })
      ),
    ]).then(([bald, wig]) => {
      sprites.bald = bald;
      sprites.wig = wig;
      sizeSprites();
    });
  }

  function sizeSprites() {
    if (!sprites.bald || !sprites.wig) return;
    const base = Math.min(view.w, view.h);
    const bH = Math.max(140, Math.min(base * 0.36, 300));
    const bAspect = sprites.bald.naturalWidth / sprites.bald.naturalHeight;
    hexy.w = bH * bAspect;
    hexy.h = bH;

    const wW = hexy.w * 0.95;
    const wAspect = sprites.wig.naturalHeight / sprites.wig.naturalWidth;
    wig.w = wW;
    wig.h = wW * wAspect;

    game.targetRadius = hexy.w * 0.3;
  }

  // ---------- Entities ----------
  const hexy = { x: 0, y: 0, w: 0, h: 0, vx: 0, vy: 0, wobble: 0, squash: 1, pop: 0 };
  const wig = { x: 0, y: 0, w: 0, h: 0, held: false, stuck: false, sdx: 0, sdy: 0, wob: 0 };
  const pointer = { x: 0, y: 0 };

  const game = {
    state: "loading", // loading | start | playing | roundEnd | gameOver
    round: 0,
    score: 0,
    best: 0,
    bestRound: 0,
    targetRadius: 80,
    roundTime: 0,
    roundClock: 0,
    lockT: 0,        // post-pin canvas celebration timer
    cardT: 0,        // result-card display timer
    advancing: false,
    shake: 0,
    lastTick: 0,
    seed: 0,         // per-playthrough seed driving the variation plan
    baseSpeed: 1,    // current round's nominal speed
    modifierPlan: null,    // full 10-round movement-variation plan
    activeModifiers: null, // cumulative variations active this round
    aimX: 0,         // smoothed reticle target (what the player aims at)
    aimY: 0,
  };

  const confetti = [];

  // Reused per-frame movement state handed to the modifier subsystem.
  const moveSim = {
    hexy: null, view: null, baseSpeed: 1, round: 0,
    activeModifiers: null, state: "", bounceX: 0, bounceY: 0,
  };

  function headTarget() {
    return {
      x: hexy.x + hexy.w * HEAD_ANCHOR.x,
      y: hexy.y + hexy.h * HEAD_ANCHOR.y,
    };
  }

  function clampHexy() {
    hexy.x = Math.max(0, Math.min(view.w - hexy.w, hexy.x));
    hexy.y = Math.max(0, Math.min(view.h - hexy.h, hexy.y));
  }

  function parkWig() {
    if (wig.held || wig.stuck) return;
    wig.x = view.w / 2 - wig.w / 2;
    wig.y = view.h - wig.h * 0.92;
  }

  // ---------- Audio ----------
  let audioCtx = null;
  let muted = localStorage.getItem(MUTE_KEY) === "1";

  function refreshMuteUI() {
    el.muteGlyph.innerHTML = muted ? "&#128263;" : "&#128266;";
    el.mute.classList.toggle("muted", muted);
  }

  function beep(freq, dur, type = "sine", gain = 0.18) {
    if (muted) return;
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audioCtx = new AC();
    }
    if (audioCtx.state === "suspended") audioCtx.resume();
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  function chord(freqs, dur, type = "triangle") {
    freqs.forEach((f, i) => setTimeout(() => beep(f, dur, type, 0.14), i * 70));
  }

  // ---------- Game flow ----------
  function startGame() {
    if (game.state !== "start" && game.state !== "gameOver") return;
    game.round = 0;
    game.score = 0;
    game.bestRound = 0;
    game.seed = (((Date.now() & 0xffffffff) ^ ((Math.random() * 0xffffffff) | 0)) >>> 0) || 1;
    game.modifierPlan = MOD.buildPlan(game.seed);
    game.activeModifiers = [];
    moveSim.bounceX = 0;
    moveSim.bounceY = 0;
    confetti.length = 0;
    show(el.screenStart, false);
    show(el.screenOver, false);
    el.hud.classList.remove("hidden");
    el.hud.setAttribute("aria-hidden", "false");
    nextRound();
  }

  function nextRound() {
    game.round += 1;
    game.state = "playing";
    game.advancing = false;
    wig.held = false;
    wig.stuck = false;
    game.lockT = 0;
    game.cardT = 0;

    const base = Math.min(view.w, view.h);
    // Speed ramps with the round; the stacking variations carry the rest of
    // the difficulty. Round 1 is slow and calm, round 10 is fast.
    const speed = base * (0.30 + game.round * 0.105);
    game.baseSpeed = speed;
    const roundRng = MOD.makeRng((((game.seed ^ 0x9e3779b9) + game.round * 0x85ebca6b) >>> 0) || 1);
    const ang = roundRng() * Math.PI * 2;
    hexy.x = view.w / 2 - hexy.w / 2;
    hexy.y = view.h * 0.34 - hexy.h / 2;
    hexy.vx = Math.cos(ang) * speed;
    hexy.vy = Math.sin(ang) * speed * 0.7;
    hexy.wobble = 0;
    hexy.squash = 1;
    hexy.pop = 0;
    moveSim.bounceX = 0;
    moveSim.bounceY = 0;
    clampHexy();

    game.roundTime = Math.max(4.5, 9 - (game.round - 1) * 0.4);
    game.roundClock = game.roundTime;

    // Cumulative variation stack: round N runs the first N plan entries.
    game.activeModifiers = MOD.resetPlanForRound(game.modifierPlan, game.round, game.seed);

    const ht = headTarget();
    game.aimX = ht.x;
    game.aimY = ht.y;

    parkWig();
    updateHud();
    show(el.screenRound, false);
  }

  // Direction-specific roast for non-bullseye, non-whiff hits, so the player
  // knows which way to correct on the next round. Bullseye keeps its
  // celebratory detail; a whiff keeps its "hit air" line.
  function directionalRoast(dx, dy) {
    if (Math.abs(dy) >= Math.abs(dx)) {
      return dy > 0
        ? "Too low -- Hexy's forehead is bigger than that."
        : "Too high -- that wig's floating.";
    }
    return dx > 0 ? "Off to the right." : "Off to the left.";
  }

  function evaluatePin() {
    const ht = { x: game.aimX, y: game.aimY };
    const wax = wig.x + wig.w * WIG_ANCHOR.x;
    const way = wig.y + wig.h * WIG_ANCHOR.y;
    const dx = wax - ht.x;
    const dy = way - ht.y;
    const dist = Math.hypot(dx, dy);
    const ratio = dist / game.targetRadius;

    let tier = MISS;
    for (const t of SCORE_TIERS) {
      if (ratio <= t.maxR) { tier = t; break; }
    }

    const bullseye = tier === SCORE_TIERS[0];
    if (tier !== MISS && !bullseye) {
      tier = Object.assign({}, tier, { detail: directionalRoast(dx, dy) });
    }

    finishRound(tier, tier !== MISS);
  }

  function finishRound(tier, hit) {
    game.state = "roundEnd";
    game.score += tier.points;
    game.bestRound = Math.max(game.bestRound, tier.points);
    updateHud();

    if (hit) {
      wig.stuck = true;
      wig.held = false;
      wig.sdx = wig.x - hexy.x;
      wig.sdy = wig.y - hexy.y;
      hexy.pop = 1;
      spawnConfetti(tier.points >= 1000 ? 1 : 0.6);
      if (tier.points >= 1000) chord([523, 659, 784, 1046], 0.22);
      else beep(tier.points >= 650 ? 660 : 520, 0.16, "triangle", 0.2);
    } else {
      wig.held = false;
      game.shake = reduceMotion ? 0 : 14;
      beep(150, 0.26, "sawtooth", 0.16);
    }

    el.roundHeadline.textContent = tier.headline;
    el.roundDetail.textContent = tier.detail;
    el.roundPoints.textContent = "+" + tier.points;
    el.roundPoints.style.color = hit ? "var(--accent)" : "var(--warn)";

    game.lockT = hit ? 1.15 : 0.85;
  }

  function showRoundCard() {
    game.state = "roundCard";
    game.cardT = 4;  // long enough to read the directional roast; Next button or any tap exits early
    show(el.screenRound, true);
  }

  function proceed() {
    if (game.advancing) return;
    game.advancing = true;
    show(el.screenRound, false);
    if (game.round >= TOTAL_ROUNDS) endGame();
    else nextRound();
  }

  function endGame() {
    game.state = "gameOver";
    el.hud.classList.add("hidden");
    el.hud.setAttribute("aria-hidden", "true");

    const acc = Math.round((game.score / (TOTAL_ROUNDS * 1000)) * 100);
    let verdict;
    if (acc >= 90) verdict = "Master Wig Technician.";
    else if (acc >= 70) verdict = "Hexy looks fabulous.";
    else if (acc >= 45) verdict = "Patchy — but he'll take it.";
    else if (acc >= 20) verdict = "Mostly forehead, honestly.";
    else verdict = "Did you even aim?";

    const newRecord = game.score > game.best;
    if (newRecord) {
      game.best = game.score;
      try { localStorage.setItem(BEST_KEY, String(game.best)); } catch (_) {}
    }

    el.finalScore.textContent = game.score;
    el.finalAcc.textContent = acc + "%";
    el.finalBestRound.textContent = game.bestRound;
    el.finalVerdict.textContent = verdict;
    show(el.finalRecord, newRecord);
    show(el.screenOver, true);
    chord(newRecord ? [523, 659, 784, 1046, 1318] : [392, 523, 659], 0.26);
  }

  function spawnConfetti(intensity) {
    if (reduceMotion) return;
    const ht = headTarget();
    const n = Math.round(70 * intensity);
    const palette = ["#b06bff", "#ff5fa2", "#41e0a3", "#ffc24b", "#ffffff"];
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 120 + Math.random() * 320;
      confetti.push({
        x: ht.x, y: ht.y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 160,
        life: 1,
        size: 4 + Math.random() * 6,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 12,
        color: palette[(Math.random() * palette.length) | 0],
      });
    }
  }

  // ---------- Update ----------
  function update(dt) {
    if (game.state === "playing") {
      game.roundClock -= dt;
      const frac = Math.max(0, game.roundClock / game.roundTime);
      el.timerFill.style.transform = "scaleX(" + frac + ")";
      el.timerFill.style.background = frac < 0.3
        ? "linear-gradient(90deg,#ff5fa2,#ffc24b)"
        : "linear-gradient(90deg,#41e0a3,#ffc24b)";
      if (game.roundClock <= 0) { evaluatePinTimeout(); return; }

      moveHexy(dt, 1);

      if (wig.held) {
        wig.x = pointer.x - wig.w * WIG_ANCHOR.x;
        wig.y = pointer.y - wig.h * WIG_ANCHOR.y;
        wig.wob = Math.sin(performance.now() / 110) * 0.05;
      } else {
        wig.wob = Math.sin(performance.now() / 380) * 0.04;
      }
    } else if (game.state === "roundEnd") {
      moveHexy(dt, 0.55);
      if (wig.stuck) { wig.x = hexy.x + wig.sdx; wig.y = hexy.y + wig.sdy; }
      game.lockT -= dt;
      if (game.lockT <= 0) showRoundCard();
    } else if (game.state === "roundCard") {
      moveHexy(dt, 0.4);
      if (wig.stuck) { wig.x = hexy.x + wig.sdx; wig.y = hexy.y + wig.sdy; }
      game.cardT -= dt;
      if (game.cardT <= 0) proceed();
    }

    if (hexy.w > 0 &&
        (game.state === "playing" || game.state === "roundEnd" || game.state === "roundCard")) {
      const ht = headTarget();
      const s = Math.min(1, dt * 14);
      game.aimX += (ht.x - game.aimX) * s;
      game.aimY += (ht.y - game.aimY) * s;
    }

    if (hexy.pop > 0) hexy.pop = Math.max(0, hexy.pop - dt * 3.2);
    hexy.squash += (1 - hexy.squash) * Math.min(1, dt * 12);
    if (game.shake > 0) game.shake = Math.max(0, game.shake - dt * 60);

    for (let i = confetti.length - 1; i >= 0; i--) {
      const p = confetti[i];
      p.vy += 620 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      p.life -= dt * 0.62;
      if (p.life <= 0 || p.y > view.h + 40) confetti.splice(i, 1);
    }
  }

  function evaluatePinTimeout() {
    if (wig.held) { wig.held = false; }
    finishRound(MISS, false);
  }

  function moveHexy(dt, speedScale) {
    moveSim.hexy = hexy;
    moveSim.view = view;
    moveSim.baseSpeed = game.baseSpeed;
    moveSim.round = game.round;
    moveSim.activeModifiers = game.activeModifiers;
    moveSim.state = game.state;
    const r = MOD.stepHexy(moveSim, dt, speedScale, reduceMotion);
    if (r.bounced) bounceSquash();
  }

  function bounceSquash() {
    if (!reduceMotion) hexy.squash = 0.82;
  }

  // ---------- Render ----------
  function render() {
    ctx.clearRect(0, 0, view.w, view.h);
    ctx.save();
    if (game.shake > 0) {
      ctx.translate((Math.random() - 0.5) * game.shake, (Math.random() - 0.5) * game.shake);
    }

    drawSpotlight();

    if (game.state === "playing" || game.state === "roundEnd" || game.state === "roundCard") {
      drawWarpTelegraph();
      drawHexy();
      drawReticle();  // on top of Hexy so it stays visible when he bounces over it
      drawWig();
    }

    drawConfetti();
    ctx.restore();
  }

  function drawSpotlight() {
    if (!hexy.w) return;
    const cx = hexy.x + hexy.w / 2;
    const cy = hexy.y + hexy.h / 2;
    const r = hexy.w * 1.5;
    const grd = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r);
    grd.addColorStop(0, "rgba(176,107,255,0.22)");
    grd.addColorStop(1, "rgba(176,107,255,0)");
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, view.w, view.h);
  }

  function drawReticle() {
    if (game.state !== "playing" && wig.stuck) return;
    const ht = { x: game.aimX, y: game.aimY };
    const pulse = 1 + Math.sin(performance.now() / 240) * 0.12;
    const r = game.targetRadius * pulse;
    ctx.save();
    ctx.strokeStyle = "rgba(65,224,163,0.85)";
    ctx.lineWidth = 3;
    ctx.setLineDash([8, 9]);
    ctx.beginPath();
    ctx.arc(ht.x, ht.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    ctx.lineWidth = 2;
    const c = 9;
    ctx.beginPath();
    ctx.moveTo(ht.x - c, ht.y); ctx.lineTo(ht.x + c, ht.y);
    ctx.moveTo(ht.x, ht.y - c); ctx.lineTo(ht.x, ht.y + c);
    ctx.stroke();
    ctx.restore();
  }

  function drawHexy() {
    if (!sprites.bald) return;
    const cx = hexy.x + hexy.w / 2;
    const cy = hexy.y + hexy.h / 2;
    const pop = 1 + hexy.pop * 0.12;
    const sx = (2 - hexy.squash) * pop;
    const sy = hexy.squash * pop;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(sx, sy);
    ctx.drawImage(sprites.bald, -hexy.w / 2, -hexy.h / 2, hexy.w, hexy.h);
    ctx.restore();
  }

  function drawWig() {
    if (!sprites.wig) return;
    const cx = wig.x + wig.w / 2;
    const cy = wig.y + wig.h / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(wig.stuck ? 0 : wig.wob);
    if (wig.held && !reduceMotion) {
      ctx.shadowColor = "rgba(0,0,0,0.45)";
      ctx.shadowBlur = 22;
      ctx.shadowOffsetY = 14;
    }
    ctx.drawImage(sprites.wig, -wig.w / 2, -wig.h / 2, wig.w, wig.h);
    ctx.restore();
  }

  function drawConfetti() {
    for (const p of confetti) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      ctx.restore();
    }
  }

  // A faint ghost of Hexy at the spot the warp variation is about to blink to
  // -- a fairness tell so a teleport never feels cheap.
  function drawWarpTelegraph() {
    if (game.state !== "playing" || !game.activeModifiers || !sprites.bald) return;
    for (const e of game.activeModifiers) {
      if (e.key !== "warp" || e.runtime.telegraph <= 0) continue;
      const prog = 1 - e.runtime.telegraph / e.params.telegraphTime;
      ctx.save();
      ctx.globalAlpha = 0.12 + 0.3 * prog;
      ctx.drawImage(sprites.bald, e.runtime.pendingX, e.runtime.pendingY, hexy.w, hexy.h);
      ctx.restore();
    }
  }

  // ---------- Loop ----------
  function frame(now) {
    const dt = Math.min(0.05, (now - game.lastTick) / 1000) || 0;
    game.lastTick = now;
    if (game.state !== "loading") update(dt);
    render();
    requestAnimationFrame(frame);
  }

  // ---------- Input ----------
  function localPoint(e) {
    const r = canvas.getBoundingClientRect();
    pointer.x = e.clientX - r.left;
    pointer.y = e.clientY - r.top;
  }

  function onDown(e) {
    if (game.state !== "playing" || wig.stuck) return;
    e.preventDefault();
    localPoint(e);
    wig.held = true;
    canvas.classList.add("grabbing");
    if (canvas.setPointerCapture && e.pointerId != null) {
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    }
    beep(420, 0.07, "square", 0.1);
  }

  function onMove(e) {
    if (!wig.held) return;
    localPoint(e);
  }

  function onUp(e) {
    if (!wig.held || game.state !== "playing") return;
    e.preventDefault();
    localPoint(e);
    wig.held = false;
    canvas.classList.remove("grabbing");
    evaluatePin();
  }

  canvas.addEventListener("pointerdown", onDown);
  window.addEventListener("pointerdown", () => {
    if (game.state === "roundCard") proceed();
  });
  window.addEventListener("pointermove", onMove, { passive: false });
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", () => {
    if (wig.held) { wig.held = false; canvas.classList.remove("grabbing"); }
  });

  el.btnStart.addEventListener("click", startGame);
  el.btnAgain.addEventListener("click", startGame);
  el.btnRoundNext.addEventListener("click", proceed);
  el.mute.addEventListener("click", () => {
    muted = !muted;
    try { localStorage.setItem(MUTE_KEY, muted ? "1" : "0"); } catch (_) {}
    refreshMuteUI();
    if (!muted) beep(660, 0.08, "triangle", 0.15);
  });

  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" || e.code === "Enter") {
      if (game.state === "start") { e.preventDefault(); startGame(); }
      else if (game.state === "gameOver") { e.preventDefault(); startGame(); }
      else if (game.state === "roundCard") { e.preventDefault(); proceed(); }
    }
  });

  window.addEventListener("resize", resize);

  // ---------- Helpers ----------
  function show(node, visible) {
    node.classList.toggle("hidden", !visible);
  }

  function updateHud() {
    el.round.textContent = game.round + " / " + TOTAL_ROUNDS;
    el.score.textContent = game.score;
    el.best.textContent = game.best;
  }

  // ---------- Boot ----------
  function boot() {
    resize();
    try { game.best = parseInt(localStorage.getItem(BEST_KEY), 10) || 0; } catch (_) {}
    refreshMuteUI();
    updateHud();
    loadAssets().then(() => {
      game.state = "start";
      parkWig();
    });
    requestAnimationFrame(frame);
  }

  boot();
})();
