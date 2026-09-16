/* Resume Tailor - event bus + webhook dispatcher
 *
 * Loaded before the app bundle. Exposes:
 *
 *   window.RTEmit(type, context)   - called by the bundle at four points:
 *       profile.updated   - profile autosaved (debounced + deduped)
 *       resume.generated  - a tailored PDF was produced
 *       profile.exported  - details written to a JSON file
 *       profile.imported  - details loaded back from a JSON file
 *
 *   window.RTWebhookOptions()      - [{ id, label }] for the Profile tab
 *                                    dropdown, built from webhook.config.js
 *
 * Every event does three things:
 *   1. logs to the console
 *   2. bubbles as a DOM CustomEvent from <html>, so anything on the page (or a
 *      browser extension) can listen without touching the bundle:
 *        document.addEventListener('resume-tailor:event', e => ...)        // all
 *        document.addEventListener('resume-tailor:resume.generated', ...)  // one
 *   3. POSTs to the selected endpoint, IF one is selected and valid
 *
 * The endpoint is chosen in Profile > Integrations > Webhook and stored in the
 * profile as `webhookId`. Selection is entirely OPTIONAL: with "None" chosen,
 * an id that no longer exists in the config, or a malformed URL, nothing is
 * sent and nothing throws - events still log and bubble as normal.
 *
 * PRIVACY: the caller hands us raw app state, but only redact() output ever
 * leaves the page. It emits counts, booleans and the target company name -
 * never contact details, summary prose, bullet text, skill names, or endpoint
 * URLs.
 */
