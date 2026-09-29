/* Resume Tailor - profile access guard
 *
 * Loaded before the app bundle, alongside webhook.js. Reads the rules in
 * access.config.js and answers one question: given the profile as it stands,
 * which tabs should be hidden?
 *
 * Two things can hide a tab:
 *   blocklist - the name matches an entry in access.config.js
 *   webhook   - `requireWebhook` is on and Profile > Integrations > Webhook is
 *               unset, or points at an id webhook.config.js no longer lists
 *
 * Exposes:
 *
 *   window.RTAccess.setProfile(profile)  - called by the bundle whenever the
 *                                          profile is saved (every autosave)
 *   window.RTAccess.blockedTabs()        - ['preview'] etc, or [] when allowed
 *   window.RTAccess.isBlockedTab(id)     - convenience for one tab id
 *   window.RTAccess.reason()             - 'blocklist' | 'webhook' | null
 *   window.RTAccess.requiresWebhook()    - is a webhook a precondition here?
 *   window.RTAccess.hasWebhook()         - does the profile satisfy it?
 *   window.RTAccess.isBlocked(name)      - the raw name test, for any caller
 *   window.RTAccess.fallbackTab()        - tab to fall back to when kicked out
 *   window.RTAccess.message(reason)      - text to show in a blocked tab
 *   window.RTAccess.hash(name)           - { hash, len } to paste into the
 *                                          config; see hash-name.mjs
 *
 * When the answer changes it also bubbles a DOM event from <html>, so the app
 * (or anything else on the page) can react without polling:
 *
 *   document.addEventListener('resume-tailor:access-changed', e => {
 *     e.detail.blockedTabs  // string[]
 *     e.detail.reason       // 'blocklist' | 'webhook' | null
 *   });
 *
 * The profile name never leaves the page - this file makes no requests.
 *
 * ON THE HASHES: blocklist entries are stored as salted SHA-256 digests so the
 * names are not readable in this repo or in devtools. That is obfuscation, not
 * secrecy - the salt and the algorithm ship with the page, so anyone willing to
 * run a list of common names through them can recover a match. It stops casual
 * reading. It does not keep a secret, and, like any browser-side guard, it does
 * not stop someone determined to reach the code behind the tab.
 */
