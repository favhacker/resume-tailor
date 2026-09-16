/* Resume Tailor - webhook options
 *
 * The webhook URL itself is NOT set here. It lives in the app, under
 * Profile > Integrations > Webhook URL, and is saved with the profile like any
 * other field. It is optional - leave it blank and nothing is sent; events are
 * still logged to the console and dispatched as DOM events.
 *
 * This file holds the delivery options only. It is plain JS (not part of the
 * compiled bundle), so it can be edited here or through GitHub's web UI without
 * rebuilding anything.
 *
 * Payloads are METADATA ONLY - counts, flags and the target company name. No
 * name, email, phone, links, summary, bullet text, skill names or the webhook
 * URL are ever sent. See the redact section of assets/webhook.js for exactly
 * what gets built.
 */
window.RT_WEBHOOK_CONFIG = {
  // Master switch. false disables delivery, logging and DOM events entirely.
  enabled: true,

  // Console logging of every event. Set false to quieten it.
  log: true,

  // Optional fallback URL for deployments that want one baked in. The Profile
  // tab field always wins when it is filled. Anything set here ships to the
  // browser and is readable by anyone viewing source, so use a rotatable
  // ingest URL, never a secret.
  url: '',

  // 'cors'    - normal POST; your endpoint must send Access-Control-Allow-Origin.
  //             Delivery success/failure is known, so retries work properly.
  // 'no-cors' - fire-and-forget for endpoints without CORS headers (many Zapier /
  //             Make / Discord style hooks). The browser hides the response, so
  //             failures cannot be detected and retries are best-effort.
  mode: 'cors',

  // Extra headers, e.g. { 'X-Api-Key': '...' }. Ignored when mode is 'no-cors',
  // which only permits a simple Content-Type.
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
