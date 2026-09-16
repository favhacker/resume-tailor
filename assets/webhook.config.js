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
 * Payloads are METADATA ONLY - counts, flags and the target company name. No
 * name, email, phone, links, summary, bullet text, skill names or endpoint
 * URLs are ever sent. See the redact section of assets/webhook.js.
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
   *   url   - where events are POSTed. Must be http(s).
   *   mode  - optional, per-endpoint override of the global `mode` below.
   *   headers - optional, per-endpoint extra headers (merged over the global).
   *
   * These URLs ship to the browser and are readable by anyone viewing source,
   * so use rotatable ingest URLs, never secrets.
   */
  endpoints: [
    { id: "Olek's Server", label: 'oleks-discord', url: 'https://discord.com/api/webhooks/1549751946150150235/i3HOr4P1mf99RagfAMIy6Ugf6HNuFGch_psPede3bwhjIf5_h9pDWcfGzRDTCw6PAyWF' },
  ],

  // Used when a profile has nothing selected yet. Leave '' to default to None.
  defaultEndpointId: '',

  // 'cors'    - normal POST; your endpoint must send Access-Control-Allow-Origin.
  //             Delivery success/failure is known, so retries work properly.
  // 'no-cors' - fire-and-forget for endpoints without CORS headers (many Zapier /
  //             Make / Discord style hooks). The browser hides the response, so
  //             failures cannot be detected and retries are best-effort.
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
  source: 'resume-tailor'
};
