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
 * Endpoint types decide the wire format:
 *   generic - the JSON envelope below, as-is
 *   discord - a Discord "Execute Webhook" message: one embed per event,
 *             mentions disabled, sized to Discord's embed limits, sent with
 *             ?wait=true so failures are reported instead of silently dropped
 *
 * The endpoint is chosen in Profile > Integrations > Webhook and stored in the
 * profile as `webhookId`. Selection is entirely OPTIONAL: with "None" chosen,
 * an id that no longer exists in the config, or a malformed URL, nothing is
 * sent and nothing throws - events still log and bubble as normal.
 *
 * DATA SENT: the caller hands us raw app state, but only redact() output ever
 * leaves the page. Each event carries:
 *   - the profile name and (for resume.generated) the target company
 *   - the user's public IP address and country, looked up from an external
 *     service (see clientInfo in webhook.config.js)
 *   - counts and booleans describing the profile / resume
 * It never includes email, phone, location, links, summary prose, bullet text,
 * skill names, or endpoint URLs. The Discord formatter only re-presents that
 * same data.
 */
(function () {
  'use strict';

  var SCHEMA_VERSION = 1;
  var PROFILE_KEY = 'resume-tailor:profile';
  var STATE_KEY = 'resume-tailor:webhook-state';
  var QUEUE_KEY = 'resume-tailor:webhook-queue';
  var MAX_QUEUE = 50;
  var LOG_PREFIX = '[resume-tailor]';
  var TYPES = { generic: true, discord: true };

  /* https://discord.com/api/webhooks/{webhook.id}/{webhook.token}
     (also discordapp.com, canary./ptb. hosts, and an optional /v{n} API version) */
  var DISCORD_URL = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w-]+\/?(?:\?.*)?$/i;

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

  function str(v) { return typeof v === 'string' ? v.trim() : ''; }

  /* Sanitised endpoint list. Bad entries are skipped with a one-time warning
     rather than breaking the dropdown. */
  function endpoints() {
    var c = cfg();
    var list = c && Array.isArray(c.endpoints) ? c.endpoints : [];
    var out = [], seen = {};
    for (var i = 0; i < list.length; i++) {
      var ep = list[i];
      if (!ep || typeof ep !== 'object') continue;
      var id = str(ep.id), url = str(ep.url), where = 'webhook.config.js endpoint "' + (id || '#' + (i + 1)) + '"';
      if (!id) { warnOnce('ep-noid-' + i, where + ' has no id; skipped'); continue; }
      if (seen[id]) { warnOnce('ep-dup-' + id, where + ' duplicates an earlier id; skipped'); continue; }
      if (!isValidUrl(url)) { warnOnce('ep-url-' + id, where + ' has an invalid url; skipped'); continue; }

      var type = str(ep.type).toLowerCase();
      if (!type) {
        // generic JSON would always be rejected by Discord, so infer it
        type = DISCORD_URL.test(url) ? 'discord' : 'generic';
        if (type === 'discord') warnOnce('ep-infer-' + id, where + ' has no type but is a Discord webhook url; treating it as type "discord"');
      }
      if (!TYPES[type]) { warnOnce('ep-type-' + id, where + ' has unknown type "' + type + '" (expected generic or discord); skipped'); continue; }

      var norm = {
        id: id,
        label: str(ep.label) || id,
        type: type,
        url: url,
        mode: ep.mode === 'no-cors' || ep.mode === 'cors' ? ep.mode : null,
        headers: ep.headers && typeof ep.headers === 'object' ? ep.headers : null
      };

      if (type === 'discord') {
        if (!DISCORD_URL.test(url)) {
          warnOnce('ep-dcurl-' + id, where + ' is type "discord" but the url is not https://discord.com/api/webhooks/{id}/{token}; skipped');
          continue;
        }
        if (norm.mode === 'no-cors') {
          // no-cors cannot send application/json, which Discord requires
          warnOnce('ep-dcmode-' + id, where + ': mode "no-cors" is not usable with Discord; using "cors"');
        }
        norm.mode = 'cors';
        norm.discord = discordOptions(ep, where, id);
      }

      seen[id] = true;
      out.push(norm);
    }
    return out;
  }

  /* Optional Discord message overrides, validated against Discord's rules so a
     bad value is dropped with a warning instead of making every send fail. */
  function discordOptions(ep, where, id) {
    var o = {};
    var username = str(ep.username);
    if (username) {
      // webhook names are 1-80 chars and may not contain "clyde" or "discord"
      if (username.length > 80 || /clyde|discord/i.test(username)) {
        warnOnce('dc-user-' + id, where + ': username must be 1-80 chars and not contain "clyde" or "discord"; ignored');
      } else { o.username = username; }
    }
    var avatar = str(ep.avatarUrl);
    if (avatar) {
      if (/^https?:\/\//i.test(avatar)) o.avatar_url = avatar;
      else warnOnce('dc-avatar-' + id, where + ': avatarUrl must be an http(s) url; ignored');
    }
    var threadId = str(ep.threadId);
    if (threadId) {
      if (/^\d+$/.test(threadId)) o.threadId = threadId;
      else warnOnce('dc-thread-' + id, where + ': threadId must be a numeric snowflake; ignored');
    }
    var threadName = str(ep.threadName);
    if (threadName) o.thread_name = threadName.slice(0, 100);
    return o;
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

  /* The selected endpoint with effective mode/headers, or null when none is
     selected (the normal case) or the selection cannot be used. */
  function resolve() {
    var c = cfg();
    if (!c) return null;
    var id = selectedId();
    if (!id) return null;                               // "None" - optional
    var list = endpoints();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id !== id) continue;
      var ep = list[i], headers = {};
      [c.headers, ep.headers].forEach(function (h) {
        if (h && typeof h === 'object') Object.keys(h).forEach(function (k) { headers[k] = h[k]; });
      });
      return {
        id: ep.id, type: ep.type, url: ep.url, discord: ep.discord || null,
        mode: ep.mode || (c.mode === 'no-cors' ? 'no-cors' : 'cors'),
        headers: headers
      };
    }
    warnOnce('missing-' + id, 'selected webhook is not in webhook.config.js (or was skipped as invalid), so no events are being sent:', id);
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

  /* ------------------------------------------------------ client info --- */
  /* A page cannot see its own public IP, so it is fetched from the providers in
     config.clientInfo, tried in order. Each response shape is normalised and
     the result cached for the session. The lookup never throws and waits at
     most timeoutMs per provider; if every provider fails the fields are null
     and the event is still sent. */

  var CLIENT_KEY = 'resume-tailor:client';
  var CLIENT_RETRY_MS = 60000;
  var clientPromise = null;
  var clientFailedAt = 0;

  function emptyClient() { return { ip: null, country: null, countryCode: null }; }

  function clientCfg() {
    var c = cfg();
    var ci = c && c.clientInfo;
    if (!ci || typeof ci !== 'object' || ci.enabled === false) return null;
    var providers = arr(ci.providers).map(str).filter(function (u) { return /^https:\/\//i.test(u) && isValidUrl(u); });
    if (!providers.length) return null;
    var minutes = ci.cacheMinutes == null ? 30 : Number(ci.cacheMinutes);
    return {
      providers: providers,
      timeoutMs: Math.max(200, num(ci.timeoutMs) || 3000),
      cacheMs: Math.max(0, isNaN(minutes) ? 30 : minutes) * 60000
    };
  }

  var IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
  function isIp(v) {
    if (typeof v !== 'string') return false;
    v = v.trim();
    return IPV4.test(v) || (v.indexOf(':') !== -1 && /^[0-9a-f:.]{2,45}$/i.test(v));
  }

  function countryName(code) {
    try {
      if (typeof Intl !== 'undefined' && Intl.DisplayNames) {
        var n = new Intl.DisplayNames(['en'], { type: 'region' }).of(code);
        if (n && n !== code) return n;
      }
    } catch (e) { /* unknown code or no Intl support */ }
    return null;
  }

  /* Understands geojs / ipwho.is ({ ip, country, country_code }),
     ipapi.co ({ ip, country_name, country_code }) and ipinfo.io ({ ip, country: "DE" }). */
  function normaliseClient(j) {
    if (!j || typeof j !== 'object' || j.success === false || j.error === true) return null;
    var ip = [j.ip, j.ipAddress, j.query].filter(isIp)[0];
    if (!ip) return null;
    var code = [j.country_code, j.countryCode, j.country].map(str)
      .filter(function (c) { return /^[A-Za-z]{2}$/.test(c); })[0] || null;
    if (code) code = code.toUpperCase();
    var name = [j.country_name, j.countryName, j.country].map(str)
      .filter(function (c) { return c.length > 2; })[0] || null;
    if (!name && code) name = countryName(code);
    return { ip: ip.trim(), country: name ? name.slice(0, 100) : null, countryCode: code };
  }

  function withTimeout(promise, ms, onTimeout) {
    return new Promise(function (done) {
      var settled = false;
      var t = setTimeout(function () {
        if (settled) return;
        settled = true;
        try { if (onTimeout) onTimeout(); } catch (e) { /* ignore */ }
        done(null);
      }, ms);
      promise.then(
        function (v) { if (!settled) { settled = true; clearTimeout(t); done(v); } },
        function () { if (!settled) { settled = true; clearTimeout(t); done(null); } }
      );
    });
  }

  function lookupClient() {
    var cc = clientCfg();
    if (!cc) return Promise.resolve(emptyClient());
    if (clientPromise) return clientPromise;
    if (clientFailedAt && Date.now() - clientFailedAt < CLIENT_RETRY_MS) return Promise.resolve(emptyClient());

    try {
      var cached = JSON.parse(sessionStorage.getItem(CLIENT_KEY) || 'null');
      if (cached && isIp(cached.ip) && Date.now() - cached.at < cc.cacheMs) {
        clientPromise = Promise.resolve({ ip: cached.ip, country: cached.country || null, countryCode: cached.countryCode || null });
        return clientPromise;
      }
    } catch (e) { /* no usable cache */ }

    function tryProvider(i) {
      if (i >= cc.providers.length) return Promise.resolve(null);
      var ctrl = null;
      try { ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null; } catch (e) { ctrl = null; }
      var req;
      try {
        var opts = { method: 'GET', credentials: 'omit' };
        if (ctrl) opts.signal = ctrl.signal;
        req = Promise.resolve(fetch(cc.providers[i], opts))
          .then(function (r) { return r && r.ok ? r.json() : null; })
          .then(normaliseClient);
      } catch (e) { req = Promise.resolve(null); }
      return withTimeout(req, cc.timeoutMs, function () { if (ctrl) ctrl.abort(); })
        .then(function (info) { return info || tryProvider(i + 1); });
    }

    var pending = tryProvider(0).then(function (info) {
      if (!info) {
        warnOnce('client-lookup', 'could not look up IP address / country; events are sent without them');
        clientFailedAt = Date.now();
        clientPromise = null;                         // let a later event try again
        return emptyClient();
      }
      clientFailedAt = 0;
      try {
        sessionStorage.setItem(CLIENT_KEY, JSON.stringify({ at: Date.now(), ip: info.ip, country: info.country, countryCode: info.countryCode }));
      } catch (e) { /* storage unavailable */ }
      return info;
    }).catch(function () { clientPromise = null; return emptyClient(); });
    clientPromise = pending;
    return pending;
  }

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

  /* The profile name for any event. Profile events carry the profile; the two
     resume.generated calls carry the rendered resume (whose `name` is the
     profile's full name). We try, in order: the event's own profile, the
     event's resume, then ALWAYS the saved profile - so no event can omit the
     name while one is saved. Returns null only when no name exists anywhere. */
  function profileName(ctx) {
    ctx = ctx || {};
    var candidates = [
      ctx.profile && typeof ctx.profile === 'object' ? ctx.profile.fullName : null,
      ctx.resume && typeof ctx.resume === 'object' ? ctx.resume.name : null
    ];
    var n = candidates.filter(has)[0];
    if (!has(n)) {
      var p = readJSON(PROFILE_KEY, null);
      if (p && has(p.fullName)) n = p.fullName;
    }
    return has(n) ? n.trim().replace(/\s+/g, ' ').slice(0, 100) : null;
  }

  function redact(type, ctx) {
    ctx = ctx || {};
    var data = { profileName: profileName(ctx) };
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

  /* --------------------------------------------------- discord format --- */
  /* Discord embed limits: title 256, description 4096, 25 fields, field name
     256, field value 1024, footer 2048, 6000 characters across the embed.     */

  var DC = {
    'resume.generated': { title: 'Resume generated', color: 0x57F287 },
    'profile.updated': { title: 'Profile updated', color: 0x5865F2 },
    'profile.exported': { title: 'Profile exported', color: 0xFEE75C },
    'profile.imported': { title: 'Profile imported', color: 0xEB459E }
  };
  var SOURCES = { 'preview-download': 'Preview download', 'auto-paste': 'Auto-download on paste' };
  var METHODS = { 'file-picker': 'Save dialog', download: 'Browser download' };

  function clip(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n - 1) + '\u2026' : s;
  }

  /* The company name comes from LLM output, so it is untrusted text: strip
     control characters, escape markdown, and break @mentions (allowed_mentions
     below also stops them pinging). */
  function safeText(s, n) {
    var t = String(s == null ? '' : s)
      .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, ' ')
      .replace(/\s+/g, ' ').trim();
    t = clip(t, n)
      .replace(/([\\*_~`|>#\[\]()])/g, '\\$1')
      .replace(/@/g, '@\u200b');
    return t;
  }

  function yesNo(b) { return b ? 'Yes' : 'No'; }
  function field(name, value, inline) {
    var v = String(value == null || value === '' ? 'n/a' : value);
    return { name: clip(name, 256), value: clip(v, 1024), inline: inline !== false };
  }

  function profileFields(p) {
    if (!p) return [field('Profile', 'unavailable', false)];
    var c = p.counts || {};
    return [
      field('Completeness', p.completeness + '% (' + p.fieldsFilled + '/' + p.fieldsTotal + ' fields)'),
      field('Work experience', c.workExperiencesFilled + ' of ' + c.workExperiences + ' filled'),
      field('Requested bullets', c.requestedBulletPoints),
      field('Education', c.educationsFilled + ' of ' + c.educations + ' filled'),
      field('Certifications', c.certificationsFilled + ' of ' + c.certifications + ' filled'),
      field('Role-based title', yesNo(p.roleBasedJobTitle))
    ];
  }

  function discordBody(env, ep) {
    var d = env.data || {};
    var meta = DC[env.type] || { title: clip(String(env.type), 200), color: 0x99AAB5 };
    var embed = { title: meta.title, color: meta.color, fields: [] };
    var lines = ['Profile: ' + (has(d.profileName) ? '**' + safeText(d.profileName, 100) + '**' : '_not set_')];

    switch (env.type) {
      case 'resume.generated': {
        lines.push('Target company: ' + (has(d.company) ? '**' + safeText(d.company, 200) + '**' : '_not specified_'));
        var r = d.resume || {}, s = d.settings || {};
        embed.fields.push(
          field('Source', SOURCES[d.source] || d.source),
          field('Experience entries', r.experienceCount),
          field('Bullet points', r.bulletCount),
          field('Skills', r.skillCount != null ? r.skillCount + ' in ' + r.skillCategoryCount + ' categories' : null),
          field('Bold keywords', r.boldSpans),
          field('Summary', r.hasSummary ? 'Yes (' + r.summaryLength + ' chars)' : 'No'),
          field('Education', r.educationCount),
          field('Certifications', r.certificationCount),
          field('Layout', s.fontFamily ? s.fontFamily + ' ' + (s.fontSize || '?') + 'pt, ' + (s.experienceLayout || 'default') : null)
        );
        break;
      }
      case 'profile.updated':
        embed.fields = profileFields(d.profile);
        break;
      case 'profile.exported':
      case 'profile.imported':
        embed.fields = [field('Method', METHODS[d.method] || d.method || 'File upload')]
          .concat(profileFields(d.profile))
          .concat([field('Includes JSON response', yesNo(d.hasJsonResponse))]);
        break;
      default:
        lines.push('Unrecognised event.');
    }

    // IP / country come from a third-party lookup, so they are escaped as untrusted text.
    // Shown in the description (not a field) so they are clearly visible up top.
    var cl = d.client || {};
    var country = has(cl.country)
      ? safeText(cl.country, 100) + (has(cl.countryCode) ? ' (' + safeText(cl.countryCode, 2) + ')' : '')
      : (has(cl.countryCode) ? safeText(cl.countryCode, 2) : 'unknown');
    lines.push('IP address: ' + (has(cl.ip) ? '**' + safeText(cl.ip, 45) + '**' : '_unknown_') + ' - ' + country);

    embed.description = clip(lines.join(String.fromCharCode(10)), 4096);
    embed.fields = embed.fields.slice(0, 25);
    embed.footer = { text: clip(env.source + ' \u2022 session ' + String(env.sessionId).slice(0, 8), 2048) };
    if (env.occurredAt) embed.timestamp = env.occurredAt;

    // stay inside the 6000-character total by shedding fields from the end
    function size(e) {
      return (e.title || '').length + (e.description || '').length + e.footer.text.length +
        e.fields.reduce(function (n, f) { return n + f.name.length + f.value.length; }, 0);
    }
    while (size(embed) > 6000 && embed.fields.length) embed.fields.pop();

    var body = {
      embeds: [embed],
      allowed_mentions: { parse: [] }              // never ping anyone
    };
    var o = ep.discord || {};
    if (o.username) body.username = o.username;
    if (o.avatar_url) body.avatar_url = o.avatar_url;
    if (o.thread_name) body.thread_name = o.thread_name;
    return body;
  }

  function discordUrl(ep) {
    try {
      var u = new URL(ep.url);
      u.searchParams.set('wait', 'true');          // report failures instead of silently dropping
      if (ep.discord && ep.discord.threadId) u.searchParams.set('thread_id', ep.discord.threadId);
      return u.toString();
    } catch (e) { return ep.url; }
  }

  /* -------------------------------------------------------- transport --- */

  function request(env, ep) {
    if (ep.type === 'discord') {
      return { url: discordUrl(ep), body: JSON.stringify(discordBody(env, ep)), mode: 'cors' };
    }
    return { url: ep.url, body: JSON.stringify(env), mode: ep.mode };
  }

  /* Resolves to { result: 'ok'|'retry'|'drop'|'skip', wait?: ms } */
  function post(env, ep) {
    if (!ep || !ep.url) return Promise.resolve({ result: 'skip' });

    var req;
    try { req = request(env, ep); } catch (e) {
      warnOnce('fmt-' + ep.id, 'could not build the request for ' + ep.id + '; event dropped', e);
      return Promise.resolve({ result: 'drop' });
    }

    var opts = { method: 'POST', body: req.body, keepalive: true };
    if (req.mode === 'no-cors') {
      opts.mode = 'no-cors';
      // no-cors permits only simple headers; application/json would be blocked
      opts.headers = { 'Content-Type': 'text/plain;charset=UTF-8' };
    } else {
      opts.headers = { 'Content-Type': 'application/json' };
      Object.keys(ep.headers || {}).forEach(function (k) { opts.headers[k] = ep.headers[k]; });
    }

    try {
      return fetch(req.url, opts).then(function (res) {
        if (opts.mode === 'no-cors') return { result: 'ok' };   // opaque response, assume sent
        if (res.ok) return { result: 'ok' };
        if (res.status === 429) return retryAfter(res).then(function (ms) { return { result: 'retry', wait: ms }; });
        // other client errors (bad token, deleted webhook, malformed body) will not fix themselves
        if (res.status >= 400 && res.status < 500 && res.status !== 408) {
          return describe(res).then(function (why) {
            warnOnce('drop-' + ep.id + '-' + res.status, 'webhook ' + ep.id + ' rejected the event (HTTP ' + res.status + '); not retrying', why);
            return { result: 'drop' };
          });
        }
        return { result: 'retry' };
      }).catch(function () { return { result: 'retry' }; });
    } catch (e) {
      return Promise.resolve({ result: 'retry' });              // fetch missing/blocked
    }
  }

  /* Rate limits: Discord sends retry_after (seconds) in the body and a
     Retry-After header. Capped so a bad value cannot stall the queue. */
  function retryAfter(res) {
    var header = 0;
    try { header = parseFloat(res.headers && res.headers.get && res.headers.get('Retry-After')) || 0; } catch (e) { /* ignore */ }
    var body = res.json ? res.json().catch(function () { return null; }) : Promise.resolve(null);
    return body.then(function (j) {
      var secs = j && typeof j.retry_after === 'number' ? j.retry_after : header;
      return Math.min(Math.max(0, secs * 1000), 60000);
    }).catch(function () { return 0; });
  }

  function describe(res) {
    try {
      if (!res.json) return Promise.resolve('');
      return res.json().then(function (j) {
        return j && (j.message || j.code) ? (j.code ? j.code + ' ' : '') + (j.message || '') : '';
      }).catch(function () { return ''; });
    } catch (e) { return Promise.resolve(''); }
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
      return post(env, ep).then(function (out) {
        if (out.result === 'ok') { log(LOG_PREFIX, 'delivered', env.type, '->', ep.id + ' (' + ep.type + ')'); return true; }
        if (out.result === 'skip' || out.result === 'drop') return true;   // permanent; do not queue
        if (i + 1 >= attempts) return false;
        var wait = out.wait != null ? out.wait : backoff * Math.pow(2, i);
        if (out.wait != null) log(LOG_PREFIX, 'rate limited by', ep.id + ', retrying in', Math.round(wait) + 'ms');
        return sleep(wait).then(function () { return attempt(i + 1); });
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

  /* Idempotency guard. The same logical action can reach RTEmit twice - most
     often the paste flow, where a `paste` event and the following `change`
     event both trigger the same download. We fingerprint each event by its
     (type + redacted data) and drop an identical one seen within a short
     window. Recorded synchronously below, before the async IP lookup, so a
     same-tick double-fire is caught. Window is configurable (dedupeMs). */
  var DEFAULT_DEDUPE_MS = 4000;
  var recentSends = {};
  function dedupeWindow() {
    var c = cfg();
    var n = c && c.dedupeMs != null ? Number(c.dedupeMs) : DEFAULT_DEDUPE_MS;
    return isNaN(n) || n < 0 ? DEFAULT_DEDUPE_MS : n;
  }
  function isDuplicate(type, data) {
    var win = dedupeWindow();
    if (!win) return false;
    var now = Date.now();
    for (var k in recentSends) {
      if (recentSends.hasOwnProperty(k) && now - recentSends[k] > win) delete recentSends[k];
    }
    var fp;
    try { fp = type + '|' + JSON.stringify(data); } catch (e) { return false; }
    if (recentSends[fp] && now - recentSends[fp] < win) return true;
    recentSends[fp] = now;
    return false;
  }

  function dispatch(type, ctx) {
    // snapshot app state and time now; the IP lookup below is asynchronous
    var data = redact(type, ctx);
    if (isDuplicate(type, data)) {
      log(LOG_PREFIX, 'duplicate', type, 'suppressed (within ' + dedupeWindow() + 'ms)');
      return Promise.resolve();
    }
    var at = new Date().toISOString();

    return lookupClient().then(function (client) {
      data.client = client;
      var env = envelope(type, data);
      env.occurredAt = at;
      var ep = resolve();

      log(LOG_PREFIX, type, env.data, ep ? '(sending to ' + ep.id + ' as ' + ep.type + ')' : '(no webhook selected - log only)');
      bubble(env);                                 // always fires, webhook or not

      if (!ep || !wants(type)) return;
      flush();
      deliver(env).then(function (ok) { if (!ok) enqueue(env); }).catch(function () { /* ignore */ });
    }).catch(function (e) {
      try { console.warn(LOG_PREFIX, 'event failed', type, e); } catch (e2) { /* ignore */ }
    });
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
        // the name is sent too, so renaming the profile counts as a change
        var sig = JSON.stringify({ meta: meta, name: profileName(ctx) });
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