(function () {
  'use strict';

  var SCHEMA_VERSION = 1;
  var PROFILE_KEY = 'resume-tailor:profile';
  var STATE_KEY = 'resume-tailor:webhook-state';
  var QUEUE_KEY = 'resume-tailor:webhook-queue';
  var MAX_QUEUE = 50;
  var LOG_PREFIX = '[resume-tailor]';

  /* ----------------------------------------------------------- config --- */

  function cfg() {
    var c = window.RT_WEBHOOK_CONFIG;
    if (!c || typeof c !== 'object' || c.enabled === false) return null;
    return c;
  }

  function log() {
    var c = cfg();
    if (c && c.log === false) return;
    try { console.log.apply(console, arguments); } catch (e) { /* no console */ }
  }

  var warned = {};
  function warnOnce(key, msg, extra) {
    if (warned[key]) return;
    warned[key] = true;
    try { console.warn(LOG_PREFIX, msg, extra === undefined ? '' : extra); } catch (e) { /* ignore */ }
  }

  function isValidUrl(u) {
    if (typeof u !== 'string' || !u) return false;
    if (!/^https?:\/\//i.test(u)) return false;
    try { new URL(u); return true; } catch (e) { return false; }
  }

  /* Sanitised endpoint list. Bad entries (missing id, bad URL, duplicate id)
     are skipped with a one-time warning rather than breaking the dropdown. */
  function endpoints() {
    var c = cfg();
    var list = c && Array.isArray(c.endpoints) ? c.endpoints : [];
    var out = [], seen = {};
    for (var i = 0; i < list.length; i++) {
      var ep = list[i];
      if (!ep || typeof ep !== 'object') continue;
      var id = typeof ep.id === 'string' ? ep.id.trim() : '';
      var url = typeof ep.url === 'string' ? ep.url.trim() : '';
      if (!id) { warnOnce('ep-noid-' + i, 'webhook.config.js endpoint #' + (i + 1) + ' has no id; skipped'); continue; }
      if (seen[id]) { warnOnce('ep-dup-' + id, 'webhook.config.js has a duplicate endpoint id; later entry skipped:', id); continue; }
      if (!isValidUrl(url)) { warnOnce('ep-url-' + id, 'webhook.config.js endpoint has an invalid url; skipped:', id); continue; }
      seen[id] = true;
      out.push({
        id: id,
        label: typeof ep.label === 'string' && ep.label.trim() ? ep.label.trim() : id,
        url: url,
        mode: ep.mode === 'no-cors' || ep.mode === 'cors' ? ep.mode : null,
        headers: ep.headers && typeof ep.headers === 'object' ? ep.headers : null
      });
    }
    return out;
  }

  /* The id stored in the profile, or the config default when none is chosen. */
  function selectedId() {
    try {
      var stored = localStorage.getItem(PROFILE_KEY);
      if (stored) {
        var p = JSON.parse(stored);
        if (p && typeof p.webhookId === 'string' && p.webhookId.trim()) return p.webhookId.trim();
      }
    } catch (e) { /* unreadable/corrupt profile - fall through to default */ }
    var c = cfg();
    return c && typeof c.defaultEndpointId === 'string' ? c.defaultEndpointId.trim() : '';
  }

  /* Returns { id, url, mode, headers } for the selected endpoint, or null when
     none is selected (the normal case) or the selection cannot be used. */
  function resolve() {
    var c = cfg();
    if (!c) return null;
    var id = selectedId();
    if (!id) return null;                               // "None" - optional
    var list = endpoints();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) {
        var ep = list[i];
        var headers = {};
        [c.headers, ep.headers].forEach(function (h) {
          if (h && typeof h === 'object') Object.keys(h).forEach(function (k) { headers[k] = h[k]; });
        });
        return { id: ep.id, url: ep.url, mode: ep.mode || (c.mode === 'no-cors' ? 'no-cors' : 'cors'), headers: headers };
      }
    }
    warnOnce('missing-' + id, 'selected webhook is not in webhook.config.js, so no events are being sent:', id);
    return null;
  }

  function wants(type) {
    var c = cfg();
    if (!c) return false;
    var m = c.events;
    if (!m || typeof m !== 'object') return true;
    return m[type] !== false;
  }

  /* ------------------------------------------------------------ utils --- */

  function has(v) { return typeof v === 'string' && v.trim().length > 0; }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function num(v) { var n = parseInt(v, 10); return isNaN(n) ? 0 : n; }

  function readJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }

  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* quota / private mode */ }
  }

  function uuid() {
    try {
      if (crypto && crypto.randomUUID) return crypto.randomUUID();
    } catch (e) { /* fall through */ }
    return 'e-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  var sessionId = (function () {
    try {
      var id = sessionStorage.getItem('resume-tailor:session');
      if (!id) { id = uuid(); sessionStorage.setItem('resume-tailor:session', id); }
      return id;
    } catch (e) { return uuid(); }
  })();

  /* ---------------------------------------------------------- redact --- */
  /* The only place app state is turned into an outbound payload.           */

  function profileMeta(p) {
    if (!p || typeof p !== 'object') return null;
    var work = arr(p.workExperiences), edu = arr(p.educations), cert = arr(p.certifications);

    // booleans only - which fields are filled, never their values
    var fields = {
      fullName: has(p.fullName), email: has(p.email), phone: has(p.phone),
      location: has(p.location), linkedIn: has(p.linkedIn), gitHub: has(p.gitHub),
      website: has(p.website), seniority: has(p.seniority), jobTitle: has(p.jobTitle)
    };
    var names = Object.keys(fields);
    var filled = names.filter(function (k) { return fields[k]; }).length;

    return {
      fields: fields,
      fieldsFilled: filled,
      fieldsTotal: names.length,
      completeness: names.length ? Math.round((filled / names.length) * 100) : 0,
      roleBasedJobTitle: !!p.roleBasedJobTitle,
      // whether a webhook is selected - never which one or where it points
      webhookConfigured: has(p.webhookId),
      counts: {
        workExperiences: work.length,
        workExperiencesFilled: work.filter(function (e) { return has(e && e.company); }).length,
        educations: edu.length,
        educationsFilled: edu.filter(function (e) { return has(e && e.degreeMajor); }).length,
        certifications: cert.length,
        certificationsFilled: cert.filter(function (e) { return has(e && e.certification); }).length,
        requestedBulletPoints: work.reduce(function (n, e) { return n + num(e && e.bulletPoints); }, 0)
      }
    };
  }

  function resumeMeta(r) {
    if (!r || typeof r !== 'object') return null;
    var exp = arr(r.experience), skills = arr(r.skills);
    return {
      experienceCount: exp.length,
      bulletCount: exp.reduce(function (n, e) { return n + arr(e && e.bullets).length; }, 0),
      skillCategoryCount: skills.length,
      skillCount: skills.reduce(function (n, s) { return n + arr(s && s.skills).length; }, 0),
      educationCount: arr(r.education).length,
      certificationCount: arr(r.certifications).length,
      hasSummary: has(r.summary),
      summaryLength: has(r.summary) ? r.summary.trim().length : 0,
      // how many <b> spans the LLM produced, i.e. keyword emphasis density
      boldSpans: exp.reduce(function (n, e) {
        return n + arr(e && e.bullets).reduce(function (m, b) {
          return m + (String(b).match(/<b>/gi) || []).length;
        }, 0);
      }, 0)
    };
  }

  function settingsMeta(s) {
    if (!s || typeof s !== 'object') return null;
    var p = s.primary || {}, l = s.pageLayout || {};
    return {
      fontFamily: p.fontFamily || null,
      fontSize: p.fontSize || null,
      experienceLayout: s.experienceLayout || null,
      boostEducation: !!s.boostEducation,
      pageMargin: l.pageMargin || null
    };
  }

  function redact(type, ctx) {
    ctx = ctx || {};
    var data = {};
    switch (type) {
      case 'profile.updated':
        data.profile = profileMeta(ctx.profile);
        break;
      case 'resume.generated':
        data.company = has(ctx.company) ? ctx.company.trim() : null;
        data.source = ctx.source || null;
        data.resume = resumeMeta(ctx.resume);
        data.settings = settingsMeta(ctx.settings);
        break;
      case 'profile.exported':
      case 'profile.imported':
        data.method = ctx.method || null;
        data.profile = profileMeta(ctx.profile);
        data.settings = settingsMeta(ctx.settings);
        data.hasJsonResponse = has(ctx.jsonResponse);
        break;
      default:
        break;
    }
    return data;
  }

  /* -------------------------------------------------------- transport --- */

  function post(env, ep) {
    if (!ep || !ep.url) return Promise.resolve('skip');

    var opts = { method: 'POST', body: JSON.stringify(env), keepalive: true };
    if (ep.mode === 'no-cors') {
      opts.mode = 'no-cors';
      // no-cors permits only simple headers; application/json would be blocked
      opts.headers = { 'Content-Type': 'text/plain;charset=UTF-8' };
    } else {
      opts.headers = { 'Content-Type': 'application/json' };
      Object.keys(ep.headers || {}).forEach(function (k) { opts.headers[k] = ep.headers[k]; });
    }

    try {
      return fetch(ep.url, opts).then(function (res) {
        if (opts.mode === 'no-cors') return 'ok';        // opaque response, assume sent
        if (res.ok) return 'ok';
        // client errors (bad URL, auth, malformed) will not fix themselves
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) return 'drop';
        return 'retry';
      }).catch(function () { return 'retry'; });
    } catch (e) {
      return Promise.resolve('retry');                   // fetch missing/blocked
    }
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function deliver(env) {
    var ep = resolve();
    if (!ep) return Promise.resolve(true);               // nothing to do, not a failure
    var c = cfg() || {};
    var retry = c.retry || {};
    var attempts = Math.max(1, num(retry.attempts) || 3);
    var backoff = Math.max(0, num(retry.backoffMs) || 800);

    function attempt(i) {
      return post(env, ep).then(function (result) {
        if (result === 'ok') { log(LOG_PREFIX, 'delivered', env.type, '->', ep.id); return true; }
        if (result === 'skip') return true;
        if (result === 'drop') {
          warnOnce('drop-' + ep.id + '-' + env.type, 'webhook rejected the event (client error); not retrying:', ep.id);
          return true;                                   // permanent; do not queue
        }
        if (i + 1 >= attempts) return false;
        return sleep(backoff * Math.pow(2, i)).then(function () { return attempt(i + 1); });
      }).catch(function () { return false; });
    }
    return attempt(0);
  }

  function enqueue(env) {
    var q = readJSON(QUEUE_KEY, []);
    if (!Array.isArray(q)) q = [];
    q.push(env);
    if (q.length > MAX_QUEUE) q = q.slice(q.length - MAX_QUEUE);
    writeJSON(QUEUE_KEY, q);
    log(LOG_PREFIX, 'queued for retry', env.type, '(' + q.length + ' pending)');
  }

  var flushing = false;
  function flush() {
    if (flushing || !resolve()) return Promise.resolve();
    var q = readJSON(QUEUE_KEY, []);
    if (!Array.isArray(q) || !q.length) return Promise.resolve();
    flushing = true;
    writeJSON(QUEUE_KEY, []);

    var remaining = [];
    return q.reduce(function (chain, env) {
      return chain.then(function () {
        return deliver(env).then(function (ok) { if (!ok) remaining.push(env); });
      });
    }, Promise.resolve()).then(function () {
      if (remaining.length) {
        var current = readJSON(QUEUE_KEY, []);
        writeJSON(QUEUE_KEY, remaining.concat(Array.isArray(current) ? current : []).slice(0, MAX_QUEUE));
      }
      flushing = false;
    }).catch(function () { flushing = false; });
  }

  /* ------------------------------------------------------------ emit --- */

  function bubble(env) {
    try {
      var root = document.documentElement;
      if (!root) return;
      var init = { detail: env, bubbles: true, cancelable: false };
      root.dispatchEvent(new CustomEvent('resume-tailor:' + env.type, init));
      root.dispatchEvent(new CustomEvent('resume-tailor:event', init));
    } catch (e) { /* never let instrumentation break the app */ }
  }

  function envelope(type, data) {
    var c = cfg();
    return {
      id: uuid(),
      type: type,
      schemaVersion: SCHEMA_VERSION,
      occurredAt: new Date().toISOString(),
      source: (c && c.source) || 'resume-tailor',
      sessionId: sessionId,
      page: (function () { try { return location.origin + location.pathname; } catch (e) { return null; } })(),
      data: data
    };
  }

  function dispatch(type, ctx) {
    var env = envelope(type, redact(type, ctx));
    var ep = resolve();

    log(LOG_PREFIX, type, env.data, ep ? '(sending to ' + ep.id + ')' : '(no webhook selected - log only)');
    bubble(env);                                   // always fires, webhook or not

    if (!ep || !wants(type)) return;
    flush();
    deliver(env).then(function (ok) { if (!ok) enqueue(env); }).catch(function () { /* ignore */ });
  }

  /* profile.updated fires from an autosave that runs on every keystroke, so it
     is debounced, and deduped against the last payload we actually sent (kept in
     localStorage so a reload does not re-emit an unchanged profile). */
  var timer = null;
  function dispatchProfile(ctx) {
    var c = cfg();
    var wait = c && num(c.debounceMs) ? num(c.debounceMs) : 2000;
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
      timer = null;
      try {
        var meta = profileMeta(ctx.profile);
        if (!meta) return;
        var sig = JSON.stringify(meta);
        var state = readJSON(STATE_KEY, {}) || {};
        if (state.lastProfileSig === sig) return;    // nothing materially changed
        state.lastProfileSig = sig;
        writeJSON(STATE_KEY, state);
        dispatch('profile.updated', ctx);
      } catch (e) { /* swallow */ }
    }, wait);
  }

  window.RTEmit = function (type, ctx) {
    try {
      if (type === 'profile.updated') dispatchProfile(ctx || {});
      else if (typeof type === 'string' && type) dispatch(type, ctx || {});
    } catch (e) {
      // instrumentation must never surface to the user
      try { console.warn(LOG_PREFIX, 'event failed', type, e); } catch (e2) { /* ignore */ }
    }
  };

  // Dropdown items for the Profile tab. Never throws; worst case is [].
  window.RTWebhookOptions = function () {
    try {
      return endpoints().map(function (ep) { return { id: ep.id, label: ep.label }; });
    } catch (e) { return []; }
  };

  // retry anything stranded by a previous session
  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { flush(); });
    } else { flush(); }
  } catch (e) { /* ignore */ }
})();
