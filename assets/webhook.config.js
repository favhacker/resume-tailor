/* Resume Tailor - webhook options
 *
 * The list below populates the dropdown in the app under
 * Profile > Integrations > Webhook. Whichever entry the user picks is saved
 * with their profile like any other field.
 *
 * Choosing an endpoint is OPTIONAL - the dropdown always offers "None", and
 * with nothing selected no request is made. Events are still logged to the
 * console and dispatched as DOM events either way.
 *
 * This file is plain JS (not part of the compiled bundle), so the list can be
 * edited here or through GitHub's web UI without rebuilding anything.
 *
 * Each event sends: the profile name, the target company (resume.generated),
 * the user's public IP address and country (see clientInfo below), and counts
 * and flags about the profile / resume. Email, phone, location, links,
 * summary, bullet text, skill names and endpoint URLs are never sent. See the
 * redact section of assets/webhook.js.
 *
 * Name and IP address are personal data. If other people use this page, tell
 * them it is collected and where it goes.
 */
window.RT_WEBHOOK_CONFIG = {
  // Master switch. false disables delivery, logging and DOM events entirely.
  enabled: true,

  // Console logging of every event. Set false to quieten it.
  log: true,

  /* The dropdown items. Replace these with your own.
   *
   *   id    - stable key stored in the profile. Keep it stable: changing an id
   *           orphans any profile that had it selected (the app shows a clear
   *           warning when that happens). Changing the url is always safe.
   *   label - what the user sees in the dropdown.
   *   type  - wire format:
   *             'generic' (default) - POSTs the JSON event envelope as-is.
   *             'discord'           - sends a Discord message (one embed per
   *                                   event, @mentions disabled). The url must
   *                                   be https://discord.com/api/webhooks/{id}/{token}.
   *                                   Left out, a Discord url is detected
   *                                   automatically.
   *   url   - where events are POSTed. Must be http(s).
   *   mode  - optional, per-endpoint override of the global `mode` below
   *           (always 'cors' for Discord, which requires JSON).
   *   headers - optional, per-endpoint extra headers (merged over the global).
   *
   *   Discord-only, all optional:
   *   username   - overrides the webhook's display name. 1-80 chars, and may
   *                not contain "clyde" or "discord" (Discord rejects those).
   *   avatarUrl  - overrides the webhook's avatar image (http(s) url).
   *   threadId   - post into this existing thread (numeric id).
   *   threadName - for forum/media channels: create a thread with this name.
   *                Discord requires threadId or threadName for those channels.
   *
   * These URLs ship to the browser and are readable by anyone viewing source.
   * A Discord webhook url contains its token, so anyone who can see it can
   * post to (or delete) the webhook. Do not publish one you are not willing to
   * have abused; regenerate it in Discord if it leaks.
   */
  endpoints: [
    { id: "Olek's Server", label: 'oleks-discord', type: 'discord', url: 'https://discord.com/api/webhooks/1549751946150150235/i3HOr4P1mf99RagfAMIy6Ugf6HNuFGch_psPede3bwhjIf5_h9pDWcfGzRDTCw6PAyWF' },
  ],

  // Used when a profile has nothing selected yet. Leave '' to default to None.
  defaultEndpointId: '',

  // 'cors'    - normal POST; your endpoint must send Access-Control-Allow-Origin.
  //             Delivery success/failure is known, so retries work properly.
  // 'no-cors' - fire-and-forget for generic endpoints without CORS headers
  //             (e.g. some Zapier / Make hooks). The browser hides the response,
  //             so failures cannot be detected and retries are best-effort.
  //             Not used for Discord, which supports CORS.
  mode: 'cors',

  // Extra headers for every endpoint, e.g. { 'X-Api-Key': '...' }. Ignored when
  // the effective mode is 'no-cors', which only permits a simple Content-Type.
  headers: {},

  // Per-event switches. Delete or set false to mute one.
  events: {
    'profile.updated': true,
    'resume.generated': true,
    'profile.imported': true,
    'profile.exported': true
  },

  // Profile edits autosave on every keystroke; wait this long after typing
  // stops before emitting profile.updated.
  debounceMs: 2000,

  // Failed deliveries retry with exponential backoff, then park in
  // localStorage and flush on the next event or page load.
  retry: { attempts: 3, backoffMs: 800 },

  // Free-form label included in every envelope, to tell deploys apart.
  source: 'resume-tailor',

  /* Public IP address + country of the person using the page. A browser cannot
   * see its own public IP, so it is fetched from the providers below, tried in
   * order until one answers. Note that this sends the user's IP to that
   * provider too.
   *
   *   enabled      - false to omit IP / country from events entirely.
   *   providers    - HTTPS lookup urls, no API key needed. Responses shaped like
   *                  geojs.io, ipwho.is, ipapi.co or ipinfo.io are understood.
   *   timeoutMs    - per-provider wait before trying the next one. If all fail,
   *                  events are still sent, with ip / country set to null.
   *   cacheMinutes - reuse the result for this long within a browser session.
   */
  clientInfo: {
    enabled: true,
    providers: [
      'https://get.geojs.io/v1/ip/geo.json',
      'https://ipwho.is/',
      'https://ipapi.co/json/',
      'https://ipinfo.io/json'
    ],
    timeoutMs: 3000,
    cacheMinutes: 30
  }
};
