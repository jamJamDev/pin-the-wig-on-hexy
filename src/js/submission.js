/*
 * Pin the Wig on Hexy -- leaderboard submission signing.
 *
 * Builds the canonical payload string and its HMAC-SHA256 signature for a
 * leaderboard POST. The server (scripts/submission_token.py) recomputes the
 * same signature and rejects a mismatch, a stale timestamp, or a replayed
 * nonce -- so a naive scripted submission that does not sign is turned away.
 *
 * The shared key below ships in client JS, so it raises the bar against casual
 * forgery and replay but is NOT a true secret: a determined reader can extract
 * it. The real ownership guarantee rests on the per-player owner token, which
 * is never returned by the API (see scripts/leaderboard_store.py).
 *
 * Loaded as a plain script in the browser (sets window.PTWOHSubmission) and as
 * a CommonJS module in Node tests -- no build step. Uses Web Crypto (present in
 * modern browsers and Node >= 16 via globalThis.crypto.subtle).
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.PTWOHSubmission = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Mirrored byte-for-byte in scripts/submission_token.py SIGNING_SECRET. A
  // low-entropy phrase on purpose -- it is shared friction, not a credential.
  var SIGNING_SECRET = "ptwoh.leaderboard.v1.shared-submission-key.not-a-real-secret"; // gitleaks:allow
  var SCHEME = "ptwoh-sub-v1";
  var SEP = "\u001f"; // ASCII unit separator -- cannot occur in any signed field

  // The exact string both sides HMAC. Field order and separators are part of
  // the contract: change one and every signature stops verifying.
  function canonical(f) {
    return [
      SCHEME,
      f.initials,
      String(Math.trunc(f.score)),  // match the server's int() truncation exactly
      f.god ? "1" : "0",
      f.nonce,
      String(Math.trunc(f.ts)),
      f.owner,
    ].join(SEP);
  }

  function toBytes(s) {
    return new TextEncoder().encode(s);
  }

  function toHex(buf) {
    var b = new Uint8Array(buf);
    var out = "";
    for (var i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, "0");
    return out;
  }

  function subtle() {
    var c = (typeof globalThis !== "undefined" && globalThis.crypto) || null;
    return c && c.subtle ? c.subtle : null;
  }

  // HMAC-SHA256 hex of the canonical payload. Throws if Web Crypto is missing
  // so an unsigned submission fails loudly instead of slipping through.
  async function sign(fields) {
    var s = subtle();
    if (!s) throw new Error("Web Crypto unavailable: cannot sign submission");
    var key = await s.importKey(
      "raw", toBytes(SIGNING_SECRET),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    var sig = await s.sign("HMAC", key, toBytes(canonical(fields)));
    return toHex(sig);
  }

  // A fresh, single-use nonce so the server can reject replays.
  function newNonce() {
    var c = (typeof globalThis !== "undefined" && globalThis.crypto) || null;
    if (c && c.randomUUID) return c.randomUUID().replace(/-/g, "");
    if (c && c.getRandomValues) {
      var a = new Uint8Array(16);
      c.getRandomValues(a);
      return toHex(a.buffer);
    }
    throw new Error("Web Crypto unavailable: cannot mint nonce");
  }

  return {
    SCHEME: SCHEME,
    SEP: SEP,
    canonical: canonical,
    sign: sign,
    newNonce: newNonce,
  };
});
