/* Resume Tailor - profile access guard
 *
 * Loaded before the app bundle, alongside webhook.js. Reads the rules in
 * access.config.js and answers one question: given the name currently typed
 * into the profile, which tabs should be hidden?
 *
 * Exposes:
 *
 *   window.RTAccess.setProfile(profile)  - called by the bundle whenever the
 *                                          profile is saved (every autosave)
 *   window.RTAccess.blockedTabs()        - ['preview'] etc, or [] when allowed
 *   window.RTAccess.isBlockedTab(id)     - convenience for one tab id
 *   window.RTAccess.isBlocked(name)      - the raw name test, for any caller
 *   window.RTAccess.fallbackTab()        - tab to fall back to when kicked out
 *   window.RTAccess.message()            - text to show in a blocked tab
 *
 * When the answer changes it also bubbles a DOM event from <html>, so the app
 * (or anything else on the page) can react without polling:
 *
 *   document.addEventListener('resume-tailor:access-changed', e => {
 *     e.detail.blockedTabs  // string[]
 *     e.detail.name         // the profile name that was evaluated
 *   });
 *
 * The profile name never leaves the page - this file makes no requests.
 *
 * NOTE: a browser-side guard. It keeps a tab out of the UI; it does not and
 * cannot stop someone determined to reach the code behind it.
 */
(function () {
  'use strict';

  var EVENT = 'resume-tailor:access-changed';
  var PROFILE_KEY = 'resume-tailor:profile';
  var LOG_PREFIX = '[resume-tailor]';
  var TABS = { home: 1, profile: 1, preview: 1, about: 1, contact: 1 };
  var MATCHERS = { startsWith: 1, exact: 1, contains: 1 };

  var currentName = '';
  var currentTabs = [];
  var warned = {};

  function warnOnce(key, msg, extra) {
    if (warned[key]) return;
    warned[key] = true;
    try { console.warn(LOG_PREFIX, msg, extra === undefined ? '' : extra); } catch (e) { /* ignore */ }
  }

  function cfg() {
    var c = window.RT_ACCESS_CONFIG;
    if (!c || typeof c !== 'object' || c.enabled === false) return null;
    return c;
  }

  function log() {
    var c = cfg();
    if (c && c.log === false) return;
    try { console.log.apply(console, arguments); } catch (e) { /* no console */ }
  }

  function str(v) { return typeof v === 'string' ? v.trim() : ''; }

  function fold(s, caseSensitive) {
    s = str(s);
    return caseSensitive ? s : s.toLowerCase();
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

  function hit(name, needle, mode) {
    if (mode === 'exact') return name === needle;
    if (mode === 'contains') return name.indexOf(needle) !== -1;
    return name.indexOf(needle) === 0;
  }

  /* True when `name` is on the blacklist. Safe to call with anything. */
  function isBlocked(name) {
    var c = cfg();
    if (!c) return false;

    var caseSensitive = c.caseSensitive === true;
    var subject = fold(name, caseSensitive);
    if (!subject) return false;

    var list = Array.isArray(c.blocklist) ? c.blocklist : [];
    var fallback = defaultMatch();

    for (var i = 0; i < list.length; i++) {
      var entry = list[i], value, mode = fallback;

      if (entry && typeof entry === 'object') {
        value = fold(entry.value, caseSensitive);
        if (entry.match !== undefined) {
          var m = str(entry.match);
          if (MATCHERS[m]) mode = m;
          else warnOnce('emm-' + i, 'access.config.js blocklist entry "' + (str(entry.value) || '#' + (i + 1)) + '" has unknown match "' + m + '"; using ' + fallback);
        }
      } else {
        value = fold(entry, caseSensitive);
      }

      if (!value) { warnOnce('empty-' + i, 'access.config.js blocklist entry #' + (i + 1) + ' is empty; skipped'); continue; }
      if (hit(subject, value, mode)) return true;
    }
    return false;
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

  function message() {
    var c = cfg();
    return str(c && c.message) || 'This profile does not have access to this tab.';
  }

  function tabsFor(name) {
    return isBlocked(name) ? configuredTabs() : [];
  }

  function same(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /* Recompute from `currentName`; announce only when the answer moved. */
  function refresh() {
    var next = tabsFor(currentName);
    if (same(next, currentTabs)) return currentTabs;

    var was = currentTabs;
    currentTabs = next;

    if (next.length) log(LOG_PREFIX, 'profile "' + currentName + '" is blocked from: ' + next.join(', '));
    else if (was.length) log(LOG_PREFIX, 'profile "' + currentName + '" is no longer blocked');

    try {
      document.documentElement.dispatchEvent(new CustomEvent(EVENT, {
        bubbles: true,
        detail: { name: currentName, blockedTabs: next.slice() }
      }));
    } catch (e) { /* very old browser - the poll in the app still catches up */ }

    return currentTabs;
  }

  function setProfile(profile) {
    currentName = profile && typeof profile === 'object' ? str(profile.fullName) : str(profile);
    return refresh();
  }

  /* Seed from whatever was saved last session, so a blocked profile is blocked
     on the very first render rather than after the first keystroke. */
  function boot() {
    try {
      var raw = localStorage.getItem(PROFILE_KEY);
      if (raw) currentName = str(JSON.parse(raw).fullName);
    } catch (e) { /* no storage, or not JSON - treat as no profile */ }
    currentTabs = tabsFor(currentName);
    if (currentTabs.length) log(LOG_PREFIX, 'profile "' + currentName + '" is blocked from: ' + currentTabs.join(', '));
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
    event: EVENT
  };
})();