(function () {
  'use strict';

  var EVENT = 'resume-tailor:access-changed';
  var PROFILE_KEY = 'resume-tailor:profile';
  var LOG_PREFIX = '[resume-tailor]';
  var TABS = { home: 1, profile: 1, preview: 1, about: 1, contact: 1 };
  var MATCHERS = { startsWith: 1, exact: 1, contains: 1 };
  var MAX_NAME = 120;     // longer input is truncated before hashing
  var MAX_CACHE = 512;

  var currentProfile = { name: '', webhookId: '' };
  var currentTabs = [];
  var currentReason = null;
  var warned = {};

  function warnOnce(key, msg, extra) {
    if (warned[key]) return;
    warned[key] = true;
    try { console.warn(LOG_PREFIX, msg, extra === undefined ? '' : extra); } catch (e) { /* ignore */ }
  }

  /* The config as written, even when disabled - hash() must keep working so a
     new entry can be generated with blocking switched off. */
  function rawCfg() {
    var c = window.RT_ACCESS_CONFIG;
    return c && typeof c === 'object' ? c : {};
  }

  function cfg() {
    var c = rawCfg();
    return c.enabled === false ? null : c;
  }

  function log() {
    if (rawCfg().log === false) return;
    try { console.log.apply(console, arguments); } catch (e) { /* no console */ }
  }

  function str(v) { return typeof v === 'string' ? v.trim() : ''; }

  function fold(s, caseSensitive) {
    s = str(s);
    return caseSensitive ? s : s.toLowerCase();
  }

  /* ---------------------------------------------------------- sha-256 --- */
  /* Plain synchronous SHA-256. WebCrypto is async, and the name check runs
     inside a React render, which cannot wait for a promise. */

  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

  function utf8(s) {
    var out = [], i, c, c2, cp;
    for (i = 0; i < s.length; i++) {
      c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
        c2 = s.charCodeAt(i + 1);
        cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        i++;
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  function sha256(bytes) {
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var bits = bytes.length * 8;
    var m = bytes.slice();
    m.push(0x80);
    while (m.length % 64 !== 56) m.push(0);
    m.push(0, 0, 0, 0, (bits >>> 24) & 255, (bits >>> 16) & 255, (bits >>> 8) & 255, bits & 255);

    var w = new Array(64), i, t, a, b, c, d, e, f, g, h, s0, s1, S0, S1, ch, maj, t1, t2;
    for (i = 0; i < m.length; i += 64) {
      for (t = 0; t < 16; t++) {
        w[t] = (m[i + 4 * t] << 24) | (m[i + 4 * t + 1] << 16) | (m[i + 4 * t + 2] << 8) | m[i + 4 * t + 3];
      }
      for (t = 16; t < 64; t++) {
        s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
        s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
      }
      a = H[0]; b = H[1]; c = H[2]; d = H[3]; e = H[4]; f = H[5]; g = H[6]; h = H[7];
      for (t = 0; t < 64; t++) {
        S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        ch = (e & f) ^ (~e & g);
        t1 = (h + S1 + ch + K[t] + w[t]) | 0;
        S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        maj = (a & b) ^ (a & c) ^ (b & c);
        t2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    var out = [];
    for (i = 0; i < 8; i++) out.push((H[i] >>> 24) & 255, (H[i] >>> 16) & 255, (H[i] >>> 8) & 255, H[i] & 255);
    return out;
  }

  function hex(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return s;
  }

  /* Typing re-hashes the same prefixes over and over, so memoise. Keyed by the
     settings too, so editing the config from a console still behaves. */
  var cache = Object.create(null);
  var cacheN = 0;

  function digest(value) {
    var c = rawCfg();
    var salt = str(c.salt);
    var iter = typeof c.hashIterations === 'number' && c.hashIterations > 0 ? (c.hashIterations | 0) : 1;
    var key = iter + '\u001f' + salt + '\u001f' + value;

    if (cache[key] !== undefined) return cache[key];
    var b = sha256(utf8(salt + '\u001f' + value));
    for (var i = 1; i < iter; i++) b = sha256(b);
    var out = hex(b);

    if (cacheN >= MAX_CACHE) { cache = Object.create(null); cacheN = 0; }
    cache[key] = out;
    cacheN++;
    return out;
  }

  /* --------------------------------------------------------- matching --- */

  function defaultMatch() {
    var c = cfg();
    var m = str(c && c.match) || 'startsWith';
    if (!MATCHERS[m]) {
      warnOnce('match-' + m, 'access.config.js has unknown match "' + m + '" (expected startsWith, exact or contains); using startsWith');
      return 'startsWith';
    }
    return m;
  }

  function hitPlain(subject, needle, mode) {
    if (mode === 'exact') return subject === needle;
    if (mode === 'contains') return subject.indexOf(needle) !== -1;
    return subject.indexOf(needle) === 0;
  }

  /* `len` is the length of the hashed name. Recording it keeps this to one hash
     per entry instead of one per prefix; without it we have to scan. */
  function hitHash(subject, hash, len, mode, i) {
    var s;
    if (len > 0) {
      if (len > subject.length) return false;
      if (mode === 'exact') return len === subject.length && digest(subject) === hash;
      if (mode === 'startsWith') return digest(subject.slice(0, len)) === hash;
      for (s = 0; s + len <= subject.length; s++) if (digest(subject.substr(s, len)) === hash) return true;
      return false;
    }
    if (mode === 'exact') return digest(subject) === hash;
    if (mode === 'startsWith') {
      for (s = 1; s <= subject.length; s++) if (digest(subject.slice(0, s)) === hash) return true;
      return false;
    }
    warnOnce('hash-contains-' + i, 'access.config.js blocklist entry #' + (i + 1) + ' uses match "contains" with a hash but no len, so it cannot be checked; add len (hash-name.mjs prints it) or use startsWith. Entry skipped');
    return false;
  }

  /* True when `name` is on the blacklist. Safe to call with anything. */
  function isBlocked(name) {
    var c = cfg();
    if (!c) return false;

    var caseSensitive = c.caseSensitive === true;
    var subject = fold(name, caseSensitive);
    if (!subject) return false;
    if (subject.length > MAX_NAME) subject = subject.slice(0, MAX_NAME);

    var list = Array.isArray(c.blocklist) ? c.blocklist : [];
    var fallback = defaultMatch();

    for (var i = 0; i < list.length; i++) {
      var entry = list[i], mode = fallback, plain = '', hash = '', len = -1, m;

      if (entry && typeof entry === 'object') {
        if (entry.match !== undefined) {
          m = str(entry.match);
          if (MATCHERS[m]) mode = m;
          else warnOnce('emm-' + i, 'access.config.js blocklist entry #' + (i + 1) + ' has unknown match "' + m + '"; using ' + fallback);
        }
        if (str(entry.hash)) {
          hash = str(entry.hash).toLowerCase();
          if (typeof entry.len === 'number' && entry.len > 0) len = entry.len | 0;
        } else {
          plain = fold(entry.value, caseSensitive);
        }
      } else {
        plain = fold(entry, caseSensitive);
      }

      if (hash) { if (hitHash(subject, hash, len, mode, i)) return true; }
      else if (plain) { if (hitPlain(subject, plain, mode)) return true; }
      else warnOnce('empty-' + i, 'access.config.js blocklist entry #' + (i + 1) + ' has neither value nor hash; skipped');
    }
    return false;
  }

  /* --------------------------------------------------- webhook rule --- */
  /* `requireWebhook` makes the Profile > Integrations > Webhook dropdown a
     precondition: until it points at an endpoint that webhook.config.js still
     lists, the profile is treated exactly like a blocked one. */

  function webhookOptions() {
    try {
      var o = window.RTWebhookOptions && window.RTWebhookOptions();
      return Array.isArray(o) ? o : [];
    } catch (e) { return []; }
  }

  function requiresWebhook() {
    var c = cfg();
    if (!c || c.requireWebhook !== true) return false;
    /* No endpoints to pick from means no profile could ever satisfy the rule,
       which would lock everyone out of the app. Refuse to enforce it. */
    if (webhookOptions().length === 0) {
      warnOnce('rw-empty', 'access.config.js sets requireWebhook: true, but webhook.config.js offers no usable endpoint, so no profile could ever satisfy it. The requirement is ignored until at least one endpoint exists.');
      return false;
    }
    return true;
  }

  function hasWebhook(id) {
    id = str(id);
    if (!id) return false;
    var o = webhookOptions();
    for (var i = 0; i < o.length; i++) if (o[i] && o[i].id === id) return true;
    return false;   // selected, but no longer listed in webhook.config.js
  }

  /* 'blocklist', 'webhook', or null when the profile is fine. */
  function reasonFor(p) {
    if (!cfg()) return null;
    if (isBlocked(p.name)) return 'blocklist';
    if (requiresWebhook() && !hasWebhook(p.webhookId)) return 'webhook';
    return null;
  }

  /* --------------------------------------------------------- the tabs --- */

  function configuredTabs() {
    var c = cfg();
    var list = c && Array.isArray(c.blockedTabs) ? c.blockedTabs : ['preview'];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var id = str(list[i]);
      if (!id) continue;
      if (!TABS[id]) { warnOnce('tab-' + id, 'access.config.js blockedTabs has unknown tab "' + id + '" (expected ' + Object.keys(TABS).join(', ') + '); ignored'); continue; }
      if (out.indexOf(id) === -1) out.push(id);
    }
    return out;
  }

  function fallbackTab() {
    var c = cfg();
    var id = str(c && c.fallbackTab) || 'home';
    return TABS[id] ? id : 'home';
  }

  /* `reason` defaults to why the current profile is blocked. */
  function message(reason) {
    var c = cfg() || {};
    var m = c.messages && typeof c.messages === 'object' ? c.messages : {};
    var why = reason === undefined ? currentReason : reason;
    return str(m[why]) || str(c.message) || 'This profile does not have access to this tab.';
  }

  function tabsFor(p) {
    return reasonFor(p) ? configuredTabs() : [];
  }

  function same(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /* Recompute from `currentName`; announce only when the answer moved. The name
     is deliberately kept out of the log line and the event detail. */
  function refresh() {
    var why = reasonFor(currentProfile);
    var next = why ? configuredTabs() : [];
    if (same(next, currentTabs) && why === currentReason) return currentTabs;

    var was = currentTabs;
    currentTabs = next;
    currentReason = why;

    if (next.length) log(LOG_PREFIX, 'this profile is blocked from: ' + next.join(', ') + ' (' + why + ')');
    else if (was.length) log(LOG_PREFIX, 'this profile is no longer blocked');

    try {
      document.documentElement.dispatchEvent(new CustomEvent(EVENT, {
        bubbles: true,
        detail: { blockedTabs: next.slice(), reason: why }
      }));
    } catch (e) { /* very old browser - the app still reads blockedTabs() on mount */ }

    return currentTabs;
  }

  function setProfile(profile) {
    currentProfile = profile && typeof profile === 'object'
      ? { name: str(profile.fullName), webhookId: str(profile.webhookId) }
      : { name: str(profile), webhookId: '' };
    return refresh();
  }

  /* Seed from whatever was saved last session, so a blocked profile is blocked
     on the very first render rather than after the first keystroke. */
  function boot() {
    try {
      var raw = localStorage.getItem(PROFILE_KEY);
      if (raw) {
        var saved = JSON.parse(raw);
        currentProfile = { name: str(saved.fullName), webhookId: str(saved.webhookId) };
      }
    } catch (e) { /* no storage, or not JSON - treat as no profile */ }
    currentReason = reasonFor(currentProfile);
    currentTabs = currentReason ? configuredTabs() : [];
    if (currentTabs.length) log(LOG_PREFIX, 'this profile is blocked from: ' + currentTabs.join(', ') + ' (' + currentReason + ')');
  }

  boot();

  window.RTAccess = {
    setProfile: setProfile,
    blockedTabs: function () { return currentTabs.slice(); },
    isBlockedTab: function (id) { return currentTabs.indexOf(str(id)) !== -1; },
    isBlocked: isBlocked,
    fallbackTab: fallbackTab,
    message: message,
    refresh: refresh,
    event: EVENT,
    /* Why the current profile is blocked: 'blocklist', 'webhook' or null. */
    reason: function () { return currentReason; },
    /* Is a webhook currently a precondition for generating? False when the rule
       is off, or when webhook.config.js lists nothing to pick. */
    requiresWebhook: requiresWebhook,
    /* Does the current profile point at an endpoint that still exists? */
    hasWebhook: function () { return hasWebhook(currentProfile.webhookId); },
    /* Turn a name into the { hash, len } pair that goes in the config. Uses the
       salt / hashIterations / caseSensitive currently loaded, so every entry has
       to be regenerated if you change any of those. */
    hash: function (name) {
      var v = fold(name, rawCfg().caseSensitive === true);
      return { hash: digest(v), len: v.length };
    }
  };
})();
