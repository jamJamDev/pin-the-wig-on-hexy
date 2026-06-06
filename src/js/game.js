"use strict";

(() => {
  const TOTAL_ROUNDS = 10;
  const TOTAL_STAGES = 5;
  // Base-game score (70% of a perfect 10-round run) that unlocks the pinball
  // finale. Measured on the ten pin rounds ALONE -- the Feed Molly bonus is a
  // separate pass/fail gate whose points never count toward this threshold.
  const PINBALL_UNLOCK = TOTAL_ROUNDS * 1000 * 0.70;
  // TEMP dev shortcuts for tuning the finale: with "?pinball" in the URL every
  // game start (and "Play Again") drops straight into the pinball bonus; with
  // "?blackjack" it drops straight into the blackjack showdown (as if pinball was
  // already cleared); with "?slots" it drops straight into the slot-machine
  // finale (as if pinball + blackjack were already cleared). Remove these lines
  // and their uses (startGame + boot) when refinement is done.
  const DEV_PINBALL = /[?&#]pinball\b/.test(location.search + location.hash);
  const DEV_BLACKJACK = /[?&#]blackjack\b/.test(location.search + location.hash);
  const DEV_SLOTS = /[?&#]slots\b/.test(location.search + location.hash);
  // "?feedmolly" (or "?molly") drops straight into the Feed Molly bonus for tuning.
  const DEV_FEEDMOLLY = /[?&#](?:feedmolly|molly)\b/.test(location.search + location.hash);
  const BEST_KEY = "ptwoh.best";
  const MUTE_KEY = "ptwoh.muted";
  const LISTENED_KEY = "ptwoh.music.listenedFiles";
  const HEARD_KEY = "ptwoh.voice.heardFiles";
  const ACH_KEY = "ptwoh.achievements";
  const MUSIC_VOL_KEY = "ptwoh.music.vol";
  const INITIALS_KEY = "ptwoh.initials";   // remembered 3-letter tag
  const OWNER_KEY = "ptwoh.ownerToken";    // secret -> proves ownership of this browser's initials
  const LB_API = "api/leaderboard";        // same-origin; served by scripts/dev_server.py
  const DEFAULT_MUSIC_VOL = 0.5;   // radio starts at half volume
  const RADIO_ANCHOR_MS = 0;   // Unix epoch -- shared anchor so every visitor is in sync
  const LIVE_DRIFT_TOLERANCE = 2.0;   // seconds of slack before playback counts as "off air"
  const PREV_RESTART_SEC = 2;  // "prev" restarts the current track if this far in
  const COUNTDOWN_SECONDS = 3; // 3-2-1 at each round start; a voice line plays over it

  const MOD = window.PTWOHModifiers;
  if (!MOD || typeof MOD.buildPlan !== "function" || typeof MOD.stepHexy !== "function") {
    throw new Error("Pin the Wig on Hexy: src/js/modifiers.js failed to load");
  }

  // Core gameplay module: the game-over screen depends on it, so fail loud if
  // it is missing (same posture as MOD; unlike the optional radio/achievements).
  const RANKS = window.PTWOHRanks;
  if (!RANKS || typeof RANKS.rankFor !== "function") {
    throw new Error("Pin the Wig on Hexy: src/js/ranks.js failed to load");
  }

  // Post-round-10 pinball bonus phase. Core to the end-of-run flow, so fail loud
  // if missing (same posture as MOD/RANKS).
  const PINBALL = window.PTWOHPinball;
  if (!PINBALL || typeof PINBALL.createRun !== "function") {
    throw new Error("Pin the Wig on Hexy: src/js/pinball.js failed to load");
  }

  // The God Gamer final boss: blackjack after the pinball finale. The win gate
  // depends on it, so fail loud if missing (same posture as MOD/RANKS/PINBALL).
  const BLACKJACK = window.PTWOHBlackjack;
  if (!BLACKJACK || typeof BLACKJACK.createGame !== "function") {
    throw new Error("Pin the Wig on Hexy: src/js/blackjack.js failed to load");
  }

  // The final gauntlet leg: a slot machine after the blackjack win. The GOD
  // GAMER gate depends on it, so fail loud if missing (same posture as above).
  const SLOT = window.PTWOHSlots;
  if (!SLOT || typeof SLOT.createGame !== "function") {
    throw new Error("Pin the Wig on Hexy: src/js/slots.js failed to load");
  }

  // "Feed Molly" bonus, played after round 10 by players who clear the base
  // qualifier. Its score folds into the run total + accuracy denominator, so
  // fail loud if missing (same posture as above).
  const FEED = window.PTWOHFeedMolly;
  if (!FEED || typeof FEED.createRun !== "function") {
    throw new Error("Pin the Wig on Hexy: src/js/feedmolly.js failed to load");
  }

  // Non-essential extras -- guarded softly so a missing module never breaks the game.
  const RADIO = window.PTWOHRadio || null;
  const ACH = window.PTWOHAchievements || null;
  const LBOARD = window.PTWOHLeaderboard || null;
  const SUBMIT = window.PTWOHSubmission || null;  // signs leaderboard POSTs

  // Anchor geometry, expressed as fractions of each sprite's own box.
  // Tuned for assets/bald_no_bg.png (448x544) + assets/wig.png (497x450).
  // HEAD_ANCHOR is the seat point on Hexy's head -- centered on his forehead
  // (the bald art fills its frame, so these are head-relative directly). The
  // reticle and a pinned wig both land here, so the wig drapes naturally over
  // his scalp. WIG_ANCHOR matches the wig's parting line so a bullseye centers
  // the part on the head. If you swap the art and it sits off, nudge these two.
  const HEAD_ANCHOR = { x: 0.52, y: 0.21 }; // seat slightly up-and-right of forehead center, where a pinned wig looks natural
  const WIG_ANCHOR  = { x: 0.48, y: 0.46 }; // wig's parting line, so a bullseye centers the part on his head

  const SCORE_TIERS = [
    { maxR: 0.5, points: 1000, headline: "BULLSEYE!",  detail: "Pinned it dead center on that big ass forehead." },
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
    roundLabel: document.getElementById("hud-round-label"),
    score: document.getElementById("hud-score"),
    best: document.getElementById("hud-best"),
    timerFill: document.getElementById("hud-timer-fill"),
    stageIndicator: document.getElementById("stage-indicator"),
    stageValue: document.getElementById("stage-indicator-value"),
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
    countdown: document.getElementById("countdown"),
    countNum: document.getElementById("countdown-num"),
    finalRank: document.getElementById("final-rank"),
    finalScore: document.getElementById("final-score"),
    finalAcc: document.getElementById("final-acc"),
    finalBestRound: document.getElementById("final-best-round"),
    finalVerdict: document.getElementById("final-verdict"),
    finalNotGod: document.getElementById("final-notgod"),
    finalRecord: document.getElementById("final-record"),
    finalPinBonus: document.getElementById("final-pin-bonus"),
    finalPinCell: document.getElementById("final-pin-cell"),
    finalBjBonus: document.getElementById("final-bj-bonus"),
    finalBjCell: document.getElementById("final-bj-cell"),
    finalWizard: document.getElementById("final-wizard"),
    finalPrize: document.getElementById("final-prize"),
    // Pinball bonus phase
    screenPinIntro: document.getElementById("screen-pin-intro"),
    pinTableN: document.getElementById("pin-table-n"),
    pinTableName: document.getElementById("pin-table-name"),
    pinTableHint: document.getElementById("pin-table-hint"),
    btnPinStart: document.getElementById("btn-pin-start"),
    pinBanner: document.getElementById("pin-banner"),
    pinBannerText: document.getElementById("pin-banner-text"),
    pinBannerPips: document.getElementById("pin-banner-pips"),
    // Feed Molly bonus phase
    screenFeedIntro: document.getElementById("screen-feed-intro"),
    feedCanN: document.getElementById("feed-can-n"),
    feedCanName: document.getElementById("feed-can-name"),
    feedCanHint: document.getElementById("feed-can-hint"),
    btnFeedStart: document.getElementById("btn-feed-start"),
    // Blackjack finale
    screenBlackjack: document.getElementById("screen-blackjack"),
    bjWig: document.getElementById("bj-wig"),
    bjPipsWin: document.getElementById("bj-pips-win"),
    bjPipsLoss: document.getElementById("bj-pips-loss"),
    bjDealerCards: document.getElementById("bj-dealer-cards"),
    bjDealerTotal: document.getElementById("bj-dealer-total"),
    bjPlayerCards: document.getElementById("bj-player-cards"),
    bjPlayerTotal: document.getElementById("bj-player-total"),
    bjResult: document.getElementById("bj-result"),
    btnBjHit: document.getElementById("btn-bj-hit"),
    btnBjStand: document.getElementById("btn-bj-stand"),
    btnBjNext: document.getElementById("btn-bj-next"),
    // Slot-machine finale
    screenSlots: document.getElementById("screen-slots"),
    slotsWig: document.getElementById("slots-wig"),
    slotsGrid: document.getElementById("slots-grid"),
    slotsCredits: document.getElementById("slots-credits"),
    slotsLines: document.getElementById("slots-lines"),
    slotsBet: document.getElementById("slots-bet"),
    slotsCost: document.getElementById("slots-cost"),
    slotsResult: document.getElementById("slots-result"),
    slotsOverlay: document.getElementById("slots-overlay"),
    slotsWarn: document.getElementById("slots-warn"),
    btnSlotsSpin: document.getElementById("btn-slots-spin"),
    btnSlotsLinesUp: document.getElementById("btn-slots-lines-up"),
    btnSlotsLinesDown: document.getElementById("btn-slots-lines-down"),
    btnSlotsBetUp: document.getElementById("btn-slots-bet-up"),
    btnSlotsBetDown: document.getElementById("btn-slots-bet-down"),
    btnSlotsMax: document.getElementById("btn-slots-max"),
    finalSlotBonus: document.getElementById("final-slot-bonus"),
    finalSlotCell: document.getElementById("final-slot-cell"),
    // Music player
    music: document.getElementById("music"),
    musicTitle: document.getElementById("music-title"),
    musicSeek: document.getElementById("music-seek"),
    musicProgress: document.getElementById("music-progress"),
    musicCur: document.getElementById("music-cur"),
    musicDur: document.getElementById("music-dur"),
    musicLive: document.getElementById("music-live"),
    musicPrev: document.getElementById("music-prev"),
    musicPlayPause: document.getElementById("music-playpause"),
    musicNext: document.getElementById("music-next"),
    musicMute: document.getElementById("music-mute"),
    musicMuteGlyph: document.getElementById("music-mute-glyph"),
    musicVol: document.getElementById("music-vol"),
    musicDownload: document.getElementById("music-download"),
    voiceDownload: document.getElementById("voice-download"),
    musicStatus: document.getElementById("music-status"),
    // Achievements
    btnAch: document.getElementById("btn-achievements"),
    screenAch: document.getElementById("screen-achievements"),
    achProgress: document.getElementById("ach-progress"),
    achList: document.getElementById("ach-list"),
    btnAchClose: document.getElementById("btn-ach-close"),
    toastWrap: document.getElementById("toast-wrap"),
    // Online leaderboard
    btnLeaderboard: document.getElementById("btn-leaderboard"),
    btnOverLeaderboard: document.getElementById("btn-over-leaderboard"),
    screenLeaderboard: document.getElementById("screen-leaderboard"),
    lbList: document.getElementById("lb-list"),
    btnLbClose: document.getElementById("btn-lb-close"),
    lbEntry: document.getElementById("lb-entry"),
    lbEntryPrompt: document.getElementById("lb-entry-prompt"),
    lbEntryForm: document.getElementById("lb-entry-form"),
    lbInitials: document.getElementById("lb-initials"),
    btnLbSubmit: document.getElementById("btn-lb-submit"),
    lbStatus: document.getElementById("lb-status"),
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
    // The pinball run owns its own normalized->pixel projection; re-derive it
    // (it rescales any in-flight ball to the new rect internally).
    if (game.pin) PINBALL.layout(game.pin, view);
    if ((game.state === "playing" || game.state === "countdown") && prevW > 0 && prevH > 0) {
      hexy.x *= w / prevW;
      hexy.y *= h / prevH;
      clampHexy();
    }
    // Hexy moved in the rescale -- snap the aim target back onto his head so the
    // reticle doesn't draw a stale frame at the old spot before the next update.
    if (hexy.w > 0) {
      const ht = headTarget();
      game.aimX = ht.x;
      game.aimY = ht.y;
    }
    parkWig();
    // The payline overlay is measured in pixels, so realign it to the new grid box.
    if (game.state === "slots") requestAnimationFrame(drawPaylines);
  }

  // ---------- Assets ----------
  const sprites = { bald: null, wig: null, molly: null, paw: null, pawMid: null };

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
        ["assets/bald_no_bg.png", "assets/bald.png", "assets/bald.webp", "assets/bald.jpg", "assets/bald.svg"],
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
      loadFirst(
        ["assets/MOLLY.png", "assets/molly.png", "assets/molly.webp", "assets/molly.jpg"],
        () => fallbackImage(320, 320, (g) => {
          g.fillStyle = "#1b1b1b";   // fluffy black cat head stand-in
          g.beginPath(); g.ellipse(160, 175, 120, 110, 0, 0, Math.PI * 2); g.fill();
          g.beginPath();             // ears
          g.moveTo(70, 110); g.lineTo(110, 40); g.lineTo(140, 105); g.closePath();
          g.moveTo(250, 110); g.lineTo(210, 40); g.lineTo(180, 105); g.closePath();
          g.fill();
          g.fillStyle = "#8be36b";   // eyes
          g.beginPath(); g.ellipse(120, 170, 18, 24, 0, 0, Math.PI * 2); g.ellipse(200, 170, 18, 24, 0, 0, Math.PI * 2); g.fill();
          g.fillStyle = "#0a0a0a";
          g.beginPath(); g.ellipse(120, 170, 6, 20, 0, 0, Math.PI * 2); g.ellipse(200, 170, 6, 20, 0, 0, Math.PI * 2); g.fill();
        })
      ),
      loadFirst(
        // Claws point UP in the source art; drawSwipingPaw rotates it to face the can.
        ["assets/catpaw.png", "assets/paw.png", "assets/catpaw.webp"],
        () => fallbackImage(200, 260, (g) => {
          g.fillStyle = "#141414";
          g.beginPath(); g.ellipse(100, 180, 70, 60, 0, 0, Math.PI * 2); g.fill();   // pad
          g.fillStyle = "#efe6d2";
          for (let i = 0; i < 4; i++) {                                              // claws
            const x = 40 + i * 40;
            g.beginPath(); g.moveTo(x - 8, 130); g.lineTo(x + 8, 130); g.lineTo(x, 40); g.closePath(); g.fill();
          }
        })
      ),
      loadFirst(
        // Shown large when the player fails to open every can -- Molly's verdict.
        ["assets/pawmiddlefinger.png", "assets/paw_middle.png"],
        () => fallbackImage(200, 260, (g) => {
          g.fillStyle = "#141414";
          g.beginPath(); g.ellipse(100, 190, 70, 60, 0, 0, Math.PI * 2); g.fill();
          g.fillRect(86, 40, 28, 130);   // a single raised "finger"
        })
      ),
    ]).then(([bald, wig, molly, paw, pawMid]) => {
      sprites.bald = bald;
      sprites.wig = wig;
      sprites.molly = molly;
      sprites.paw = paw;
      sprites.pawMid = pawMid;
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
    // loading | start | countdown | playing | roundEnd | roundCard | gameOver
    // Pinball bonus phase (after round 10): pinIntro | pinPlaying | pinCapture | pinDone
    // God Gamer final boss (after clearing pinball): blackjack
    // Final gauntlet leg (after winning blackjack): slots
    state: "loading",
    round: 0,
    score: 0,
    best: 0,
    bestRound: 0,
    bullseyes: 0,    // perfect (dead-center) rounds this run (tracked stat)
    targetRadius: 80,
    roundTime: 0,
    roundClock: 0,
    countT: 0,       // round-start 3-2-1 countdown timer
    countLabel: "",  // last-shown countdown face ("3"/"2"/"1"/"GO"), for change detection
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
    pin: null,       // PINBALL run state during the bonus phase (null otherwise)
    pinBonus: 0,     // pinball points earned this run (for the game-over stat)
    pinCleared: 0,   // tables captured in the bonus (0..5)
    pinPlayed: false, // did this run unlock + enter the pinball finale?
    pinVictory: false, // did the pinball finale end in a full 5-table clear?
    bj: null,        // BLACKJACK match state during the showdown (null otherwise)
    bjPlayed: false, // did this run reach the blackjack showdown?
    bjBonus: 0,      // blackjack points earned this run (for the game-over stat)
    blackjackWon: false, // did the player win 4-of-5 to clinch GOD GAMER?
    slot: null,      // SLOT machine state during the final leg (null otherwise)
    slotPlayed: false, // did this run reach the slot-machine finale?
    slotBonus: 0,    // slot points banked this run (for the game-over stat)
    slotWon: false,  // did the player reach 2000 credits to clinch GOD GAMER?
    feed: null,      // FEED.createRun state during the Feed Molly bonus (null otherwise)
    feedPlayed: false, // did this run enter Feed Molly? (true for every round-10 finisher)
    feedBonus: 0,    // Feed Molly points banked this run
    feedCleared: false, // opened all five cans before patience ran out?
  };

  const confetti = [];

  // Pinball control state, read each frame in update() and reset between balls.
  // ptr maps an active pointerId to the control it grabbed ("left"/"right"/"plunger").
  const pin = { leftDown: false, rightDown: false, launchHeld: false, launchReleased: false, ptr: {} };
  let pinBannerTimer = 0;

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
  let voiceComp = null;     // shared 6:1 compressor + makeup gain for voice lines
  let voiceMakeup = null;
  let muted = localStorage.getItem(MUTE_KEY) === "1";

  // Fart SFX: a random clip from assets/farts/ plays on each pin. The manifest
  // (scripts/build_audio_manifests.sh) lists every clip; a fresh Audio per play
  // lets rapid pins overlap cleanly. Falls back to one known clip if the
  // manifest can't be loaded, so a pin always farts.
  let fartUrls = ["assets/farts/fart.mp3"];
  (async () => {
    try {
      const res = await fetch("assets/farts/manifest.json", { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const manifest = await res.json();
      const files = (manifest && Array.isArray(manifest.farts))
        ? manifest.farts.filter((f) => f && f.file) : [];
      if (files.length) {
        fartUrls = files.map((f) => "assets/farts/" + encodeURIComponent(f.file));
      } else {
        console.info("Farts: manifest empty -- using fallback clip.");
      }
    } catch (e) {
      console.info("Farts: no manifest (" + e.message + ") -- using fallback clip.");
    }
  })();

  function refreshMuteUI() {
    el.muteGlyph.innerHTML = muted ? "&#128263;" : "&#128266;";
    el.mute.classList.toggle("muted", muted);
  }

  // Single shared Web Audio context, created on first sound (after a user
  // gesture) and resumed if the browser auto-suspended it. null when Web Audio
  // is unavailable, so every caller degrades gracefully.
  function ensureAudioCtx() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
    }
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }

  // Voice lines route through a 6:1 compressor + makeup gain so quieter passages
  // -- and the volume trail-offs at the end of a clip -- come up to an even,
  // easy-to-hear level. The compressor caps the peaks first, so the makeup gain
  // lifts the whole clip (raising the quiet parts) without risking clipping.
  // Built once and shared: clips never overlap, so one chain serves them all.
  function voiceInputNode() {
    const ctx = ensureAudioCtx();
    if (!ctx) return null;
    if (!voiceComp) {
      voiceComp = ctx.createDynamicsCompressor();
      voiceComp.threshold.value = -24; // start riding the level below peak speech
      voiceComp.knee.value = 30;       // soft knee -> natural, not obviously pumped
      voiceComp.ratio.value = 6;       // 6:1
      voiceComp.attack.value = 0.003;  // grab transients quickly
      voiceComp.release.value = 0.25;  // let go smoothly between words
      voiceMakeup = ctx.createGain();
      voiceMakeup.gain.value = 3.2;    // ~+10 dB makeup -> lift the now-tamed signal
      voiceComp.connect(voiceMakeup).connect(ctx.destination);
    }
    return voiceComp;
  }

  function beep(freq, dur, type = "sine", gain = 0.18) {
    if (muted) return;
    const ctx = ensureAudioCtx();
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  function chord(freqs, dur, type = "triangle") {
    freqs.forEach((f, i) => setTimeout(() => beep(f, dur, type, 0.14), i * 70));
  }

  function fart(volume = 0.7) {
    if (muted) return;
    const url = fartUrls[(Math.random() * fartUrls.length) | 0];
    const a = new Audio(url);
    a.volume = volume;
    a.play().catch(() => {});
  }

  // ---------- Sound effects ----------
  // Thin, tasteful synth cues built on beep()/chord() above -- no audio files.
  // All inherit beep()'s `muted` gate, so the speaker toggle silences them.
  function sfxGrab() {
    beep(420, 0.06, "square", 0.10);
    beep(640, 0.05, "square", 0.06);
  }

  function sfxMiss() {
    beep(150, 0.26, "sawtooth", 0.16);
    setTimeout(() => beep(104, 0.22, "sawtooth", 0.12), 60);
  }

  // Tiered success jingle -- richer the closer to a bullseye.
  function sfxPin(points) {
    if (points >= 1000) chord([523, 659, 784, 1046], 0.22);
    else if (points >= 650) chord([523, 659, 784], 0.16);
    else beep(520, 0.16, "triangle", 0.2);
  }

  function sfxClick() {
    beep(540, 0.05, "triangle", 0.08);
  }

  // Rate gate for the pinball bounce cue: when the ball rattles in a corner the
  // bounce sound can fire many times per second and turn into a machine-gun
  // buzz. Track the consecutive "rapid" streak and suppress the 4th and beyond
  // until a gap >= RAPID_GAP_MS breaks the streak (which re-enables the sound).
  // 100ms (~10 bounces/s) is comfortably below a real rattle's rate yet well
  // above any musical pace of distinct, intended bounces, so normal spaced
  // bounces always play and only true buzz is muted.
  function makeBounceGate(rapidGapMs) {
    var lastMs = -Infinity;
    var rapidCount = 0;
    return {
      allow: function (now) {
        if (now - lastMs < rapidGapMs) rapidCount += 1;
        else rapidCount = 1;
        lastMs = now;
        return rapidCount < 4;
      }
    };
  }
  var bounceGate = makeBounceGate(100);

  function sfxUnlock() {
    chord([784, 1046, 1318], 0.18, "triangle");
  }

  // A pitch glide from f0 to f1 -- used for the slot's "winding up" whoosh.
  function sweep(f0, f1, dur, type, gain) {
    if (muted) return;
    const ctx = ensureAudioCtx();
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type || "sawtooth";
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain || 0.12, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  // ---------- Slot-machine spin SFX ----------
  // The reels wind up (rising whoosh), tick while rolling, and each reel locks
  // with a mechanical thunk plus an ascending note -- so the five stops play a
  // little rising melody, paid off by the win/loss jingle on settle.
  const REEL_STOP_NOTES = [392, 440, 494, 587, 659];   // G A B D E -- a clean rising run
  function sfxSpinStart() {
    sweep(150, 560, 0.34, "sawtooth", 0.12);
    beep(220, 0.08, "square", 0.06);
  }
  function sfxReelTick() {
    beep(720 + Math.random() * 380, 0.02, "square", 0.035);
  }
  function sfxReelStop(col) {
    beep(120, 0.07, "sine", 0.12);                                  // the thunk
    beep(REEL_STOP_NOTES[col] || 392, 0.14, "triangle", 0.15);      // the rising note
  }
  // The golden-wig jackpot: a bright rising arpeggio capped with a shimmer -- richer
  // and higher than any ordinary win jingle so the bonus line feels like a treat.
  function sfxJackpot() {
    sweep(440, 1320, 0.34, "triangle", 0.10);
    chord([784, 988, 1319, 1568, 2093], 0.26, "triangle");
    setTimeout(function () { beep(2637, 0.12, "sine", 0.10); }, 300);
  }
  // The bald-head trap: a harsh descending two-tone buzzer (the classic "wah-wah"
  // fail) so a row of Hexy's bare head lands as an unmistakable gut-punch.
  function sfxBald() {
    sweep(320, 90, 0.5, "sawtooth", 0.2);
    beep(196, 0.2, "square", 0.14);
    setTimeout(function () { beep(146, 0.3, "sawtooth", 0.16); }, 150);
  }

  // ---------- Game flow ----------
  function startGame() {
    if (game.state !== "start" && game.state !== "gameOver") return;
    // The pinball phase resizes the wig sprite down to a ball; restore the base
    // sprite sizes so a fresh run (incl. "Play Again") parks a full-size wig.
    sizeSprites();
    game.round = 0;
    game.score = 0;
    game.bestRound = 0;
    game.bullseyes = 0;
    game.pin = null;
    game.pinBonus = 0;
    game.pinCleared = 0;
    game.pinPlayed = false;
    game.pinVictory = false;
    game.bj = null;
    game.bjPlayed = false;
    game.bjBonus = 0;
    game.blackjackWon = false;
    game.slot = null;
    game.slotPlayed = false;
    game.slotBonus = 0;
    game.slotWon = false;
    game.feed = null;
    game.feedPlayed = false;
    game.feedBonus = 0;
    game.feedCleared = false;
    resetPinInput();
    game.seed = (((Date.now() & 0xffffffff) ^ ((Math.random() * 0xffffffff) | 0)) >>> 0) || 1;
    game.modifierPlan = MOD.buildPlan(game.seed);
    game.activeModifiers = [];
    moveSim.bounceX = 0;
    moveSim.bounceY = 0;
    confetti.length = 0;
    voice.queue.length = 0;   // drop any lines still queued from a prior run
    show(el.screenStart, false);
    show(el.screenOver, false);
    el.hud.classList.remove("hidden");
    el.hud.setAttribute("aria-hidden", "false");
    setStage(0);
    // TEMP: jump straight to a finale phase for tuning. ?blackjack and ?slots
    // pretend the earlier legs were already cleared so the win gate is consistent.
    if (DEV_SLOTS) {
      game.round = TOTAL_ROUNDS;
      game.pinPlayed = true;
      game.pinCleared = PINBALL.CAPTURE_GOAL;
      game.pinVictory = true;
      game.bjPlayed = true;
      game.blackjackWon = true;
      startSlots();
      return;
    }
    if (DEV_BLACKJACK) {
      game.round = TOTAL_ROUNDS;
      game.pinPlayed = true;
      game.pinCleared = PINBALL.CAPTURE_GOAL;
      game.pinVictory = true;
      startBlackjack();
      return;
    }
    if (DEV_PINBALL) { game.round = TOTAL_ROUNDS; startPinball(); return; } // TEMP: jump straight to pinball
    if (DEV_FEEDMOLLY) { game.round = TOTAL_ROUNDS; startFeedMolly(); return; } // TEMP: jump straight to Feed Molly
    nextRound();
  }

  function nextRound() {
    game.round += 1;
    game.state = "countdown";
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

    // Open on a 3-2-1 countdown: the stage is frozen and ungrabbable while a
    // voice line plays over it, then play begins with the full round clock.
    // The timer bar shows full during the countdown so the round looks "armed".
    game.countT = COUNTDOWN_SECONDS;
    game.countLabel = "";
    el.countNum.textContent = String(COUNTDOWN_SECONDS);
    el.countNum.classList.remove("go");
    el.timerFill.style.transform = "scaleX(1)";
    el.timerFill.style.background = "linear-gradient(90deg, var(--good), var(--warn))";
    showCountdown(true);
    playVoiceLine();
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
    return dx > 0 ? "More to the left." : "More to the right.";
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
    // A dead-center pin is a "perfect" round; all 10 perfect == GOD GAMER.
    if (tier.points >= SCORE_TIERS[0].points) game.bullseyes += 1;
    updateHud();

    if (hit) {
      wig.stuck = true;
      wig.held = false;
      wig.sdx = wig.x - hexy.x;
      wig.sdy = wig.y - hexy.y;
      hexy.pop = 1;
      spawnConfetti(tier.points >= 1000 ? 1 : 0.6);
      sfxPin(tier.points);
      fart();
      // Aftershock puff a beat later, riding the fart's tail.
      setTimeout(() => spawnConfetti(0.2), 1600);
    } else {
      wig.held = false;
      game.shake = reduceMotion ? 0 : 14;
      sfxMiss();
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

  // Countdown -> live play. Hexy starts bouncing only now, with the full clock.
  function startPlaying() {
    game.state = "playing";
    showCountdown(false);
  }

  function showCountdown(visible) {
    if (!el.countdown) return;
    show(el.countdown, visible);
  }

  // Restart the pop animation on each new countdown face by re-triggering it.
  function pulseCountdown() {
    if (reduceMotion || !el.countNum) return;
    el.countNum.classList.remove("tick");
    void el.countNum.offsetWidth;   // force reflow so the animation replays
    el.countNum.classList.add("tick");
  }

  function proceed() {
    if (game.advancing) return;
    game.advancing = true;
    show(el.screenRound, false);
    if (game.round >= TOTAL_ROUNDS) {
      // First part is the ten pin rounds: clear PINBALL_UNLOCK on that score
      // alone or the run ends here. game.score is base-only at this point (Feed
      // Molly hasn't run), so no bonus can buy a player past a base game they
      // didn't earn. Clear it and Feed Molly is the next, separate gate.
      if (game.score >= PINBALL_UNLOCK) startFeedMolly();
      else endGame();
    } else {
      nextRound();
    }
  }

  function endGame() {
    game.state = "gameOver";
    el.hud.classList.add("hidden");
    el.hud.setAttribute("aria-hidden", "true");
    setStage(0);
    showCountdown(false);  // in case the run ended straight off a countdown
    game.pin = null;       // bonus phase is over; drop the run state
    game.feed = null;
    game.advancing = false;

    // A run that never unlocked the pinball finale is scored on the base game
    // alone (10 x 1000), exactly as before the bonus existed; a run that played
    // the finale is scored out of base + pinball. So a non-qualifier's accuracy
    // is never diluted by points it had no shot at earning.
    const maxScore = TOTAL_ROUNDS * 1000
      + (game.feedPlayed ? FEED.maxScore() : 0)
      + (game.pinPlayed ? PINBALL.maxScore() : 0)
      + (game.bjPlayed ? BLACKJACK.maxScore() : 0)
      + (game.slotPlayed ? SLOT.maxScore() : 0);
    const acc = Math.round((game.score / maxScore) * 100);
    // The win (GOD GAMER) is the full gauntlet: qualify on base score, pin the
    // wig on all five pinball course variations, beat the True God Gamer at
    // blackjack (win 4 of 5 hands), THEN turn 1000 credits into 2000 on the
    // slot machine. Falling short at any stage -- including busting the slot --
    // is not a win.
    const won = game.pinPlayed && game.pinCleared >= PINBALL.CAPTURE_GOAL
      && game.blackjackWon && game.slotWon;
    const rank = RANKS.rankFor(game.score, maxScore, won);
    const isGod = RANKS.isGodGamer(rank);

    const newRecord = game.score > game.best;
    if (newRecord) {
      game.best = game.score;
      try { localStorage.setItem(BEST_KEY, String(game.best)); } catch (_) {}
    }

    el.finalRank.textContent = rank.name;
    el.finalRank.classList.toggle("is-god", isGod);
    el.finalScore.textContent = game.score;
    el.finalAcc.textContent = acc + "%";
    el.finalBestRound.textContent = game.bestRound;
    if (el.finalPinBonus) el.finalPinBonus.textContent = "+" + game.pinBonus;
    if (el.finalBjBonus) el.finalBjBonus.textContent = "+" + game.bjBonus;
    if (el.finalSlotBonus) el.finalSlotBonus.textContent = "+" + game.slotBonus;
    // Keep the finale phases a surprise: a phase's score (and even its name) only
    // appears once the run actually reached it. A short run that never unlocked
    // pinball -- or one that failed pinball before blackjack -- shows no trace of
    // the stage it never saw.
    if (el.finalPinCell) show(el.finalPinCell, game.pinPlayed);
    if (el.finalBjCell) show(el.finalBjCell, game.bjPlayed);
    if (el.finalSlotCell) show(el.finalSlotCell, game.slotPlayed);
    el.finalVerdict.textContent = rank.blurb;
    // The forfeiture-clause payoff: anyone short of the top rank is told, loudly.
    show(el.finalNotGod, !isGod);
    show(el.finalRecord, newRecord);
    // Comedic flex for clearing all five tables; purely cosmetic (no GOD GAMER).
    if (el.finalWizard) show(el.finalWizard, game.pinCleared >= PINBALL.CAPTURE_GOAL);
    // The reward link is the GOD GAMER payoff -- only the earned rank sees it.
    if (el.finalPrize) show(el.finalPrize, isGod);
    show(el.screenOver, true);
    chord(
      isGod ? [659, 784, 988, 1318, 1568]
            : (newRecord ? [523, 659, 784, 1046, 1318] : [392, 523, 659]),
      0.26
    );
    // Offer a leaderboard spot. GOD GAMER or not, the score is what competes, so
    // every run is checked against the online top 100.
    maybePromptLeaderboard(game.score, isGod);
  }

  function spawnConfetti(intensity) {
    const ht = headTarget();
    spawnConfettiAt(ht.x, ht.y, intensity);
  }

  // Burst confetti from an arbitrary point -- the base game pins at Hexy's head,
  // the pinball phase bursts from the holder cup.
  function spawnConfettiAt(x, y, intensity) {
    if (reduceMotion) return;
    const n = Math.round(70 * intensity);
    const palette = ["#FE0000", "#ffffff", "#FE0000", "#fc7878", "#ffffff"];
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 120 + Math.random() * 320;
      confetti.push({
        x: x, y: y,
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

  // ---------- Feed Molly bonus phase ----------
  // Reached only by players who clear the base-score qualifier in the ten pin
  // rounds (gated in proceed()); Molly is then a clear-or-fail gate to pinball.
  // Pure logic lives in FEED (src/js/feedmolly.js); this is the I/O shell. Flow:
  //   proceed() [round>=10, score>=PINBALL_UNLOCK] -> startFeedMolly() -> feedIntro
  //   feedIntro --(Open/Space/tap)--> feedPlaying
  //   feedPlaying --tap opens a can--> feedResult --(lock)--> next can or feedDone
  //   feedPlaying --patience empties--> feedDone (failed): Molly stalks off
  //   feedDone --(lock)--> finishFeedHandoff(): cleared -> pinball, else scoreboard
  let feedBannerTimer = 0;

  function startFeedMolly() {
    game.advancing = false;
    game.feed = FEED.createRun(game.seed);
    game.feedPlayed = true;
    game.feedBonus = 0;
    game.feedCleared = false;
    el.hud.classList.remove("hidden");
    el.hud.setAttribute("aria-hidden", "false");
    setStage(2);
    startFeedIntro();
  }

  function startFeedIntro() {
    const run = game.feed;
    game.state = "feedIntro";
    const can = FEED.activeCan(run);
    el.feedCanN.textContent = String(run.idx + 1);
    el.feedCanName.textContent = can.name;
    el.feedCanHint.textContent = can.hint;
    updateFeedHud();
    show(el.screenFeedIntro, true);
    chord([523, 659, 784], 0.16);
    playVoiceLine();
  }

  function beginFeedPlay() {
    if (game.state !== "feedIntro") return;
    show(el.screenFeedIntro, false);
    FEED.resetCan(game.feed);
    game.state = "feedPlaying";
  }

  function updateFeedMolly(dt) {
    const run = game.feed;
    const ev = FEED.step(run, dt, reduceMotion);

    // The HUD timer bar doubles as Molly's patience meter -- it empties as she
    // gets impatient, going red as it runs low.
    el.timerFill.style.transform = "scaleX(" + run.patience + ")";
    el.timerFill.style.background = run.patience < 0.3
      ? "linear-gradient(90deg, var(--accent), var(--warn))"
      : "linear-gradient(90deg, var(--good), var(--warn))";

    if (ev.telegraph) beep(ev.hazType === "paw" ? 240 : 190, 0.12, "sawtooth", 0.10);
    if (ev.strike) {
      game.shake = reduceMotion ? 0 : 20;
      beep(90, 0.12, "square", 0.18);     // deeper, harder thud
      beep(150, 0.06, "sawtooth", 0.10);  // crack on top
    }
    if (ev.patienceOut) { finishFeedMolly(false); }
  }

  function attemptFeed() {
    if (game.state !== "feedPlaying") return;
    const run = game.feed;
    const r = FEED.attempt(run);
    game.score += r.points;
    game.feedBonus += r.points;
    updateFeedHud();

    if (r.tier === "bullseye") {
      chord([784, 1046, 1318], 0.12);          // bright bonus-zone flourish
      spawnConfettiAt(view.w / 2, view.h * 0.62, 0.35);
    } else if (r.tier === "perfect" || r.tier === "good") {
      beep(r.tier === "perfect" ? 880 : 660, 0.10, "triangle", 0.18);
    } else {
      beep(160, 0.18, "sawtooth", 0.14);
      game.shake = reduceMotion ? 0 : 8;
    }

    if (run.failed) { finishFeedMolly(false); return; }

    if (r.opened) {
      const cx = view.w / 2;
      const cy = view.h * 0.62;
      spawnConfettiAt(cx, cy, r.complete ? 1.4 : 0.9);
      game.shake = reduceMotion ? 0 : 14;
      sfxPin(1000);
      fart();
      showFeedBanner(r.complete ? "FINALLY! FOOD!" : "POP! +" + r.points, run.opened);
      playVoiceLine();
      game.state = "feedResult";
      game.lockT = r.complete ? 1.6 : 1.1;
    }
  }

  function advanceFeedCan() {
    const run = game.feed;
    if (FEED.isComplete(run) || !FEED.nextCan(run)) {
      startFeedDone(true);
      return;
    }
    // One prompt upfront only: flow straight into the next can. nextCan() has
    // already reset it; the result-card lock just played, so the player gets a
    // beat before the new sweep starts.
    updateFeedHud();
    game.state = "feedPlaying";
  }

  function startFeedDone(victory) {
    game.state = "feedDone";
    game.feedCleared = victory;
    game.lockT = victory ? 1.4 : 2.6;   // linger on Molly's verdict when she's snubbed
    if (victory) {
      spawnConfettiAt(view.w / 2, view.h * 0.4, 1.6);
      game.shake = reduceMotion ? 0 : 18;
      chord([659, 784, 988, 1318], 0.24);
      showFeedBanner("MOLLY IS FED!", FEED.CANS_GOAL);
    } else {
      beep(150, 0.4, "sawtooth", 0.16);
      showFeedBanner("She stalked off.", game.feed ? game.feed.opened : 0);
    }
  }

  // The bonus is over. Feed Molly is a pure clear-or-fail gate: every can opened
  // advances to the pinball finale, a patience failure drops to the scoreboard.
  // The base-score qualifier was already settled before Molly ran (see
  // proceed()), so reaching this point cleared means the player has earned the
  // finale -- no second score check.
  function finishFeedHandoff() {
    game.feed = null;
    if (game.feedCleared) startPinball();
    else endGame();
  }

  function finishFeedMolly(victory) {
    startFeedDone(victory);
  }

  function updateFeedHud() {
    const run = game.feed;
    if (!run) return;
    if (el.roundLabel) el.roundLabel.textContent = "Can";
    el.round.textContent = (run.idx + 1) + " / " + FEED.CANS_GOAL;
    el.score.textContent = game.score;
    el.best.textContent = game.best;
  }

  // Reuses the pinball banner element; pip count tracks cans opened.
  function showFeedBanner(text, opened) {
    if (!el.pinBanner) return;
    el.pinBannerText.textContent = text;
    let pips = "";
    for (let i = 0; i < FEED.CANS_GOAL; i++) pips += (i < opened ? "●" : "○");
    el.pinBannerPips.textContent = pips;
    show(el.pinBanner, true);
    el.pinBanner.classList.remove("show");
    void el.pinBanner.offsetWidth;
    if (!reduceMotion) el.pinBanner.classList.add("show");
    clearTimeout(feedBannerTimer);
    feedBannerTimer = setTimeout(() => show(el.pinBanner, false), 1500);
  }

  function drawFeedMolly() {
    const run = game.feed;
    if (!run) return;

    // Failed the bonus (didn't open every can): Molly's verdict fills the screen.
    if (game.state === "feedDone" && !game.feedCleared) { drawMollyVerdict(); return; }

    const can = FEED.activeCan(run);
    const r = can.rule;
    const cx = view.w / 2;
    const cy = view.h * 0.62;
    const base = Math.min(view.w, view.h);
    const ringR = base * 0.20;

    // Telegraph progress (0..1) drives Molly's lunge strike and the paw swipe.
    const h = run.haz;
    const tele = (r.hazard && h.phase === "telegraph") ? (1 - h.tele / FEED.TELE) : 0;

    // Molly's head, resting above the can. A lunge is a STRIKE, not a fall: she
    // rears back during the first half of the tell, then stabs down fast to land
    // right at the can rim on the strike frame (then snaps back when it resolves).
    const headY0 = view.h * 0.30;
    let dipPx = 0, grow = 1;
    if (h.type === "lunge" && tele > 0) {
      const rearBack = ringR * 0.40;
      const strikeTargetY = cy - ringR * 0.85;            // head center stabs down ONTO the can
      const maxDip = Math.max(0, strikeTargetY - headY0);
      if (tele < 0.55) {
        const a = tele / 0.55;                            // wind up: rear back, coiling
        dipPx = -rearBack * a;
        grow = 1 + 0.06 * a;
      } else {
        const s = (tele - 0.55) / 0.45;                   // strike: snap down hard (cubic)
        const se = s * s * s;
        dipPx = -rearBack + (maxDip + rearBack) * se;
        grow = 1 + 0.46 * se;
      }
    }
    if (sprites.molly) {
      const mH = base * 0.34 * grow;
      const aspect = sprites.molly.naturalWidth / sprites.molly.naturalHeight || 1;
      const mW = mH * aspect;
      const my = headY0 - mH / 2 + dipPx;
      ctx.save();
      ctx.drawImage(sprites.molly, cx - mW / 2, my, mW, mH);
      ctx.restore();
    }

    // The can lid (dark disc + metal rim).
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(12, 12, 14, 0.92)";
    ctx.fill();
    ctx.lineWidth = Math.max(4, ringR * 0.10);
    ctx.strokeStyle = "rgba(200, 200, 210, 0.65)";
    ctx.stroke();

    // The "kibble" decoy arc she refuses to eat (later cans only).
    if (r.kibble) {
      ctx.beginPath();
      ctx.arc(cx, cy, ringR, run.kibble - r.kibble, run.kibble + r.kibble);
      ctx.strokeStyle = "rgba(254, 0, 0, 0.55)";
      ctx.lineWidth = Math.max(5, ringR * 0.14);
      ctx.stroke();
    }

    // The green pull-tab -- the target.
    ctx.beginPath();
    ctx.arc(cx, cy, ringR, run.notch - r.notch, run.notch + r.notch);
    ctx.strokeStyle = "rgba(65, 224, 163, 0.9)";
    ctx.lineWidth = Math.max(6, ringR * 0.18);
    ctx.stroke();

    // The bonus zone -- a gold core in the center of the green for extra points.
    const bz = r.notch * FEED.BULLSEYE_FRAC;
    ctx.beginPath();
    ctx.arc(cx, cy, ringR, run.notch - bz, run.notch + bz);
    ctx.strokeStyle = "rgba(255, 214, 64, 0.98)";
    ctx.lineWidth = Math.max(7, ringR * 0.22);
    ctx.shadowColor = "rgba(255, 214, 64, 0.8)";
    ctx.shadowBlur = ringR * 0.3;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // The opener (sweeping pointer).
    const ox = cx + Math.cos(run.theta) * ringR;
    const oy = cy + Math.sin(run.theta) * ringR;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.92)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(ox, oy);
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(ox, oy, ringR * 0.09, 0, Math.PI * 2);
    ctx.fill();

    // Hits-needed pips at the can's center for multi-stop cans.
    if (r.hits > 1) {
      const pipR = ringR * 0.07;
      const gap = pipR * 2.6;
      const startX = cx - gap * (r.hits - 1) / 2;
      for (let i = 0; i < r.hits; i++) {
        ctx.beginPath();
        ctx.arc(startX + i * gap, cy, pipR, 0, Math.PI * 2);
        ctx.fillStyle = i < run.hitsDone ? "rgba(65,224,163,0.95)" : "rgba(255,255,255,0.25)";
        ctx.fill();
      }
    }
    ctx.restore();

    // A drawn paw swiping in during a "paw" telegraph (her photo is just a head).
    if (h.type === "paw" && tele > 0) {
      drawSwipingPaw(cx, cy, ringR, run.haz.pawAngle, tele);
    }

  }

  // The fail screen: pawmiddlefinger.png blown up large, centered.
  function drawMollyVerdict() {
    if (!sprites.pawMid) return;
    const base = Math.min(view.w, view.h);
    const h = base * 0.7;
    const aspect = sprites.pawMid.naturalWidth / sprites.pawMid.naturalHeight || 1;
    const w = h * aspect;
    ctx.save();
    ctx.drawImage(sprites.pawMid, view.w / 2 - w / 2, view.h * 0.5 - h / 2, w, h);
    ctx.restore();
  }

  function drawSwipingPaw(cx, cy, ringR, theta, tele) {
    if (!sprites.paw) return;
    // Paw slides in from off-rim toward the can as the strike nears.
    const reach = ringR * (1.9 - tele * 1.1);
    const px = cx + Math.cos(theta) * reach;
    const py = cy + Math.sin(theta) * reach;
    const pawH = ringR * 1.6;
    const aspect = sprites.paw.naturalWidth / sprites.paw.naturalHeight || 1;
    const pawW = pawH * aspect;
    ctx.save();
    ctx.translate(px, py);
    // Source claws point up; rotate so they face the can (the swipe direction).
    ctx.rotate(theta - Math.PI / 2);
    ctx.drawImage(sprites.paw, -pawW / 2, -pawH / 2, pawW, pawH);
    ctx.restore();
  }

  // ---------- Pinball bonus phase ----------
  // After round 10, the wig becomes a pinball. The pure physics/scoring live in
  // PINBALL (src/js/pinball.js); this section is the I/O shell: input -> step,
  // events -> juice/score, plus the table renderer. Flow:
  //   proceed() [round>=10] -> startPinball() -> pinIntro
  //   pinIntro --(Launch/Space/tap)--> pinPlaying (ball served)
  //   pinPlaying --capture--> pinCapture --(lock)--> next table or pinDone
  //   pinPlaying --drain--> lose a ball; re-serve, or pinDone if out of balls
  //   pinDone --(lock)--> endGame()  (the existing rank screen, reused)
  function startPinball() {
    game.advancing = false;
    game.pin = PINBALL.createRun(game.seed, view);
    game.pinBonus = 0;
    game.pinCleared = 0;
    game.pinPlayed = true;
    resetPinInput();
    el.hud.classList.remove("hidden");
    el.hud.setAttribute("aria-hidden", "false");
    setStage(3);
    startPinIntro();
  }

  function startPinIntro() {
    const run = game.pin;
    game.state = "pinIntro";
    resetPinInput();
    const table = PINBALL.activeTable(run);
    el.pinTableN.textContent = String(run.idx + 1);
    el.pinTableName.textContent = table.name;
    el.pinTableHint.textContent = table.hint;
    updatePinHud();
    show(el.screenPinIntro, true);
    chord([523, 659, 784], 0.16);
    playVoiceLine();
  }

  function beginPinPlay() {
    if (game.state !== "pinIntro") return;
    show(el.screenPinIntro, false);
    resetPinInput();
    PINBALL.serveBall(game.pin);
    game.state = "pinPlaying";
  }

  function updatePinball(dt) {
    const run = game.pin;
    PINBALL.setFlipper(run, "left", pin.leftDown);
    PINBALL.setFlipper(run, "right", pin.rightDown);
    const ev = PINBALL.step(run, dt, { launchHeld: pin.launchHeld, launchReleased: pin.launchReleased });
    pin.launchReleased = false;

    // While a ball is parked, the HUD timer bar doubles as the plunger charge
    // meter; once live it reads full.
    const live = run.ball.live;
    el.timerFill.style.transform = "scaleX(" + (live ? 1 : run.charge) + ")";
    el.timerFill.style.background = live
      ? "linear-gradient(90deg, var(--good), var(--warn))"
      : "linear-gradient(90deg, var(--warn), var(--good))";

    if (ev.flipperHit) beep(300, 0.05, "square", 0.10);
    if (ev.bumper) beep(720, 0.05, "triangle", 0.12);
    // Bounce cue, rate-gated so a corner rattle can't machine-gun the speaker.
    // beep()'s own `muted` check still applies on top of this.
    if (ev.bounced && bounceGate.allow(performance.now())) beep(180, 0.04, "sawtooth", 0.08);
    if (ev.captured) { onPinCapture(); return; }
    if (ev.drained) { onPinDrain(); }
  }

  function onPinCapture() {
    const run = game.pin;
    const pts = PINBALL.applyCapture(run);
    game.score += pts;
    game.pinBonus += pts;
    game.pinCleared = run.captures;
    game.state = "pinCapture";
    game.lockT = 1.25;
    resetPinInput();
    updatePinHud();
    const h = run.geom.holder;
    spawnConfettiAt(h.cx, h.cy, PINBALL.isComplete(run) ? 1.4 : 1.0);
    game.shake = reduceMotion ? 0 : 16;
    sfxPin(1000);
    fart();
    showPinBanner("PINNED! +" + pts, run.captures);
    playVoiceLine();
  }

  function onPinDrain() {
    const run = game.pin;
    fart(0.3);
    game.shake = reduceMotion ? 0 : 8;
    const remaining = PINBALL.loseBall(run);
    if (remaining > 0) {
      PINBALL.serveBall(run);
      resetPinInput();
      updatePinHud();
      showPinBanner("Ball lost", run.captures);
    } else {
      finishPinball();
    }
  }

  function advancePinTable() {
    const run = game.pin;
    if (PINBALL.isComplete(run) || !PINBALL.nextTable(run)) {
      startPinDone(true);
      return;
    }
    resetPinInput();
    startPinIntro();
  }

  // Ran out of balls before clearing all five tables: end the bonus and head to
  // the rank screen, scored on captures so far.
  function finishPinball() {
    startPinDone(false);
  }

  function startPinDone(victory) {
    game.state = "pinDone";
    game.pinVictory = victory;   // a full 5-table clear earns the blackjack showdown
    game.lockT = victory ? 1.8 : 1.3;
    resetPinInput();
    if (victory) {
      spawnConfettiAt(view.w / 2, view.h * 0.4, 1.6);
      game.shake = reduceMotion ? 0 : 20;
      chord([659, 784, 988, 1318, 1568], 0.26);
      showPinBanner("FULLY WIGGED!", PINBALL.CAPTURE_GOAL);
    } else {
      sfxMiss();
      showPinBanner("Out of balls", game.pin.captures);
    }
  }

  function updatePinHud() {
    const run = game.pin;
    if (!run) return;
    if (el.roundLabel) el.roundLabel.textContent = "Table";
    el.round.textContent = (run.idx + 1) + " / " + PINBALL.CAPTURE_GOAL;
    el.score.textContent = game.score;
    el.best.textContent = game.best;
  }

  function showPinBanner(text, captures) {
    if (!el.pinBanner) return;
    el.pinBannerText.textContent = text;
    let pips = "";
    for (let i = 0; i < PINBALL.CAPTURE_GOAL; i++) pips += (i < captures ? "●" : "○");
    el.pinBannerPips.textContent = pips;
    show(el.pinBanner, true);
    el.pinBanner.classList.remove("show");
    void el.pinBanner.offsetWidth;   // restart the entrance animation
    if (!reduceMotion) el.pinBanner.classList.add("show");
    clearTimeout(pinBannerTimer);
    pinBannerTimer = setTimeout(() => show(el.pinBanner, false), 1500);
  }

  function resetPinInput() {
    pin.leftDown = false;
    pin.rightDown = false;
    pin.launchHeld = false;
    pin.launchReleased = false;
    pin.ptr = {};
  }

  // Drive the existing wig sprite from the ball each frame so drawWig() renders
  // it (spinning with the ball's angular state unless reduced motion is set).
  function syncWigToBall(run) {
    if (!sprites.wig) return;
    const b = run.ball;
    const d = b.r * 2.5;
    const aspect = sprites.wig.naturalHeight / sprites.wig.naturalWidth;
    wig.w = d;
    wig.h = d * aspect;
    wig.x = b.x - wig.w / 2;
    wig.y = b.y - wig.h / 2;
    wig.wob = reduceMotion ? 0 : b.spin;
    wig.stuck = false;
    wig.held = false;
  }

  function pinRoundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawPinball() {
    const run = game.pin;
    if (!run || !run.geom) return;
    const rect = run.rect;
    const g = run.geom;

    ctx.save();
    pinRoundRect(rect.x, rect.y, rect.w, rect.h, Math.min(rect.w, rect.h) * 0.045);
    ctx.fillStyle = "rgba(8, 8, 11, 0.82)";
    ctx.fill();
    ctx.lineWidth = Math.max(3, rect.w * 0.012);
    ctx.strokeStyle = "rgba(254, 0, 0, 0.55)";
    ctx.stroke();
    ctx.restore();

    drawPinballHolder(run);

    ctx.save();
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(244, 238, 254, 0.45)";
    ctx.lineWidth = Math.max(2, rect.w * 0.012);
    for (const w of g.walls) {
      ctx.beginPath();
      ctx.moveTo(w.ax, w.ay);
      ctx.lineTo(w.bx, w.by);
      ctx.stroke();
    }
    ctx.restore();

    for (const bm of g.bumpers) {
      ctx.beginPath();
      ctx.arc(bm.x, bm.y, bm.r, 0, Math.PI * 2);
      ctx.fillStyle = bm.flash > 0 ? "#ffffff" : "rgba(254, 0, 0, 0.85)";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.6)";
      ctx.stroke();
    }

    for (const f of g.flippers) drawPinballFlipper(f);
    drawPinballPlunger(run);

    syncWigToBall(run);
    if (run.ball.r > 0) drawWig();

    drawPinballStatus(run);
  }

  function drawPinballHolder(run) {
    const h = run.geom.holder;
    const table = PINBALL.activeTable(run);

    // Hexy's head is the target graphic; the holder cup sits on his crown and
    // slides with it on the moving tables.
    if (sprites.bald) {
      const headW = h.hw * 3.0;
      const aspect = sprites.bald.naturalHeight / sprites.bald.naturalWidth;
      const headH = headW * aspect;
      const headX = h.cx - headW / 2;
      const headY = h.cy - headH * HEAD_ANCHOR.y;   // crown anchor at the cup center
      ctx.save();
      ctx.globalAlpha = 0.92;
      ctx.drawImage(sprites.bald, headX, headY, headW, headH);
      ctx.restore();
    }

    // The cup: a U open at the bottom (matches the physics: top + two sides).
    // Gated tables tint it green when open / red when sealed.
    const gated = table.rule.type === "shutter" || table.rule.type === "gauntlet";
    const open = run.ruleState.shutterOpen;
    const col = gated
      ? (open ? "rgba(65, 224, 163, 0.95)" : "rgba(254, 0, 0, 0.95)")
      : "rgba(255, 194, 75, 0.95)";
    const l = h.cx - h.hw, r = h.cx + h.hw, t = h.cy - h.hh, b = h.cy + h.hh;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(3, run.rect.w * 0.018);
    ctx.strokeStyle = col;
    ctx.beginPath();
    ctx.moveTo(l, b);
    ctx.lineTo(l, t);
    ctx.lineTo(r, t);
    ctx.lineTo(r, b);
    ctx.stroke();
    if (gated && !open) {
      ctx.beginPath();
      ctx.moveTo(l, b);
      ctx.lineTo(r, b);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawPinballFlipper(f) {
    const tip = PINBALL.flipperTip(f);
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineWidth = f.thick * 2;
    ctx.strokeStyle = "rgba(254, 0, 0, 0.95)";
    ctx.beginPath();
    ctx.moveTo(f.x, f.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.stroke();
    ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
    ctx.beginPath();
    ctx.arc(f.x, f.y, f.thick * 0.85, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawPinballPlunger(run) {
    if (run.ball.live) return;
    const rect = run.rect;
    const x = run.geom.plunger.x;
    const y0 = rect.y + rect.h * 0.92;
    const y1 = rect.y + rect.h * 0.66;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineWidth = Math.max(4, rect.w * 0.022);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.20)";
    ctx.beginPath();
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y1);
    ctx.stroke();
    ctx.strokeStyle = "rgba(65, 224, 163, 0.95)";
    ctx.beginPath();
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y0 + (y1 - y0) * run.charge);
    ctx.stroke();
    ctx.restore();
  }

  function drawPinballStatus(run) {
    const rect = run.rect;
    const r = Math.max(3, rect.w * 0.018);
    // Balls remaining -- red dots, lower-left inside the table.
    let bx = rect.x + r * 2.2;
    const by = rect.y + rect.h * 0.95;
    for (let i = 0; i < run.balls; i++) {
      ctx.beginPath();
      ctx.arc(bx, by, r, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(254, 0, 0, 0.9)";
      ctx.fill();
      bx += r * 2.6;
    }
    // Capture progress -- filled (done) / outlined (todo) dots, upper-left.
    let cx = rect.x + r * 2.2;
    const cy = rect.y + rect.h * 0.045;
    for (let i = 0; i < PINBALL.CAPTURE_GOAL; i++) {
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.8, 0, Math.PI * 2);
      if (i < run.captures) {
        ctx.fillStyle = "rgba(65, 224, 163, 0.95)";
        ctx.fill();
      } else {
        ctx.lineWidth = 2;
        ctx.strokeStyle = "rgba(244, 238, 254, 0.6)";
        ctx.stroke();
      }
      cx += r * 2.4;
    }
  }

  // Keyboard flippers/plunger. Flipper keys hold while down; the plunger only
  // arms while a ball is parked, so Space never fights a flipper press.
  function handlePinKey(e, down) {
    switch (e.code) {
      case "ArrowLeft":
      case "KeyA":
        e.preventDefault();
        pin.leftDown = down;
        break;
      case "ArrowRight":
      case "KeyD":
        e.preventDefault();
        pin.rightDown = down;
        break;
      case "Space":
      case "ArrowDown":
      case "KeyS":
        e.preventDefault();
        if (game.pin && !game.pin.ball.live) {
          if (down) pin.launchHeld = true;
          else { pin.launchHeld = false; pin.launchReleased = true; }
        }
        break;
      default:
        break;
    }
  }

  // ---------- Blackjack finale (God Gamer final boss) ----------
  // Clearing all five pinball tables earns the last gate: blackjack vs. the True God Gamer,
  // best of five, win four to be crowned. The pure rules/progression live in
  // BLACKJACK (src/js/blackjack.js); this section is the DOM shell -- it renders
  // the felt, wires Hit/Stand/Next, and folds each settled hand into the match.
  //   pinDone (victory) -> startBlackjack() -> state "blackjack"
  //   Hit/Stand -> hand settles -> Next applies the result
  //   4 wins -> finishBlackjack(true);  2nd loss -> finishBlackjack(false)
  //   finishBlackjack() -> endGame()  (the existing rank screen, reused)
  function startBlackjack() {
    game.pin = null;            // pinball phase is over; stop drawing the table
    game.advancing = false;
    game.bjPlayed = true;
    game.blackjackWon = false;
    game.bj = BLACKJACK.createGame(game.seed);
    game.state = "blackjack";
    el.hud.classList.add("hidden");
    el.hud.setAttribute("aria-hidden", "true");
    setStage(4);
    bjRender();
    show(el.screenBlackjack, true);
    chord([523, 659, 784], 0.16);
    playVoiceLine();
  }

  var BJ_SUITS = { S: "♠", H: "♥", D: "♦", C: "♣" };

  function bjSuitSymbol(suit) { return BJ_SUITS[suit] || suit; }

  // Render one seat's cards. When hideLast is set (the dealer's hole during the
  // player's turn) the final card draws as a face-down back.
  function renderBjHand(container, cards, hideLast) {
    container.textContent = "";
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      var d = document.createElement("div");
      if (hideLast && i === cards.length - 1) {
        d.className = "bj-card bj-hole";
        d.textContent = "★";   // star back
      } else {
        d.className = "bj-card" + (c.red ? " red" : "");
        var rank = document.createElement("span");
        rank.className = "bj-rank";
        rank.textContent = c.rank;
        var suit = document.createElement("span");
        suit.className = "bj-suit";
        suit.textContent = bjSuitSymbol(c.suit);
        d.append(rank, suit);
      }
      container.appendChild(d);
    }
  }

  function bjTotalText(cards, hideHole) {
    if (!cards.length) return "";
    if (hideHole) return "Shows " + BLACKJACK.handValue([cards[0]]).total;
    var v = BLACKJACK.handValue(cards);
    if (v.total > 21) return "Bust (" + v.total + ")";
    if (BLACKJACK.isBlackjack(cards)) return "Blackjack!";
    return (v.soft ? "Soft " : "") + v.total;
  }

  function bjPips(n, total) {
    var s = "";
    for (var i = 0; i < total; i++) s += (i < n ? "●" : "○");
    return s;
  }

  function bjResultText(g, r) {
    if (r === "win") {
      return (g.roundsWon + 1 >= BLACKJACK.ROUNDS_TO_WIN)
        ? "FOURTH WIN — you beat the True God Gamer!"
        : "You take the hand.";
    }
    if (r === "lose") {
      return (g.roundsLost + 1 > BLACKJACK.LOSSES_ALLOWED)
        ? "The True God Gamer wins. Your God Gamer run ends here."
        : "The True God Gamer takes it — one loss left to give.";
    }
    return "Push. Doesn't count — re-deal.";
  }

  function bjNextLabel(g, r) {
    if (r === "win" && g.roundsWon + 1 >= BLACKJACK.ROUNDS_TO_WIN) return "Claim your rank";
    if (r === "lose" && g.roundsLost + 1 > BLACKJACK.LOSSES_ALLOWED) return "See your rank";
    if (r === "push") return "Re-deal";
    return "Next hand";
  }

  // Drive a wig meter (the slots / blackjack progress gauge). seat in [0,1]
  // rides in on the --seat custom property; at a full seat the CSS flips from
  // the in-flight animation (dangle / spin) to the settle. Decorative, so a
  // missing node is a no-op rather than a throw.
  function setWigSeat(meter, seat) {
    if (!meter) return;
    var s = seat < 0 ? 0 : seat > 1 ? 1 : seat;
    meter.style.setProperty("--seat", s);
    meter.classList.toggle("is-seated", s >= 0.999);
  }

  // How far the wig has settled onto Hexy in the blackjack final boss: each hand
  // banked off the True God Gamer drops it a notch, a loss hauls it back up, and
  // clinching the match (ROUNDS_TO_WIN wins) seats it fully -- the crown moment.
  // A revealed-but-unapplied result counts immediately so the wig reacts the
  // instant a hand is won or lost (and so the clinching win seats it fully
  // before the screen hands off to the slot machine).
  function bjWigProgress(g) {
    if (!g) return 0;
    var won = g.roundsWon, lost = g.roundsLost;
    if (g.phase === "result") {
      if (g.result === "win") won += 1;
      else if (g.result === "lose") lost += 1;
    }
    if (won >= BLACKJACK.ROUNDS_TO_WIN) return 1;
    var net = won - lost;
    return (net < 0 ? 0 : net) / BLACKJACK.ROUNDS_TO_WIN;
  }

  function bjRender() {
    var g = game.bj;
    if (!g) return;
    el.bjPipsWin.textContent = bjPips(g.roundsWon, BLACKJACK.ROUNDS_TO_WIN);
    el.bjPipsLoss.textContent = bjPips(g.roundsLost, BLACKJACK.LOSSES_ALLOWED + 1);
    setWigSeat(el.bjWig, bjWigProgress(g));

    renderBjHand(el.bjDealerCards, g.dealer, g.dealerHole);
    el.bjDealerTotal.textContent = bjTotalText(g.dealer, g.dealerHole);
    renderBjHand(el.bjPlayerCards, g.player, false);
    el.bjPlayerTotal.textContent = bjTotalText(g.player, false);

    var settled = g.phase === "result";
    show(el.btnBjHit, !settled);
    show(el.btnBjStand, !settled);
    show(el.btnBjNext, settled);
    if (settled) {
      el.bjResult.textContent = bjResultText(g, g.result);
      el.bjResult.className = "bj-result is-" + g.result;
      el.btnBjNext.textContent = bjNextLabel(g, g.result);
    } else {
      el.bjResult.textContent = "";
      el.bjResult.className = "bj-result";
    }
  }

  function afterBjPlayerAction() {
    bjRender();
    if (game.bj.phase === "result") onBjSettled();
  }

  function onBjSettled() {
    var r = game.bj.result;
    if (r === "win") {
      sfxPin(1000);
      fart();
      spawnConfettiAt(view.w / 2, view.h * 0.32, 0.7);
    } else if (r === "lose") {
      sfxMiss();
      game.shake = reduceMotion ? 0 : 12;
    } else {
      beep(440, 0.12, "triangle", 0.12);
    }
    playVoiceLine();
  }

  function bjHit() {
    var g = game.bj;
    if (!g || g.phase !== "player") return;
    BLACKJACK.hit(g);
    afterBjPlayerAction();
  }

  function bjStand() {
    var g = game.bj;
    if (!g || g.phase !== "player") return;
    BLACKJACK.stand(g);
    afterBjPlayerAction();
  }

  function bjNext() {
    var g = game.bj;
    if (!g || g.phase !== "result") return;
    // Every hand won off the True God Gamer banks points toward the final score.
    // The GOD GAMER crown is gated on winning the match (see endGame), not on
    // these points -- they only feed the rank ladder and the leaderboard.
    if (g.result === "win") {
      game.score += BLACKJACK.WIN_POINTS;
      game.bjBonus += BLACKJACK.WIN_POINTS;
    }
    BLACKJACK.applyResult(g);
    if (g.complete) {
      // Clinching the match without dropping a hand banks the sweep bonus, so a
      // flawless 4-0 tops a 4-1 win -- doing better pays even at the felt.
      var sweep = BLACKJACK.sweepBonus(g);
      if (sweep > 0) { game.score += sweep; game.bjBonus += sweep; }
      finishBlackjack(true); return;
    }
    if (g.failed) { finishBlackjack(false); return; }
    BLACKJACK.newHand(g);
    bjRender();
    chord([392, 523, 659], 0.12);
    playVoiceLine();
  }

  function finishBlackjack(won) {
    game.blackjackWon = won;
    game.bj = null;
    show(el.screenBlackjack, false);
    // Beating the True God Gamer earns the final gauntlet leg: the slot machine.
    // A loss ends the run here (the rank screen), mirroring how blackjack itself
    // is gated on a pinball victory.
    if (won) startSlots();
    else endGame();
  }

  // ---------- Slot-machine finale ----------
  // The last leg of the GOD GAMER gauntlet. The pure credit/bet/rig logic lives
  // in SLOT (src/js/slots.js); this section is the I/O shell: bet/spin buttons
  // -> SLOT mutators, results -> DOM render + animated juice. Flow:
  //   finishBlackjack(true) -> startSlots() -> state "slots"
  //   spin -> roll animation -> settle -> (reach 2000 / still in the red?) ...
  //   finishSlots(true)  reached 2000 (GOD GAMER leg cleared)
  //   finishSlots(false) ended in the red (bust: leg failed)
  //   finishSlots(won) -> endGame()  (the existing rank screen, reused)
  //
  // slotCells[col][row] caches the live cell <div>s so the roll animation can
  // re-glyph them per frame without rebuilding the grid (which would reset the
  // CSS animations). slotAnim holds the in-flight spin's animation state, or null.
  var slotCells = [];
  var slotAnim = null;
  var slotFlashEl = null;

  // Paint a single reel cell. Paying symbols render as their glyph; the two SPECIAL
  // symbols (Hexy's bald head, the golden wig) render as their image, reusing the
  // cell's <img> across repaints so the roll/lock churn stays cheap.
  function paintSlotCell(cell, symIndex) {
    var s = SLOT.SYMBOLS[symIndex];
    if (s && s.img) {
      var img = cell.firstChild;
      if (!img || img.tagName !== "IMG") {
        cell.textContent = "";
        img = document.createElement("img");
        img.className = "slots-sym-img";
        img.alt = ""; img.draggable = false;
        cell.appendChild(img);
      }
      if (img.getAttribute("src") !== s.img) img.setAttribute("src", s.img);
    } else {
      cell.textContent = s ? s.glyph : "";
    }
  }

  function fmtSigned(n) { return n >= 0 ? "+" + n : "" + n; }

  // A brief full-stage colour wash keyed to the spin's outcome -- the loudest, most
  // reliably-visible cue since it lives inside the slots panel (the canvas confetti
  // sits behind it). Re-armed each call so back-to-back spins always flash.
  function flashSlots(kind) {
    if (reduceMotion) return;
    var stage = el.slotsGrid && el.slotsGrid.parentNode;
    if (!stage) return;
    if (!slotFlashEl || slotFlashEl.parentNode !== stage) {
      slotFlashEl = document.createElement("div");
      slotFlashEl.className = "slots-flash";
      stage.appendChild(slotFlashEl);
    }
    slotFlashEl.className = "slots-flash";
    void slotFlashEl.offsetWidth;                 // restart the animation
    slotFlashEl.classList.add("is-" + kind);
  }

  // A short DOM shake of the reel stage -- the canvas shake (game.shake) can't move
  // the HTML overlay, so a penalty/jackpot gets its jolt here instead.
  function shakeSlots(strength) {
    if (reduceMotion) return;
    var stage = el.slotsGrid && el.slotsGrid.parentNode;
    if (!stage) return;
    stage.classList.remove("slots-shake-hard", "slots-shake-soft");
    void stage.offsetWidth;
    stage.classList.add(strength === "hard" ? "slots-shake-hard" : "slots-shake-soft");
  }

  // Count the credits readout up (or down) to its settled value -- a small bit of
  // juice that makes a win feel earned and a penalty feel like it bites.
  function animateCredits(from, to) {
    var n = el.slotsCredits;
    if (!n) return;
    if (reduceMotion || from === to) {
      n.textContent = to;
      n.classList.toggle("is-debt", to < 0);
      return;
    }
    n.textContent = from;
    n.classList.toggle("is-debt", from < 0);
    var dur = 520, t0 = null;
    function step(ts) {
      if (game.state !== "slots") { n.textContent = to; return; }
      if (t0 === null) t0 = ts;
      var p = Math.min(1, (ts - t0) / dur);
      var e = 1 - Math.pow(1 - p, 3);             // easeOutCubic
      var v = Math.round(from + (to - from) * e);
      n.textContent = v;
      n.classList.toggle("is-debt", v < 0);
      if (p < 1) requestAnimationFrame(step);
      else { n.textContent = to; n.classList.toggle("is-debt", to < 0); }
    }
    requestAnimationFrame(step);
  }

  function startSlots() {
    game.advancing = false;
    game.slotPlayed = true;
    game.slotWon = false;
    game.slotBonus = 0;
    game.slot = SLOT.createGame(game.seed);
    game.state = "slots";
    slotAnim = null;
    el.hud.classList.add("hidden");
    el.hud.setAttribute("aria-hidden", "true");
    setStage(5);
    slotsRender();
    show(el.screenSlots, true);
    // The grid is display:none until the line above, and the browser's first
    // layout pass can briefly use a provisional viewport. Force the layout, then
    // redraw the overlay across the next frames and once more after a short
    // settle, so the paylines land on the final cell box at any size.
    schedulePaylines();
    chord([523, 659, 784, 988], 0.16);
    playVoiceLine();
  }

  // Redraw the payline overlay across a couple of frames plus a short settle.
  // drawPaylines() is idempotent and cheap (it re-measures each call), so the
  // last pass always wins -- the overlay tracks the grid's final box.
  function schedulePaylines() {
    void el.slotsGrid.offsetWidth;                 // flush any pending layout
    requestAnimationFrame(function () {
      drawPaylines();
      requestAnimationFrame(drawPaylines);
    });
    setTimeout(function () { if (game.state === "slots") drawPaylines(); }, 250);
  }

  // Render the 5x5 grid, the credit/bet/lines readouts, the progress bar toward
  // 2000, and the last spin's result. Mirrors bjRender(): pure DOM, no canvas.
  function slotsRender() {
    var g = game.slot;
    if (!g) return;
    var lr = g.lastResult;
    // Tag each winning cell with its payline's hue (same formula drawPaylines uses
    // for the bright overlay stroke), so a cell glows in the exact colour of the
    // line it belongs to. Each winning line is a single symbol along one path, and
    // distinct lines always use distinct symbols -- colouring per line is what lets
    // the eye separate two lines that interleave across the same rows (e.g. a rat
    // zigzag crossing a wig zigzag), instead of reading the mixed strip as one row
    // where the rat looks like a wild.
    var cellTag = {};
    if (lr) {
      for (var w = 0; w < lr.winningLines.length; w++) {
        var wl = lr.winningLines[w];
        var lineHue = Math.round((wl.lineIndex / SLOT.MAX_LINES) * 330);
        for (var c = 0; c < wl.count; c++) cellTag[wl.line[c] + "," + c] = { cls: "is-win", hue: lineHue };
      }
      // Special cells get their own marker: a bald line glows danger-red, a golden-wig
      // line glows gold -- so the grid itself shows which line helped and which hurt.
      var sls = lr.specialLines || [];
      for (var sx = 0; sx < sls.length; sx++) {
        var sp = sls[sx];
        for (var sc = 0; sc < sp.count; sc++) {
          cellTag[sp.line[sc] + "," + sc] = { cls: sp.kind === "bonus" ? "is-bonus" : "is-bald" };
        }
      }
    }
    // Reels: one column element per reel, five symbol cells each. Cache the cells
    // for the roll animation + payline measurement.
    el.slotsGrid.textContent = "";
    slotCells = [];
    for (var col = 0; col < SLOT.REELS; col++) {
      var reel = document.createElement("div");
      reel.className = "slots-reel";
      slotCells[col] = [];
      for (var row = 0; row < SLOT.ROWS; row++) {
        var cell = document.createElement("div");
        var tag = cellTag[row + "," + col];
        cell.className = "slots-cell" + (tag ? " " + tag.cls : "");
        if (tag && tag.hue !== undefined) cell.style.setProperty("--win-hue", tag.hue);
        paintSlotCell(cell, g.grid[row][col]);
        reel.appendChild(cell);
        slotCells[col][row] = cell;
      }
      el.slotsGrid.appendChild(reel);
    }

    var cost = SLOT.spinCost(g);
    el.slotsCredits.textContent = g.credits;
    el.slotsCredits.classList.toggle("is-debt", g.credits < 0);
    el.slotsLines.textContent = g.lines;
    el.slotsBet.textContent = SLOT.betPerLine(g);
    el.slotsCost.textContent = cost;
    var pct = Math.max(0, Math.min(1, (g.credits - SLOT.START_CREDITS) /
      (SLOT.TARGET_CREDITS - SLOT.START_CREDITS)));
    setWigSeat(el.slotsWig, pct);

    // Result banner: a paying win is green, the golden-wig bonus gold, the bald-head
    // penalty an unmistakable red callout, a plain loss red, the pre-spin state neutral.
    if (lr) {
      if (lr.win) {
        el.slotsResult.textContent = "+" + lr.payout + "  (net +" + lr.delta + ")";
        el.slotsResult.className = "slots-result is-win";
      } else if (lr.kind === "bonus") {
        el.slotsResult.textContent = "✨ GOLDEN WIG! +" + lr.bonus +
          " bonus credits  (net " + fmtSigned(lr.delta) + ") ✨";
        el.slotsResult.className = "slots-result is-bonus";
      } else if (lr.kind === "bald") {
        el.slotsResult.textContent = "💀 BALD HEXY! −" + lr.penalty +
          " — a row of his bare head COSTS you  (net " + lr.delta + ")";
        el.slotsResult.className = "slots-result is-bald";
      } else {
        el.slotsResult.textContent = "No pay — " + lr.cost + " gone";
        el.slotsResult.className = "slots-result is-lose";
      }
    } else {
      el.slotsResult.textContent = "Turn 1000 into 2000. Or go home broke.";
      el.slotsResult.className = "slots-result";
    }

    // The spin button is disabled only when even the smallest allowed stake would
    // breach the debt limit -- so the player can always act (lower the bet).
    var canSpin = SLOT.canSpin(g);
    el.btnSlotsSpin.disabled = !canSpin;
    el.btnSlotsSpin.classList.toggle("is-disabled", !canSpin);

    // Debt-risk warning: the stake is allowed but dips below zero, so a losing
    // spin would end the run. Or the stake is over the limit entirely.
    updateSlotWarning(g, cost, canSpin);

    // Repaint the active paylines (next frame, once layout settles).
    requestAnimationFrame(drawPaylines);
  }

  function updateSlotWarning(g, cost, canSpin) {
    if (!el.slotsWarn) return;
    var msg = "";
    if (!canSpin) {
      msg = "⚠ That stake's over the limit — lower the bet or fewer lines to spin.";
    } else if (g.credits - cost < 0) {
      msg = "⚠ This stake dips into debt (" + (g.credits - cost) +
        ") — a losing spin ends the run. Lower the bet to play it safe.";
    }
    el.slotsWarn.textContent = msg;
    show(el.slotsWarn, !!msg);
  }

  // Subtle SVG overlay of the active paylines, drawn through measured cell
  // centers so it stays aligned at any size. Each line gets its own hue (a quiet
  // rainbow), and the spin's winning lines are drawn bright on top. Recomputed
  // whenever the line count changes or the window resizes.
  function drawPaylines() {
    var g = game.slot;
    var svg = el.slotsOverlay;
    if (!g || !svg) return;
    var gridRect = el.slotsGrid.getBoundingClientRect();
    if (gridRect.width < 4 || gridRect.height < 4) return;   // not laid out yet
    svg.setAttribute("viewBox", "0 0 " + gridRect.width + " " + gridRect.height);
    // Measure each cell center once, relative to the grid box.
    var cx = [], cy = [];
    for (var col = 0; col < SLOT.REELS; col++) {
      cx[col] = []; cy[col] = [];
      for (var row = 0; row < SLOT.ROWS; row++) {
        var cell = slotCells[col] && slotCells[col][row];
        if (!cell) { return; }
        var r = cell.getBoundingClientRect();
        cx[col][row] = (r.left + r.right) / 2 - gridRect.left;
        cy[col][row] = (r.top + r.bottom) / 2 - gridRect.top;
      }
    }
    var lr = g.lastResult;
    // lineIndex -> winning run length. A win is only the LEFT-ANCHORED run of
    // `count` cells (often 3 or 4, not the whole 5-cell line), so the bright
    // overlay must stop at `count` -- drawing it across the full shape would run
    // it through the trailing columns over symbols that never matched, making an
    // invalid tail cell look like it completed the line.
    var wonCount = {};
    if (lr) for (var k = 0; k < lr.winningLines.length; k++) {
      wonCount[lr.winningLines[k].lineIndex] = lr.winningLines[k].count;
    }
    var lines = SLOT.activeLines(g);
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var SVGNS = "http://www.w3.org/2000/svg";

    function pointsFor(line, len) {
      var pts = "";
      for (var c = 0; c < len; c++) {
        pts += cx[c][line[c]].toFixed(1) + "," + cy[c][line[c]].toFixed(1) + " ";
      }
      return pts.trim();
    }
    function stroke(pts, color, width, opacity, cls) {
      var pl = document.createElementNS(SVGNS, "polyline");
      pl.setAttribute("points", pts);
      pl.setAttribute("fill", "none");
      pl.setAttribute("stroke", color);
      pl.setAttribute("stroke-width", width);
      pl.setAttribute("stroke-opacity", opacity);
      pl.setAttribute("stroke-linejoin", "round");
      pl.setAttribute("stroke-linecap", "round");
      if (cls) pl.setAttribute("class", cls);
      svg.appendChild(pl);
    }

    // Every active payline as a full-shape guide (what you're betting on) -- bright
    // enough to actually follow on the busy 30-line board, each in its own hue.
    for (var i = 0; i < lines.length; i++) {
      var hue = Math.round((i / SLOT.MAX_LINES) * 330);
      stroke(pointsFor(lines[i], SLOT.REELS), "hsl(" + hue + " 95% 66%)", "2.2", "0.5");
    }
    // ...then the winning lines on top: a dark halo first (so the bright stroke reads
    // against the glyphs it crosses), then the bright stroke in that line's hue.
    for (var j = 0; j < lines.length; j++) {
      if (Object.prototype.hasOwnProperty.call(wonCount, j)) {
        var ptsj = pointsFor(lines[j], wonCount[j]);
        var huej = Math.round((j / SLOT.MAX_LINES) * 330);
        stroke(ptsj, "rgba(0,0,0,0.6)", "7", "0.7");
        stroke(ptsj, "hsl(" + huej + " 95% 66%)", "4", "1", "win");
      }
    }
    // ...and the SPECIAL lines loudest of all: the golden-wig bonus in gold, the
    // bald-head penalty in danger-red, each haloed and pulsing.
    if (lr && lr.specialLines) {
      for (var s2 = 0; s2 < lr.specialLines.length; s2++) {
        var spl = lr.specialLines[s2];
        var spts = pointsFor(spl.line, spl.count);
        if (spl.kind === "bonus") {
          stroke(spts, "rgba(40,24,0,0.75)", "8.5", "0.85");
          stroke(spts, "hsl(44 100% 60%)", "4.6", "1", "special-bonus");
        } else {
          stroke(spts, "rgba(0,0,0,0.78)", "8.5", "0.85");
          stroke(spts, "hsl(2 96% 58%)", "4.6", "1", "special-bald");
        }
      }
    }
  }

  // Disable the bet/line controls during a roll (the spin button is owned by
  // slotsRender's canSpin check + the explicit lock at spin start).
  function setSlotsBusy(busy) {
    var btns = [el.btnSlotsLinesUp, el.btnSlotsLinesDown, el.btnSlotsBetUp,
                el.btnSlotsBetDown, el.btnSlotsMax];
    for (var i = 0; i < btns.length; i++) if (btns[i]) btns[i].disabled = busy;
  }

  function pulseCredits() {
    if (reduceMotion) return;
    var n = el.slotsCredits;
    n.classList.remove("is-pop");
    void n.offsetWidth;       // restart the animation
    n.classList.add("is-pop");
  }

  function slotAdjustLines(delta) {
    var g = game.slot;
    if (!g || g.complete || g.bust || slotAnim) return;
    SLOT.setLines(g, g.lines + delta);
    sfxClick();
    slotsRender();
  }

  function slotAdjustBet(delta) {
    var g = game.slot;
    if (!g || g.complete || g.bust || slotAnim) return;
    SLOT.setBet(g, g.betIndex + delta);
    sfxClick();
    slotsRender();
  }

  function slotMaxBet() {
    var g = game.slot;
    if (!g || g.complete || g.bust || slotAnim) return;
    // Largest bet-per-line whose full-line cost the bankroll can still cover.
    for (var idx = SLOT.BET_TIERS.length - 1; idx >= 0; idx--) {
      if (g.lines * SLOT.BET_TIERS[idx] <= g.credits) { SLOT.setBet(g, idx); break; }
    }
    sfxClick();
    slotsRender();
  }

  function slotSpin() {
    var g = game.slot;
    if (!g || g.complete || g.bust || slotAnim) return;
    if (!SLOT.canSpin(g)) return;          // over the debt limit -> button disabled
    SLOT.spin(g);                          // compute the (deterministic) result up front
    var lr = g.lastResult;
    var finalGrid = g.grid;
    var credited = lr.payout + lr.bonus - lr.penalty;
    var staked = g.credits - credited;     // balance after staking, before the grid pays/charges

    if (reduceMotion) {
      // No rolling or flashing -- reveal the result and settle immediately.
      slotsRender();
      settleSlot(lr);
      return;
    }

    // Light up the machine and start the reels rolling.
    setSlotsBusy(true);
    el.btnSlotsSpin.disabled = true;
    el.slotsGrid.classList.add("is-spinning");
    if (el.slotsOverlay) el.slotsOverlay.classList.add("is-spinning");
    el.slotsCredits.textContent = staked;
    el.slotsCredits.classList.toggle("is-debt", staked < 0);
    el.slotsResult.textContent = "Rolling…";
    el.slotsResult.className = "slots-result is-rolling";
    if (el.slotsWarn) show(el.slotsWarn, false);
    sfxSpinStart();

    // Anything but a plain loss earns an anticipation beat: the payoff reel lingers
    // and glows so a win/bonus/penalty lands with a drumroll instead of a flat stop.
    var anticipate = lr.win || lr.kind === "bonus" || lr.kind === "bald";
    var base = 480, stagger = 190;
    var stopAt = [base, base + stagger, base + 2 * stagger, base + 3 * stagger, base + 4 * stagger];
    if (anticipate) stopAt[SLOT.REELS - 1] += 340;
    slotAnim = {
      start: 0, lastFlick: 0, lastTick: 0,
      finalGrid: finalGrid, lr: lr, anticipate: anticipate, anticipated: false,
      stopAt: stopAt,
      stopped: [false, false, false, false, false]
    };
    requestAnimationFrame(slotAnimFrame);
  }

  var SLOT_FLICK_MS = 55;
  function slotAnimFrame(ts) {
    var a = slotAnim, g = game.slot;
    if (!a || !g) { slotAnim = null; return; }
    if (!a.start) { a.start = ts; a.lastFlick = ts; a.lastTick = ts; }
    var elapsed = ts - a.start;

    // Lock reels left-to-right as each one's stop time arrives.
    for (var col = 0; col < SLOT.REELS; col++) {
      if (!a.stopped[col] && elapsed >= a.stopAt[col]) {
        a.stopped[col] = true;
        lockReelColumn(col, a.finalGrid);
        sfxReelStop(col);
      }
    }
    // Drumroll: once every reel but the last has locked, glow the lone spinner and
    // sweep a rising tone so the payoff feels imminent.
    if (a.anticipate && !a.anticipated && !a.stopped[SLOT.REELS - 1]) {
      var prevAllIn = true;
      for (var pc = 0; pc < SLOT.REELS - 1; pc++) if (!a.stopped[pc]) prevAllIn = false;
      if (prevAllIn) {
        a.anticipated = true;
        var lastCells = slotCells[SLOT.REELS - 1];
        var lastReel = lastCells && lastCells[0] && lastCells[0].parentNode;
        if (lastReel) lastReel.classList.add("anticipating");
        sweep(280, 920, 0.36, "sine", 0.09);
      }
    }
    // Flicker random symbols on the reels still spinning.
    if (ts - a.lastFlick >= SLOT_FLICK_MS) {
      a.lastFlick = ts;
      for (var c2 = 0; c2 < SLOT.REELS; c2++) if (!a.stopped[c2]) flickReelColumn(c2);
      if (ts - a.lastTick >= SLOT_FLICK_MS * 1.5) { a.lastTick = ts; sfxReelTick(); }
    }
    var allStopped = true;
    for (var c3 = 0; c3 < SLOT.REELS; c3++) if (!a.stopped[c3]) allStopped = false;
    if (allStopped) { endSlotAnim(); return; }
    requestAnimationFrame(slotAnimFrame);
  }

  function flickReelColumn(col) {
    var cells = slotCells[col];
    if (!cells) return;
    // The blur shows only the PAYING glyphs, so a bald head / golden wig is a
    // surprise that resolves on the lock rather than flashing past in the roll.
    for (var row = 0; row < SLOT.ROWS; row++) {
      cells[row].textContent = SLOT.SYMBOLS[(Math.random() * SLOT.PAY_SYMBOLS) | 0].glyph;
    }
  }

  function lockReelColumn(col, finalGrid) {
    var cells = slotCells[col];
    if (!cells) return;
    for (var row = 0; row < SLOT.ROWS; row++) {
      paintSlotCell(cells[row], finalGrid[row][col]);
    }
    var reel = cells[0] && cells[0].parentNode;
    if (reel) {
      reel.classList.remove("anticipating");
      reel.classList.remove("just-stopped"); void reel.offsetWidth; reel.classList.add("just-stopped");
    }
  }

  function endSlotAnim() {
    slotAnim = null;
    el.slotsGrid.classList.remove("is-spinning");
    if (el.slotsOverlay) el.slotsOverlay.classList.remove("is-spinning");
    var lr = game.slot ? game.slot.lastResult : null;
    slotsRender();               // final grid + win highlights + readouts + overlay
    if (lr) settleSlot(lr);
  }

  // The payoff, shared by the animated and reduced-motion paths. Each outcome gets a
  // distinct sound + light: green win, GOLD jackpot, RED penalty, flat loss -- and the
  // credits readout counts to its settled value so the swing reads on the meter.
  function settleSlot(lr) {
    var g = game.slot;
    var credited = lr.payout + lr.bonus - lr.penalty;
    if (g) animateCredits(g.credits - credited, g.credits);
    if (lr.win) {
      sfxPin(900 + Math.min(600, lr.payout));
      pulseCredits();
      if (lr.delta >= lr.cost * 3) {            // a big hit gets the full celebration
        fart();
        spawnConfettiAt(view.w / 2, view.h * 0.30, 0.9);
        game.shake = reduceMotion ? 0 : 8;
        flashSlots("win-big");
        burstWinCells();
      } else {
        chord([523, 659, 784], 0.1);
        flashSlots("win");
      }
    } else if (lr.kind === "bonus") {
      sfxJackpot();
      pulseCredits();
      spawnConfettiAt(view.w / 2, view.h * 0.30, 1.1);
      flashSlots("bonus");
      shakeSlots("soft");
      burstWinCells();
    } else if (lr.kind === "bald") {
      sfxBald();
      pulseCredits();
      flashSlots("bald");
      shakeSlots("hard");
      game.shake = reduceMotion ? 0 : 10;
      playVoiceLine();        // a voice line piles on while the bare head bites
    } else {
      sfxMiss();
      playVoiceLine();        // a random voice line razzes the player on a loss
    }
    if (!g) return;
    if (g.complete) { setTimeout(function () { onSlotResolved(true); }, 800); return; }
    if (g.bust) { setTimeout(function () { onSlotResolved(false); }, 800); return; }
    setSlotsBusy(false);          // ready for the next spin
  }

  // Re-arm the pop on every resolved cell (win or special) so they punch in together
  // a beat after the reels lock, instead of only animating on first paint.
  function burstWinCells() {
    if (reduceMotion) return;
    setTimeout(function () {
      if (game.state !== "slots") return;
      for (var col = 0; col < slotCells.length; col++) {
        var cells = slotCells[col];
        if (!cells) continue;
        for (var row = 0; row < cells.length; row++) {
          var cell = cells[row];
          if (!cell || !/is-(win|bonus|bald)/.test(cell.className)) continue;
          cell.classList.remove("cell-burst");
          void cell.offsetWidth;
          cell.classList.add("cell-burst");
        }
      }
    }, 130);
  }

  function onSlotResolved(won) {
    // Brief beat so the final reels/credits register before the rank screen.
    if (won) {
      chord([659, 784, 988, 1318, 1568], 0.3);
      spawnConfettiAt(view.w / 2, view.h * 0.32, 1);
    } else {
      game.shake = reduceMotion ? 0 : 14;
    }
    playVoiceLine();
    finishSlots(won);
  }

  function finishSlots(won) {
    game.slotWon = won;
    game.slotBonus = SLOT.slotBonus(game.slot);
    game.score += game.slotBonus;
    game.slot = null;
    show(el.screenSlots, false);
    endGame();
  }

  // ---------- Update ----------
  function update(dt) {
    if (game.state === "countdown") {
      game.countT -= dt;
      // "3" -> "2" -> "1" -> "GO" (held ~0.45s), then live play begins.
      const label = game.countT > 0 ? String(Math.ceil(game.countT)) : "GO";
      if (label !== game.countLabel) {
        game.countLabel = label;
        el.countNum.textContent = label;
        el.countNum.classList.toggle("go", label === "GO");
        pulseCountdown();
        beep(label === "GO" ? 720 : 440, 0.09, "triangle", 0.14);
      }
      if (game.countT <= -0.45) startPlaying();
    } else if (game.state === "playing") {
      game.roundClock -= dt;
      const frac = Math.max(0, game.roundClock / game.roundTime);
      el.timerFill.style.transform = "scaleX(" + frac + ")";
      el.timerFill.style.background = frac < 0.3
        ? "linear-gradient(90deg, var(--accent), var(--warn))"
        : "linear-gradient(90deg, var(--good), var(--warn))";
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
    } else if (game.state === "pinPlaying") {
      updatePinball(dt);
    } else if (game.state === "pinCapture" || game.state === "pinDone") {
      game.lockT -= dt;
      if (game.lockT <= 0) {
        if (game.state === "pinCapture") advancePinTable();
        else if (game.pinVictory) startBlackjack();   // cleared all five -> final boss
        else endGame();                               // ran out of balls -> scoreboard
      }
    } else if (game.state === "feedPlaying") {
      updateFeedMolly(dt);
    } else if (game.state === "feedResult" || game.state === "feedDone") {
      game.lockT -= dt;
      if (game.lockT <= 0) {
        if (game.state === "feedResult") advanceFeedCan();
        else finishFeedHandoff();                      // cleared -> pinball, else scoreboard
      }
    }

    // The aim target IS the head graphic's crown point -- track it exactly so a
    // bullseye pins the wig where it visually belongs. A smoothed follower used
    // to live here, but its lag left the reticle (and the score target) trailing
    // behind the moving head, so a "perfect" pin landed off the actual forehead.
    if (hexy.w > 0 &&
        (game.state === "countdown" || game.state === "playing" ||
         game.state === "roundEnd" || game.state === "roundCard")) {
      const ht = headTarget();
      game.aimX = ht.x;
      game.aimY = ht.y;
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

    if (game.pin) {
      drawPinball();
    } else if (game.feed) {
      drawFeedMolly();
    } else {
      drawSpotlight();
      if (game.state === "countdown" || game.state === "playing" ||
          game.state === "roundEnd" || game.state === "roundCard") {
        drawWarpTelegraph();
        drawHexy();
        drawReticle();  // on top of Hexy so it stays visible when he bounces over it
        drawWig();
      }
    }

    drawConfetti();
    ctx.restore();
  }

  function drawSpotlight() {
    if (!hexy.w) return;
    const cx = hexy.x + hexy.w / 2;
    const cy = hexy.y + hexy.h / 2;
    const r = hexy.w * 2.2;
    const grd = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r);
    grd.addColorStop(0, "rgba(254, 0, 0, 0.22)");
    grd.addColorStop(1, "rgba(254, 0, 0, 0)");
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
    tickMusicUi();
    requestAnimationFrame(frame);
  }

  // ---------- Input ----------
  function localPoint(e) {
    const r = canvas.getBoundingClientRect();
    pointer.x = e.clientX - r.left;
    pointer.y = e.clientY - r.top;
  }

  function onDown(e) {
    if (game.state === "feedPlaying") { e.preventDefault(); attemptFeed(); return; }
    if (game.state === "pinPlaying") {
      e.preventDefault();
      localPoint(e);
      // Ball parked -> any press charges the plunger; ball live -> left/right
      // screen-half works that flipper. Keyed by pointerId for multitouch.
      if (!game.pin.ball.live) {
        pin.launchHeld = true;
        pin.ptr[e.pointerId] = "plunger";
      } else {
        const side = pointer.x < view.w / 2 ? "left" : "right";
        if (side === "left") pin.leftDown = true; else pin.rightDown = true;
        pin.ptr[e.pointerId] = side;
      }
      if (canvas.setPointerCapture && e.pointerId != null) {
        try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
      }
      return;
    }
    if (game.state !== "playing" || wig.stuck) return;
    e.preventDefault();
    localPoint(e);
    wig.held = true;
    canvas.classList.add("grabbing");
    if (canvas.setPointerCapture && e.pointerId != null) {
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    }
    sfxGrab();
  }

  function onMove(e) {
    if (!wig.held) return;
    localPoint(e);
  }

  function onUp(e) {
    if (game.state === "pinPlaying" || (e && e.pointerId != null && pin.ptr[e.pointerId])) {
      releasePinPointer(e ? e.pointerId : null);
      return;
    }
    if (!wig.held || game.state !== "playing") return;
    e.preventDefault();
    localPoint(e);
    wig.held = false;
    canvas.classList.remove("grabbing");
    evaluatePin();
  }

  // Release whatever control a lifted/cancelled pointer was holding. A plunger
  // release fires the launch on the next step; flippers just drop.
  function releasePinPointer(pointerId) {
    const role = pointerId != null ? pin.ptr[pointerId] : null;
    if (role === "plunger") { pin.launchHeld = false; pin.launchReleased = true; }
    else if (role === "left") pin.leftDown = false;
    else if (role === "right") pin.rightDown = false;
    if (pointerId != null) delete pin.ptr[pointerId];
  }

  canvas.addEventListener("pointerdown", onDown);
  window.addEventListener("pointerdown", () => {
    if (game.state === "roundCard") proceed();
    else if (game.state === "pinIntro") beginPinPlay();   // tap anywhere to launch in
    else if (game.state === "feedIntro") beginFeedPlay();  // tap anywhere to start opening
  });
  window.addEventListener("pointermove", onMove, { passive: false });
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", (e) => {
    if (wig.held) { wig.held = false; canvas.classList.remove("grabbing"); }
    if (e && e.pointerId != null && pin.ptr[e.pointerId]) releasePinPointer(e.pointerId);
  });

  el.btnStart.addEventListener("click", () => { sfxClick(); startGame(); });
  el.btnAgain.addEventListener("click", () => { sfxClick(); startGame(); });
  el.btnRoundNext.addEventListener("click", () => { sfxClick(); proceed(); });
  if (el.btnPinStart) el.btnPinStart.addEventListener("click", () => { sfxClick(); beginPinPlay(); });
  if (el.btnFeedStart) el.btnFeedStart.addEventListener("click", () => { sfxClick(); beginFeedPlay(); });
  if (el.btnBjHit) el.btnBjHit.addEventListener("click", () => { sfxClick(); bjHit(); });
  if (el.btnBjStand) el.btnBjStand.addEventListener("click", () => { sfxClick(); bjStand(); });
  if (el.btnBjNext) el.btnBjNext.addEventListener("click", () => { sfxClick(); bjNext(); });
  if (el.btnSlotsSpin) el.btnSlotsSpin.addEventListener("click", () => { slotSpin(); });
  if (el.btnSlotsLinesUp) el.btnSlotsLinesUp.addEventListener("click", () => { slotAdjustLines(1); });
  if (el.btnSlotsLinesDown) el.btnSlotsLinesDown.addEventListener("click", () => { slotAdjustLines(-1); });
  if (el.btnSlotsBetUp) el.btnSlotsBetUp.addEventListener("click", () => { slotAdjustBet(1); });
  if (el.btnSlotsBetDown) el.btnSlotsBetDown.addEventListener("click", () => { slotAdjustBet(-1); });
  if (el.btnSlotsMax) el.btnSlotsMax.addEventListener("click", () => { slotMaxBet(); });
  el.mute.addEventListener("click", () => {
    muted = !muted;
    try { localStorage.setItem(MUTE_KEY, muted ? "1" : "0"); } catch (_) {}
    refreshMuteUI();
    if (!muted) beep(660, 0.08, "triangle", 0.15);
  });

  window.addEventListener("keydown", (e) => {
    // Don't hijack typing -- e.g. the leaderboard initials field owns its own keys.
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (game.state === "blackjack") {
      const g = game.bj;
      if (!g) return;
      if (g.phase === "player") {
        if (e.code === "KeyH" || e.code === "ArrowUp") { e.preventDefault(); bjHit(); }
        else if (e.code === "KeyS" || e.code === "ArrowDown" || e.code === "Space" || e.code === "Enter") { e.preventDefault(); bjStand(); }
      } else if (e.code === "Space" || e.code === "Enter") { e.preventDefault(); bjNext(); }
      return;
    }
    if (game.state === "slots") {
      if (e.code === "Space" || e.code === "Enter") { e.preventDefault(); slotSpin(); }
      else if (e.code === "ArrowUp") { e.preventDefault(); slotAdjustBet(1); }
      else if (e.code === "ArrowDown") { e.preventDefault(); slotAdjustBet(-1); }
      else if (e.code === "ArrowRight") { e.preventDefault(); slotAdjustLines(1); }
      else if (e.code === "ArrowLeft") { e.preventDefault(); slotAdjustLines(-1); }
      else if (e.code === "KeyM") { e.preventDefault(); slotMaxBet(); }
      return;
    }
    if (game.state === "pinIntro") {
      if (e.code === "Space" || e.code === "Enter") { e.preventDefault(); beginPinPlay(); }
      return;
    }
    if (game.state === "feedIntro") {
      if (e.code === "Space" || e.code === "Enter") { e.preventDefault(); beginFeedPlay(); }
      return;
    }
    if (game.state === "feedPlaying") {
      if (e.code === "Space" || e.code === "Enter") { e.preventDefault(); attemptFeed(); }
      return;
    }
    if (game.state === "pinPlaying") { handlePinKey(e, true); return; }
    if (e.code === "Space" || e.code === "Enter") {
      if (game.state === "start") { e.preventDefault(); startGame(); }
      else if (game.state === "gameOver") { e.preventDefault(); startGame(); }
      else if (game.state === "roundCard") { e.preventDefault(); proceed(); }
    }
  });

  window.addEventListener("keyup", (e) => {
    if (game.state === "pinPlaying") handlePinKey(e, false);
  });

  window.addEventListener("resize", resize);

  // The payline overlay is measured in pixels, and the grid only gets its real
  // box once #screen-slots is shown (and again as fonts/clamp() sizing settle).
  // A ResizeObserver redraws on every box change, so the lines always track the
  // cells -- more reliable than a one-shot measure after show().
  if (window.ResizeObserver && el.slotsGrid) {
    var slotsResizeObs = new ResizeObserver(function () {
      if (game.state === "slots" && !slotAnim) drawPaylines();
    });
    slotsResizeObs.observe(el.slotsGrid);
  }

  // ---------- Helpers ----------
  function show(node, visible) {
    node.classList.toggle("hidden", !visible);
  }

  // Gauntlet-progress badge. Stage 1 (the ten pin rounds) stays a secret -- no
  // indicator shows until the player reaches stage 2, then it counts up 2..5
  // across the remaining stages. Pass 0 (or 1) to hide it.
  function setStage(n) {
    const reveal = n >= 2;
    if (reveal) el.stageValue.textContent = n + " / " + TOTAL_STAGES;
    show(el.stageIndicator, reveal);
    el.stageIndicator.setAttribute("aria-hidden", reveal ? "false" : "true");
  }

  function updateHud() {
    if (el.roundLabel) el.roundLabel.textContent = "Round";
    el.round.textContent = game.round + " / " + TOTAL_ROUNDS;
    el.score.textContent = game.score;
    el.best.textContent = game.best;
  }

  // ---------- Music / Radio ----------
  // An always-on "radio station": the album is one looping timeline and the
  // play position comes from the wall clock, so every visit lands live. The
  // track order reshuffles each UTC day. The widget loads looking like it is
  // already playing (silent, clock-driven progress); the first interaction
  // engages real audio -- unmute jumps to the live spot, after which it is a
  // plain CD player (pause holds, skip changes track, skip-while-paused stays
  // paused). Music has its own mute, independent of the game's sound toggle.
  const radio = {
    ready: false,
    tracks: [],      // manifest order: [{file, title, duration}]
    order: [],       // playlist: indices into `tracks`, shuffled for today
    durations: [],   // normalized seconds, aligned to `order`
    album: "Hexy Radio",
    audio: null,
    pos: 0,          // index into `order`
    gen: 0,          // load generation, so stale loadedmetadata seeks no-op
    engaged: false,  // has the user taken control (left the live preview)?
    paused: false,   // CD transport state (after engage)
    musicMuted: true,
    volume: DEFAULT_MUSIC_VOL,
    accum: 0,        // audible seconds on the current track-play
    lastTime: 0,
    reachedEnd: false,
    marked: false,   // already credited this track-play as "listened"
    downloading: false,
    statusTimer: 0,
    seeking: false,  // user is dragging the progress bar
    lastPct: -1,     // last aria-valuenow we wrote (avoids per-frame churn)
    liveShown: -1,   // last on-air state painted (-1 unset / 0 off / 1 on), avoids per-frame churn
    errStreak: 0,    // consecutive unplayable tracks (auto-skip loop guard)
  };

  function trackUrl(file) { return "assets/music/" + encodeURIComponent(file); }
  function voiceUrl(file) { return "assets/voicelines/" + encodeURIComponent(file); }
  function currentMeta() { return radio.tracks[radio.order[radio.pos]] || { file: "", title: "" }; }

  async function bootMusic() {
    if (!RADIO) { console.error("Hexy Radio: src/js/radio.js failed to load -- player hidden."); return; }
    let manifest;
    try {
      const res = await fetch("assets/music/manifest.json", { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      manifest = await res.json();
    } catch (e) {
      console.info("Hexy Radio: no music manifest (" + e.message + ") -- player hidden.");
      return;
    }
    const tracks = (manifest && Array.isArray(manifest.tracks))
      ? manifest.tracks.filter((t) => t && t.file) : [];
    if (tracks.length === 0) {
      console.info("Hexy Radio: manifest has no tracks -- player hidden.");
      return;
    }
    radio.tracks = tracks;
    radio.album = manifest.album || "Hexy Radio";
    // Play the album in track order (01..N, as named in the manifest). The
    // wall-clock timeline below still derives the live position, so the loop
    // resumes where the station "would" be -- in album sequence, not shuffled.
    radio.order = tracks.map((_, i) => i);
    radio.durations = RADIO.normalizeDurations(radio.order.map((i) => tracks[i].duration));

    radio.volume = loadVolume();
    radio.audio = new Audio();
    radio.audio.preload = "auto";
    radio.audio.muted = true;
    radio.audio.volume = radio.volume;
    radio.audio.addEventListener("ended", onRadioEnded);
    radio.audio.addEventListener("timeupdate", onRadioTime);
    radio.audio.addEventListener("error", onRadioError);

    el.musicLive.addEventListener("click", onMusicLive);
    el.musicPrev.addEventListener("click", onMusicPrev);
    el.musicPlayPause.addEventListener("click", onMusicPlayPause);
    el.musicNext.addEventListener("click", onMusicNext);
    el.musicMute.addEventListener("click", onMusicMute);
    el.musicSeek.addEventListener("pointerdown", onSeekDown);
    el.musicSeek.addEventListener("pointermove", onSeekMove);
    el.musicSeek.addEventListener("pointerup", onSeekUp);
    el.musicSeek.addEventListener("pointercancel", onSeekUp);
    el.musicSeek.addEventListener("keydown", onSeekKey);
    el.musicVol.value = String(radio.volume);
    el.musicVol.addEventListener("input", onMusicVolume);
    el.musicDownload.addEventListener("click", downloadAlbum);

    const live = RADIO.livePosition(Date.now(), radio.durations, RADIO_ANCHOR_MS);
    radio.pos = live.index;
    el.musicMute.classList.add("cta-pulse");
    updateMusicMeta();
    updateMuteUi();
    updatePlayPauseUi();
    updateLiveUi();
    show(el.music, true);
    radio.ready = true;
    reconcileProgress(listenedFiles, LISTENED_KEY, radio.tracks.map((t) => t.file));
    evalAndApply(true);   // reconcile achievement totals now song count is known
  }

  // Load a track, optionally seek to an offset, optionally start playing.
  function startTrack(pos, offset, opts) {
    const a = radio.audio;
    if (!a) return;
    const n = radio.order.length;
    radio.pos = ((pos % n) + n) % n;
    radio.accum = 0;
    radio.lastTime = Math.max(0, offset || 0);
    radio.reachedEnd = false;
    radio.marked = false;
    radio.gen += 1;
    const myGen = radio.gen;
    a.muted = !!opts.muted;
    a.src = trackUrl(currentMeta().file);
    const onMeta = () => {
      if (myGen !== radio.gen) return;   // superseded by a newer load
      radio.errStreak = 0;               // this track loaded -- clear the skip guard
      if (offset && offset > 0) {
        try {
          const safe = isFinite(a.duration) ? Math.min(offset, Math.max(0, a.duration - 0.25)) : offset;
          a.currentTime = safe;
          radio.lastTime = a.currentTime;
        } catch (_) {}
      }
      if (opts.play) a.play().catch(() => {});
    };
    a.addEventListener("loadedmetadata", onMeta, { once: true });
    a.load();
    updateMusicMeta();
    updatePlayPauseUi();
  }

  function engage() {
    if (radio.engaged) return;
    radio.engaged = true;
    el.musicMute.classList.remove("cta-pulse");
  }

  function loadVolume() {
    try {
      const v = parseFloat(localStorage.getItem(MUSIC_VOL_KEY));
      if (isFinite(v) && v >= 0 && v <= 1) return v;
    } catch (_) {}
    return DEFAULT_MUSIC_VOL;
  }

  function onMusicVolume() {
    let v = parseFloat(el.musicVol.value);
    if (!isFinite(v)) v = DEFAULT_MUSIC_VOL;
    v = Math.min(1, Math.max(0, v));
    radio.volume = v;
    if (radio.audio) radio.audio.volume = v;   // persists across track changes (same element)
    try { localStorage.setItem(MUSIC_VOL_KEY, String(v)); } catch (_) {}
  }

  function onMusicMute() {
    if (!radio.engaged) {
      // Headline action: unmute jumps to the live clock position and plays.
      engage();
      radio.musicMuted = false;
      radio.paused = false;
      const live = RADIO.livePosition(Date.now(), radio.durations, RADIO_ANCHOR_MS);
      startTrack(live.index, live.offset, { play: true, muted: false });
    } else {
      radio.musicMuted = !radio.musicMuted;
      if (radio.audio) radio.audio.muted = radio.musicMuted;
    }
    updateMuteUi();
    updatePlayPauseUi();
  }

  function onMusicPlayPause() {
    if (!radio.engaged) {
      // Pausing the live preview freezes it at the live spot, still silent.
      engage();
      radio.paused = true;
      const live = RADIO.livePosition(Date.now(), radio.durations, RADIO_ANCHOR_MS);
      startTrack(live.index, live.offset, { play: false, muted: radio.musicMuted });
    } else {
      radio.paused = !radio.paused;
      const a = radio.audio;
      if (a) {
        if (radio.paused) a.pause();
        else a.play().catch(() => {});
      }
    }
    updatePlayPauseUi();
  }

  function onMusicNext() {
    engage();
    gotoTrack(RADIO.nextIndex(radio.pos, radio.order.length));
  }

  function onMusicPrev() {
    engage();
    const a = radio.audio;
    if (a && isFinite(a.currentTime) && a.currentTime > PREV_RESTART_SEC) {
      startTrack(radio.pos, 0, { play: !radio.paused, muted: radio.musicMuted });
    } else {
      gotoTrack(RADIO.prevIndex(radio.pos, radio.order.length));
    }
  }

  function gotoTrack(pos) {
    // Skip while paused selects the new track but stays paused (CD behavior).
    startTrack(pos, 0, { play: !radio.paused, muted: radio.musicMuted });
  }

  // ---------- Seeking (clickable / draggable progress bar) ----------
  function clampSeek(offset, dur) {
    if (!(dur > 0)) return 0;
    return Math.min(dur - 0.05, Math.max(0, offset));
  }

  // Where playback currently sits, in seconds -- from the audio element once
  // engaged, or from the live clock while still previewing.
  function currentOffset() {
    const a = radio.audio;
    if (radio.engaged && a && isFinite(a.currentTime)) return a.currentTime;
    const live = RADIO.livePosition(Date.now(), radio.durations, RADIO_ANCHOR_MS);
    return live.index === radio.pos ? live.offset : 0;
  }

  // Jump to an absolute offset in the current track. Scrubbing the live preview
  // takes control of the station (engage) but keeps the mute/pause state, so a
  // muted preview stays silent until the user actually unmutes.
  function seekToOffset(offset) {
    if (!radio.ready) return;
    const a = radio.audio;
    if (!radio.engaged) {
      const dur = radio.durations[radio.pos] || 0;
      engage();
      startTrack(radio.pos, clampSeek(offset, dur), { play: !radio.paused, muted: radio.musicMuted });
    } else {
      if (!a) return;
      const dur = (isFinite(a.duration) && a.duration > 0) ? a.duration : (radio.durations[radio.pos] || 0);
      if (dur <= 0) return;
      const target = clampSeek(offset, dur);
      try { a.currentTime = target; } catch (_) {}
      radio.lastTime = target;   // the jump must not count as audible listen progress
    }
  }

  function seekFromClientX(clientX) {
    const rect = el.musicSeek.getBoundingClientRect();
    if (rect.width <= 0) return;
    let frac = (clientX - rect.left) / rect.width;
    frac = Math.min(1, Math.max(0, frac));
    const a = radio.audio;
    const dur = (radio.engaged && a && isFinite(a.duration) && a.duration > 0)
      ? a.duration : (radio.durations[radio.pos] || 0);
    seekToOffset(frac * dur);
  }

  function onSeekDown(e) {
    if (!radio.ready) return;
    e.preventDefault();
    e.stopPropagation();   // don't also trip the roundCard "tap anywhere to advance"
    radio.seeking = true;
    if (el.musicSeek.setPointerCapture && e.pointerId != null) {
      try { el.musicSeek.setPointerCapture(e.pointerId); } catch (_) {}
    }
    seekFromClientX(e.clientX);
  }

  function onSeekMove(e) {
    if (!radio.seeking) return;
    seekFromClientX(e.clientX);
  }

  function onSeekUp() { radio.seeking = false; }

  function onSeekKey(e) {
    let delta;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") delta = -5;
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") delta = 5;
    else if (e.key === "Home") delta = -Infinity;
    else if (e.key === "End") delta = Infinity;
    else return;
    e.preventDefault();
    seekToOffset(currentOffset() + delta);
  }

  function onRadioEnded() {
    radio.reachedEnd = true;
    creditListenIfQualified();
    // Continuous album: roll into the next track, preserving transport state.
    gotoTrack(RADIO.nextIndex(radio.pos, radio.order.length));
  }

  // A missing or unplayable file must not freeze the station -- skip past it,
  // preserving the play/pause state. Manifests are auto-rebuilt on launch, so
  // this is a safety net for a track that vanished or failed to decode.
  function onRadioError() {
    const a = radio.audio;
    if (!radio.ready || !a || !a.error) return;   // only act on a real media error
    const meta = currentMeta();
    console.warn("Hexy Radio: skipping unplayable track '" + (meta.file || "?") + "'.");
    radio.errStreak += 1;
    if (radio.errStreak >= radio.order.length) {
      // A full cycle failed to load -- stop rather than spin through 404s forever.
      radio.errStreak = 0;
      try { a.pause(); } catch (_) {}
      radio.paused = true;
      setMusicStatus("No playable tracks found.", true);
      updatePlayPauseUi();
      return;
    }
    gotoTrack(RADIO.nextIndex(radio.pos, radio.order.length));
  }

  function onRadioTime() {
    const a = radio.audio;
    if (!a || !radio.engaged) return;
    const t = a.currentTime;
    const dt = t - radio.lastTime;
    radio.lastTime = t;
    // Count only forward, audible progress (seek gaps are ignored).
    if (dt > 0 && dt < 2 && !a.muted && !a.paused) {
      radio.accum += dt;
      creditListenIfQualified();
    }
  }

  function creditListenIfQualified() {
    if (radio.marked || !ACH) return;
    if (ACH.qualifiesAsListened(radio.accum, radio.reachedEnd)) {
      radio.marked = true;
      markSongListened(currentMeta().file);
    }
  }

  function updateMusicMeta() {
    el.musicTitle.textContent = currentMeta().title || "—";
    el.musicDur.textContent = RADIO.formatTime(radio.durations[radio.pos] || 0);
  }

  function updateMuteUi() {
    el.musicMuteGlyph.innerHTML = radio.musicMuted ? "&#128263;" : "&#128266;";
    el.musicMute.classList.toggle("muted", radio.musicMuted);
    const label = radio.musicMuted ? "Unmute radio" : "Mute radio";
    el.musicMute.setAttribute("aria-label", label);
    el.musicMute.title = label;
  }

  function updatePlayPauseUi() {
    const playing = !radio.engaged || !radio.paused;
    el.musicPlayPause.innerHTML = playing ? "&#9208;" : "&#9654;";
    const label = playing ? "Pause" : "Play";
    el.musicPlayPause.setAttribute("aria-label", label);
    el.musicPlayPause.title = label;
  }

  // Is playback currently locked to the live station? The silent preview tracks
  // the clock by construction, so it is always live; once engaged, playback is
  // live only while playing on the live track within tolerance. `lastTime` (the
  // engine's tracked position, kept current by onRadioTime) is used instead of
  // raw audio.currentTime so an in-flight track load doesn't read as a drift.
  function isLive() {
    if (!radio.engaged) return true;
    if (radio.paused) return false;
    return RADIO.isLivePosition(Date.now(), radio.durations, RADIO_ANCHOR_MS, radio.pos, radio.lastTime, LIVE_DRIFT_TOLERANCE);
  }

  // Snap back to the live broadcast -- like tuning a radio back to the station.
  // No-op when already on air (engaged + in sync); from the silent preview it
  // also engages and unmutes so the click is audible.
  function onMusicLive() {
    if (radio.engaged && isLive()) { updateLiveUi(); return; }
    const wasEngaged = radio.engaged;
    engage();
    radio.paused = false;
    if (!wasEngaged) radio.musicMuted = false;
    const live = RADIO.livePosition(Date.now(), radio.durations, RADIO_ANCHOR_MS);
    startTrack(live.index, live.offset, { play: true, muted: radio.musicMuted });
    updateMuteUi();
    updatePlayPauseUi();
    updateLiveUi();
  }

  function updateLiveUi() {
    const liveNow = isLive();
    const flag = liveNow ? 1 : 0;
    if (flag === radio.liveShown) return;   // unchanged -- skip per-frame DOM churn
    radio.liveShown = flag;
    el.musicLive.classList.toggle("on-air", liveNow);
    el.musicLive.classList.toggle("off-air", !liveNow);
    el.musicLive.innerHTML = '<span class="live-dot" aria-hidden="true"></span>' + (liveNow ? "LIVE" : "GO LIVE");
    el.musicLive.setAttribute("aria-pressed", liveNow ? "true" : "false");
    const label = liveNow
      ? "On air — listening live with everyone"
      : "Off air — click to jump to the live broadcast";
    el.musicLive.setAttribute("aria-label", label);
    el.musicLive.title = label;
  }

  function tickMusicUi() {
    if (!radio.ready) return;
    let offset, dur;
    if (!radio.engaged) {
      const live = RADIO.livePosition(Date.now(), radio.durations, RADIO_ANCHOR_MS);
      if (live.index !== radio.pos) { radio.pos = live.index; updateMusicMeta(); }
      offset = live.offset;
      dur = radio.durations[radio.pos] || 0;
    } else {
      const a = radio.audio;
      offset = a && isFinite(a.currentTime) ? a.currentTime : 0;
      dur = a && isFinite(a.duration) && a.duration > 0 ? a.duration : (radio.durations[radio.pos] || 0);
    }
    const frac = dur > 0 ? Math.min(1, offset / dur) : 0;
    el.musicProgress.style.transform = "scaleX(" + frac + ")";
    el.musicCur.textContent = RADIO.formatTime(offset);
    el.musicDur.textContent = RADIO.formatTime(dur);
    const pct = Math.round(frac * 100);
    if (pct !== radio.lastPct) {
      radio.lastPct = pct;
      el.musicSeek.setAttribute("aria-valuenow", String(pct));
      el.musicSeek.setAttribute("aria-valuetext", RADIO.formatTime(offset) + " of " + RADIO.formatTime(dur));
    }
    updateLiveUi();   // reflect pause / skip / seek / drift back to the on-air light
  }

  // ---------- Album download (zip) ----------
  function compressionFor(file) {
    const ext = (file.split(".").pop() || "").toLowerCase();
    // Already-compressed formats: store as-is. Uncompressed (wav/aiff): deflate.
    return (ext === "wav" || ext === "aif" || ext === "aiff") ? "DEFLATE" : "STORE";
  }

  function slug(name) {
    return String(name || "").replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "album";
  }

  function setMusicStatus(msg, isError) {
    el.musicStatus.textContent = msg || "";
    el.musicStatus.classList.toggle("error", !!isError);
    clearTimeout(radio.statusTimer);
    if (msg && !isError) {
      radio.statusTimer = setTimeout(() => { el.musicStatus.textContent = ""; }, 4000);
    }
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // Shared zip-and-download for the album and the voice-line pack. Sequential
  // fetch keeps the memory peak down; a non-200 fails loud (visible status, then
  // both buttons re-enabled for a retry). Both download buttons disable for the
  // duration of any download so the two packs can't be built concurrently.
  async function downloadZip(files, urlFor, zipName, noun) {
    if (radio.downloading) return;
    if (typeof JSZip === "undefined") {
      console.error("Download: JSZip not loaded.");
      setMusicStatus("Zip library unavailable.", true);
      return;
    }
    if (!files || files.length === 0) {
      setMusicStatus("Nothing to download yet.", true);
      return;
    }
    radio.downloading = true;
    el.musicDownload.disabled = true;
    if (el.voiceDownload) el.voiceDownload.disabled = true;
    try {
      const zip = new JSZip();
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        setMusicStatus("Adding " + (i + 1) + "/" + files.length + "...", false);
        const res = await fetch(urlFor(f.file));
        if (!res.ok) throw new Error(f.file + " (HTTP " + res.status + ")");
        const buf = await res.arrayBuffer();
        zip.file(f.file, buf, { compression: compressionFor(f.file) });
      }
      const blob = await zip.generateAsync({ type: "blob" }, (m) => {
        setMusicStatus("Zipping " + Math.round(m.percent) + "%...", false);
      });
      triggerDownload(blob, zipName);
      setMusicStatus("Saved " + files.length + " " + noun + (files.length === 1 ? "" : "s") + ".", false);
    } catch (e) {
      console.error("Download failed:", e);
      setMusicStatus("Download failed: " + e.message, true);
    } finally {
      radio.downloading = false;
      el.musicDownload.disabled = false;
      if (el.voiceDownload) el.voiceDownload.disabled = false;
    }
  }

  function downloadAlbum() {
    downloadZip(radio.tracks, trackUrl, slug(radio.album) + ".zip", "track");
  }

  function downloadVoiceLines() {
    downloadZip(voice.clips, voiceUrl, slug(radio.album) + "_Voice_Lines.zip", "voice line");
  }

  // ---------- Voice lines ----------
  // At each round's countdown a voice clip plays, picked random-without-repeat
  // from a shuffle bag. Obeys the game's sound toggle; hearing clips earns
  // achievements. Clips are SERIALIZED through a queue -- if a new one is
  // triggered while another is still talking, it waits its turn instead of
  // talking over it, so every line is heard clearly.
  const voice = { clips: [], bag: [], last: "", queue: [], current: null };

  async function bootVoice() {
    try {
      const res = await fetch("assets/voicelines/manifest.json", { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const manifest = await res.json();
      voice.clips = (manifest && Array.isArray(manifest.clips))
        ? manifest.clips.filter((c) => c && c.file) : [];
      if (voice.clips.length === 0) console.info("Voice lines: manifest empty -- none will play.");
    } catch (e) {
      console.info("Voice lines: no manifest (" + e.message + ") -- none will play.");
    }
    // The "download all voice lines" button lives under the album button; it
    // only appears once we know there are clips to pack.
    if (el.voiceDownload) {
      el.voiceDownload.addEventListener("click", downloadVoiceLines);
      show(el.voiceDownload, voice.clips.length > 0);
    }
    reconcileProgress(heardFiles, HEARD_KEY, voice.clips.map((c) => c.file));
    evalAndApply(true);   // reconcile achievement totals now clip count is known
  }

  function drawVoiceClip() {
    if (voice.bag.length === 0) {
      const pool = voice.clips.slice();
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
      }
      // Avoid an immediate repeat across bag refills.
      if (pool.length > 1 && pool[pool.length - 1].file === voice.last) {
        const tmp = pool[0]; pool[0] = pool[pool.length - 1]; pool[pool.length - 1] = tmp;
      }
      voice.bag = pool;
    }
    return voice.bag.pop();
  }

  function playVoiceLine() {
    if (!voice.clips.length || muted) return;   // obeys the game's sound toggle
    const clip = drawVoiceClip();
    if (!clip) return;
    voice.last = clip.file;
    voice.queue.push(clip);
    playNextVoice();
  }

  // Pull the next queued clip only when nothing is currently playing, so lines
  // never overlap. On end/error we advance the queue; an "ended" also credits
  // the achievement. The `voice.current !== a` guard makes advancing idempotent
  // if both an error and the play() rejection fire for the same clip.
  function playNextVoice() {
    if (voice.current || !voice.queue.length) return;
    const clip = voice.queue.shift();
    const a = new Audio(voiceUrl(clip.file));
    voice.current = a;
    // Route this clip through the shared compressor so its trail-offs stay
    // audible. If Web Audio is unavailable or the element can't be tapped, the
    // clip still plays on its own (uncompressed but never silent).
    let src = null;
    const input = voiceInputNode();
    if (input) {
      try {
        src = audioCtx.createMediaElementSource(a);
        src.connect(input);
      } catch (_) { src = null; }
    }
    const advance = () => {
      if (voice.current !== a) return;
      if (src) { try { src.disconnect(); } catch (_) {} }
      voice.current = null;
      playNextVoice();
    };
    a.addEventListener("ended", () => { markVoiceHeard(clip.file); advance(); });
    a.addEventListener("error", advance);
    a.play().catch(advance);
  }

  // ---------- Achievements ----------
  let listenedFiles = new Set();
  let heardFiles = new Set();
  let unlockedIds = [];

  function loadSet(key) {
    try {
      const v = JSON.parse(localStorage.getItem(key) || "[]");
      return new Set(Array.isArray(v) ? v : []);
    } catch (_) { return new Set(); }
  }
  function saveSet(key, set) {
    try { localStorage.setItem(key, JSON.stringify([...set])); } catch (_) {}
  }
  function loadArray(key) {
    try {
      const v = JSON.parse(localStorage.getItem(key) || "[]");
      return Array.isArray(v) ? v : [];
    } catch (_) { return []; }
  }
  function saveArray(key, arr) {
    try { localStorage.setItem(key, JSON.stringify(arr)); } catch (_) {}
  }

  // Drop saved progress for files no longer in the manifest, so a changed album
  // or voice-line set can't leave the count stuck above the current total (the
  // sets are keyed by file name, so a removed/renamed file simply stops
  // counting). An EMPTY list means the manifest didn't load -- treat that as
  // "unknown", not "everything removed", and prune nothing so a transient fetch
  // failure never wipes real progress.
  function reconcileProgress(set, key, validFiles) {
    if (!validFiles || validFiles.length === 0) return;
    const valid = new Set(validFiles);
    let changed = false;
    [...set].forEach((file) => {
      if (!valid.has(file)) { set.delete(file); changed = true; }
    });
    if (changed) saveSet(key, set);
  }

  function bootAchievements() {
    if (!ACH) { console.error("Achievements: src/js/achievements.js failed to load."); return; }
    listenedFiles = loadSet(LISTENED_KEY);
    heardFiles = loadSet(HEARD_KEY);
    unlockedIds = loadArray(ACH_KEY);
    el.btnAch.addEventListener("click", () => { sfxClick(); openAch(); });
    el.btnAchClose.addEventListener("click", () => { sfxClick(); closeAch(); });
    renderAchList();
    updateTrophyBadge();
  }

  function markSongListened(file) {
    if (!file || listenedFiles.has(file)) return;
    listenedFiles.add(file);
    saveSet(LISTENED_KEY, listenedFiles);
    evalAndApply(false);
  }

  function markVoiceHeard(file) {
    if (!file || heardFiles.has(file)) return;
    heardFiles.add(file);
    saveSet(HEARD_KEY, heardFiles);
    evalAndApply(false);
  }

  // Recompute unlocks; add any new ones. Fresh unlocks toast unless `silent`
  // (used on load to reconcile prior progress without replaying old toasts).
  function evalAndApply(silent) {
    if (!ACH) return;
    const current = ACH.evaluateUnlocks(
      listenedFiles.size, radio.tracks.length,
      heardFiles.size, voice.clips.length
    );
    const fresh = ACH.newlyUnlocked(unlockedIds, current);
    // Reconcile against current reality: this ADDS new unlocks AND REVOKES a
    // completion badge that no longer holds (e.g. new voice lines pushed the
    // library past what the player has heard). Milestones stay earned; ids with
    // no current definition are dropped.
    const reconciled = ACH.reconcileEarned(unlockedIds, current);
    const changed = reconciled.length !== unlockedIds.length ||
      reconciled.some((id, i) => unlockedIds[i] !== id);
    if (changed) {
      unlockedIds = reconciled;
      saveArray(ACH_KEY, unlockedIds);
    }
    if (!silent) fresh.forEach(showToast);
    renderAchList();
    updateTrophyBadge();
  }

  function showToast(id) {
    const def = ACH.get(id);
    if (!def) return;
    const div = document.createElement("div");
    div.className = "toast";
    const badge = document.createElement("span");
    badge.className = "toast-badge";
    badge.textContent = "🏆"; // trophy
    const text = document.createElement("span");
    text.className = "toast-text";
    const eye = document.createElement("span");
    eye.className = "toast-eyebrow";
    eye.textContent = "Achievement unlocked";
    const name = document.createElement("span");
    name.className = "toast-name";
    name.textContent = def.title;
    text.append(eye, name);
    div.append(badge, text);
    el.toastWrap.appendChild(div);
    sfxUnlock();
    setTimeout(() => {
      div.classList.add("out");
      setTimeout(() => div.remove(), 420);
    }, 3200);
  }

  function renderAchList() {
    if (!ACH || !el.achList) return;
    el.achList.textContent = "";
    ACH.ACHIEVEMENTS.forEach((def) => {
      const unlocked = unlockedIds.indexOf(def.id) >= 0;
      const li = document.createElement("li");
      li.className = "ach-item" + (unlocked ? " unlocked" : "");
      const badge = document.createElement("span");
      badge.className = "ach-badge";
      badge.textContent = unlocked ? "🏆" : "🔒"; // trophy / lock
      const text = document.createElement("span");
      text.className = "ach-text";
      const name = document.createElement("span");
      name.className = "ach-name";
      name.textContent = def.title;
      const desc = document.createElement("span");
      desc.className = "ach-desc";
      desc.textContent = def.desc;
      text.append(name, desc);
      li.append(badge, text);
      el.achList.appendChild(li);
    });
    el.achProgress.textContent =
      listenedFiles.size + "/" + radio.tracks.length + " songs · " +
      heardFiles.size + "/" + voice.clips.length + " voice lines";
  }

  function updateTrophyBadge() {
    if (!el.btnAch) return;
    const total = ACH ? ACH.ACHIEVEMENTS.length : 0;
    el.btnAch.title = "Achievements (" + unlockedIds.length + "/" + total + ")";
    el.btnAch.classList.toggle("has-unlocks", unlockedIds.length > 0);
  }

  function openAch() { renderAchList(); show(el.screenAch, true); }
  function closeAch() { show(el.screenAch, false); }

  // ---------- Online leaderboard ----------
  // A persistent top-100 board served by scripts/dev_server.py (data/leaderboard.json).
  // Ranking math is pure in src/js/leaderboard.js (LBOARD), mirrored authoritatively
  // by the Python store. Each browser carries an anonymous id so it holds ONE row at
  // its best score -- a lightweight identity (per browser profile, not per person; no
  // accounts), enough to stop one player flooding the board. The score is what
  // competes, so a GOD GAMER still ranks by their number. Soft-guarded like the radio:
  // a missing module or an unreachable server hides the feature, never breaks the game.
  let lbEntries = [];        // last-known board (newest fetch or POST response)
  let lbOwnerToken = null;   // this browser's secret -> proves ownership of its initials
  let lbMyInitials = "";     // initials this browser owns (highlighted on the board)
  let lbPendingScore = 0;    // score awaiting submission on the game-over screen
  let lbPendingGod = false;
  let lbSubmitting = false;  // guard against double-submit

  // The secret that proves this browser owns whatever initials it claims. Kept
  // local and only ever sent in a POST body (never returned by the API), so no
  // other player can discover it and hijack the name.
  function getOwnerToken() {
    let id = null;
    try { id = localStorage.getItem(OWNER_KEY); } catch (_) {}
    if (!id) {
      id = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : "o-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
      try { localStorage.setItem(OWNER_KEY, id); } catch (_) {}
    }
    return id;
  }

  function bootLeaderboard() {
    if (!LBOARD) {
      console.error("Leaderboard: src/js/leaderboard.js failed to load.");
      if (el.btnLeaderboard) show(el.btnLeaderboard, false);
      if (el.btnOverLeaderboard) show(el.btnOverLeaderboard, false);
      return;
    }
    lbOwnerToken = getOwnerToken();
    if (el.btnLeaderboard) el.btnLeaderboard.addEventListener("click", () => { sfxClick(); openLeaderboard(); });
    if (el.btnOverLeaderboard) el.btnOverLeaderboard.addEventListener("click", () => { sfxClick(); openLeaderboard(); });
    el.btnLbClose.addEventListener("click", () => { sfxClick(); closeLeaderboard(); });
    el.btnLbSubmit.addEventListener("click", () => { sfxClick(); submitInitials(); });
    el.lbInitials.addEventListener("input", () => {
      const cleaned = LBOARD.sanitizeInitials(el.lbInitials.value);
      if (el.lbInitials.value !== cleaned) el.lbInitials.value = cleaned;
    });
    el.lbInitials.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); sfxClick(); submitInitials(); }
    });
    try {
      const saved = localStorage.getItem(INITIALS_KEY);
      if (saved) {
        lbMyInitials = LBOARD.sanitizeInitials(saved);
        el.lbInitials.value = lbMyInitials;
      }
    } catch (_) {}
    // Warm the cache so the panel and the game-over gate respond instantly.
    fetchLeaderboard();
  }

  async function fetchLeaderboard() {
    if (!LBOARD) return null;
    try {
      const res = await fetch(LB_API, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      lbEntries = Array.isArray(data.entries) ? data.entries : [];
      return lbEntries;
    } catch (err) {
      console.error("Leaderboard: could not load the board.", err);
      return null;
    }
  }

  function fmtScoreLB(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  // entries: array of rows, [] for an empty board, or null for "offline/error".
  function renderLeaderboard(entries, highlightTs) {
    if (!el.lbList) return;
    el.lbList.textContent = "";
    if (entries == null) {
      const li = document.createElement("li");
      li.className = "lb-msg lb-error";
      li.textContent = "Leaderboard offline -- start the server to compete.";
      el.lbList.appendChild(li);
      return;
    }
    if (entries.length === 0) {
      const li = document.createElement("li");
      li.className = "lb-msg";
      li.textContent = "No scores yet -- be the first farty gang legend.";
      el.lbList.appendChild(li);
      return;
    }
    entries.forEach((e, i) => {
      const li = document.createElement("li");
      li.className = "lb-row";
      const mine = (highlightTs != null && e.ts === highlightTs) ||
                   (lbMyInitials && e.initials === lbMyInitials);
      if (mine) li.classList.add("is-me");
      const rank = document.createElement("span");
      rank.className = "lb-rank";
      rank.textContent = "#" + (i + 1);
      const ini = document.createElement("span");
      ini.className = "lb-initials-cell";
      ini.textContent = e.initials;
      const badge = document.createElement("span");
      badge.className = "lb-badge" + (e.god ? " is-god" : "");
      if (e.god) { badge.textContent = "GOD"; badge.title = "GOD GAMER"; }
      const score = document.createElement("span");
      score.className = "lb-score";
      score.textContent = fmtScoreLB(e.score);
      li.append(rank, ini, badge, score);
      el.lbList.appendChild(li);
    });
  }

  function openLeaderboard(highlightTs) {
    show(el.screenLeaderboard, true);
    if (lbEntries.length) {
      renderLeaderboard(lbEntries, highlightTs);   // instant from cache
    } else {
      el.lbList.textContent = "";
      const li = document.createElement("li");
      li.className = "lb-msg";
      li.textContent = "Loading...";
      el.lbList.appendChild(li);
    }
    fetchLeaderboard().then((entries) => {
      if (el.screenLeaderboard.classList.contains("hidden")) return;  // closed meanwhile
      if (entries != null) renderLeaderboard(entries, highlightTs);
      else if (!lbEntries.length) renderLeaderboard(null, highlightTs);
    });
  }

  function closeLeaderboard() { show(el.screenLeaderboard, false); }

  function setLbStatus(msg, isError) {
    if (!el.lbStatus) return;
    el.lbStatus.textContent = msg || "";
    el.lbStatus.classList.toggle("error", !!isError);
  }

  function resetLbEntry() {
    if (el.lbEntry) show(el.lbEntry, false);
    if (el.lbEntryForm) show(el.lbEntryForm, true);
    lbSubmitting = false;
    if (el.btnLbSubmit) el.btnLbSubmit.disabled = false;
    setLbStatus("", false);
  }

  // 1-based position this run would take, with the player's own stale row set aside.
  function lbRankForDisplay(entries, score) {
    const others = (entries || []).filter((e) => !(lbMyInitials && e.initials === lbMyInitials));
    return LBOARD.rankOf(others, score);
  }

  function maybePromptLeaderboard(score, isGod) {
    resetLbEntry();
    if (!LBOARD) return;
    lbPendingScore = score;
    lbPendingGod = isGod;
    show(el.lbEntry, true);
    show(el.lbEntryForm, false);
    setLbStatus("Checking the leaderboard...", false);
    fetchLeaderboard().then((entries) => {
      if (game.state !== "gameOver") return;   // player already moved on
      if (entries == null) {
        el.lbEntryPrompt.textContent = "Leaderboard offline -- couldn't reach the server.";
        setLbStatus("", false);
        return;
      }
      if (LBOARD.qualifiesForInitials(entries, score, lbMyInitials, LBOARD.MAX_ENTRIES)) {
        const rank = lbRankForDisplay(entries, score);
        el.lbEntryPrompt.textContent = "You cracked the Top 100 -- projected #" + rank + "! Enter your initials:";
        show(el.lbEntryForm, true);
        setLbStatus("", false);
        try { el.lbInitials.focus(); el.lbInitials.select(); } catch (_) {}
      } else {
        const existing = LBOARD.findByInitials(entries, lbMyInitials);
        el.lbEntryPrompt.textContent = existing
          ? "That run didn't beat your best (" + fmtScoreLB(existing.score) + "). Your spot stands."
          : "So close -- that score didn't crack the Top 100.";
        setLbStatus("", false);
      }
    });
  }

  async function submitInitials() {
    if (!LBOARD || lbSubmitting) return;
    if (!SUBMIT) {
      setLbStatus("Can't submit on this browser (signing unavailable).", true);
      return;
    }
    const initials = LBOARD.sanitizeInitials(el.lbInitials.value);
    if (!LBOARD.validInitials(initials)) {
      setLbStatus("Enter three letters (A-Z).", true);
      try { el.lbInitials.focus(); } catch (_) {}
      return;
    }
    lbSubmitting = true;
    el.btnLbSubmit.disabled = true;
    setLbStatus("Saving...", false);
    const prevMyInitials = lbMyInitials;
    lbMyInitials = initials;   // highlight this name once it lands
    try { localStorage.setItem(INITIALS_KEY, initials); } catch (_) {}
    try {
      // Sign the run so the server can reject unsigned/forged/replayed POSTs.
      const fields = {
        initials, score: lbPendingScore, god: lbPendingGod,
        nonce: SUBMIT.newNonce(), ts: Date.now(), owner: lbOwnerToken,
      };
      const sig = await SUBMIT.sign(fields);
      const res = await fetch(LB_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.assign({}, fields, { sig })),
      });
      let data = {};
      try { data = await res.json(); } catch (_) {}
      if (res.status === 403 && data && /taken/i.test(data.error || "")) {
        // Those initials belong to another player's owner token; undo the
        // optimistic local claim so the board never highlights a stranger's row.
        lbMyInitials = prevMyInitials;
        try {
          if (prevMyInitials) localStorage.setItem(INITIALS_KEY, prevMyInitials);
          else localStorage.removeItem(INITIALS_KEY);
        } catch (_) {}
        setLbStatus("Those initials are taken -- pick another.", true);
        try { el.lbInitials.focus(); el.lbInitials.select(); } catch (_) {}
        el.btnLbSubmit.disabled = false;
        return;
      }
      if (!res.ok || !data.ok) throw new Error(data.error || ("HTTP " + res.status));
      lbEntries = Array.isArray(data.entries) ? data.entries : lbEntries;
      show(el.lbEntryForm, false);
      setLbStatus(
        data.improved === false
          ? "Your best still stands -- #" + data.rank + "."
          : "You're on the board at #" + data.rank + "!",
        false
      );
      sfxUnlock();
      openLeaderboard(data.entry && data.entry.ts);
    } catch (err) {
      console.error("Leaderboard: submit failed.", err);
      setLbStatus("Couldn't save -- check the connection and try again.", true);
      el.btnLbSubmit.disabled = false;   // fail loud, allow retry
    } finally {
      lbSubmitting = false;
    }
  }

  // ---------- Boot ----------
  function boot() {
    resize();
    try { game.best = parseInt(localStorage.getItem(BEST_KEY), 10) || 0; } catch (_) {}
    refreshMuteUI();
    updateHud();
    bootAchievements();
    bootLeaderboard();
    bootVoice();
    bootMusic();
    loadAssets().then(() => {
      game.state = "start";
      parkWig();
      if (DEV_PINBALL || DEV_BLACKJACK || DEV_SLOTS || DEV_FEEDMOLLY) startGame();   // TEMP: auto-enter a phase for tuning
    });
    requestAnimationFrame(frame);
  }

  boot();
})();
