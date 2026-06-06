/*
 * Pin the Wig on Hexy -- live broadcast overlay logic.
 *
 * Pure, DOM-free helpers for the operator broadcast feature: an operator flashes
 * a short line that appears in large letters over every player's game in near
 * real time. Clients poll GET /api/broadcast a few times a minute; this module
 * shapes the message (mirroring the server's scripts/broadcast_store.py so both
 * sides agree on what a line becomes) and decides what the overlay should do for
 * each polled payload. The DOM wiring (polling loop, fade timers, the admin send
 * panel) lives in src/js/game.js -- this stays testable in isolation.
 *
 * Loaded as a plain script in the browser (sets window.PTWOHBroadcast) and as a
 * CommonJS module in Node tests -- no build step.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.PTWOHBroadcast = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Mirror scripts/broadcast_store.py: a flashed line is short by design.
  var MAX_LEN = 200;
  // How often a client polls for the active broadcast (milliseconds). A couple
  // of seconds reads as real-time for "mess with the stream" without holding a
  // connection open per player (the server is a plain thread-per-request host).
  var POLL_MS = 2000;
  // Never show a message for less than this even if it is already near expiry
  // when first polled, so a late poller still gets a readable flash.
  var MIN_DISPLAY_MS = 2000;
  // Ceiling for the poll interval while the endpoint is failing (milliseconds).
  var BACKOFF_MAX_MS = 30000;

  // Collapse a raw message to a single trimmed line, capped at MAX_LEN. Mirrors
  // sanitize_text in scripts/broadcast_store.py: control characters (newlines,
  // tabs, escapes) become spaces, whitespace runs collapse to one, ends trim.
  // Returns "" when nothing usable remains.
  function sanitizeMessage(raw) {
    if (raw == null) return "";
    var s = String(raw);
    var out = "";
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      out += (c < 0x20 || c === 0x7f) ? " " : s.charAt(i);
    }
    return out.replace(/\s+/g, " ").trim().slice(0, MAX_LEN);
  }

  // Decide what the overlay should do for a freshly polled payload, given the
  // sequence the client last acted on. Pure: no timers, no DOM.
  //
  //   payload: { seq, text, remaining_ms } from GET /api/broadcast
  //   returns: { visible, isNew, seq, text, displayMs }
  //     visible   - is a message active right now?
  //     isNew     - is this a different broadcast than the one last acted on?
  //                 (a (re)send to show; a clear/expiry to hide)
  //     displayMs - how long to keep it up before auto-hiding, clamped so a
  //                 late poller still reads it; 0 when nothing is active.
  function decide(shownSeq, payload) {
    var p = payload || {};
    var seq = typeof p.seq === "number" ? p.seq : 0;
    var text = typeof p.text === "string" ? sanitizeMessage(p.text) : "";
    var isNew = seq !== shownSeq;
    if (text) {
      var remaining = typeof p.remaining_ms === "number" ? p.remaining_ms : 0;
      return {
        visible: true, isNew: isNew, seq: seq, text: text,
        displayMs: Math.max(MIN_DISPLAY_MS, remaining),
      };
    }
    return { visible: false, isNew: isNew, seq: seq, text: "", displayMs: 0 };
  }

  // Delay before the next poll, given the count of consecutive failures. A
  // healthy poll (0 failures) runs at POLL_MS; a failing endpoint (server down,
  // missing route, network blip) backs off exponentially up to BACKOFF_MAX_MS,
  // so a persistent outage neither floods the console nor hammers the server.
  // The caller resets the streak to 0 on the first success, returning to POLL_MS.
  function pollDelay(failStreak) {
    if (!failStreak || failStreak < 1) return POLL_MS;
    var mult = Math.pow(2, Math.min(failStreak, 4));   // 4x, 8x, 16x, then 16x
    return Math.min(POLL_MS * mult, BACKOFF_MAX_MS);
  }

  return {
    MAX_LEN: MAX_LEN,
    POLL_MS: POLL_MS,
    MIN_DISPLAY_MS: MIN_DISPLAY_MS,
    BACKOFF_MAX_MS: BACKOFF_MAX_MS,
    sanitizeMessage: sanitizeMessage,
    decide: decide,
    pollDelay: pollDelay,
  };
});
