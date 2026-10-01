/* Resume Tailor - profile access rules (blacklist)
 *
 * Decides which tabs a profile may open, based on the name typed into
 * Profile > Full Name. The check re-runs every time the profile is saved
 * (which is on every keystroke, debounced by the app's autosave), so a
 * blocked name takes effect immediately - no reload needed.
 *
 * This file is plain JS (not part of the compiled bundle), so the list can be
 * edited here or through GitHub's web UI without rebuilding anything.
 *
 * Names are stored as SALTED HASHES, not as text, so nobody can read the list
 * out of this file or out of devtools. Add one with:
 *
 *     node hash-name.mjs "Some Name"
 *
 * and paste the line it prints into `blocklist` below. To check your work:
 *
 *     node hash-name.mjs --check "Some Name"
 *
 * WHAT THIS IS NOT: hashing hides the names from a casual reader. It is not
 * encryption and it is not a secret - the salt and the algorithm are served to
 * every visitor, so anyone willing to run a list of common first names through
 * them will recover a match. And the whole guard is browser-side: it keeps a
 * tab out of the UI, it does not protect anything behind that tab.
 */
window.RT_ACCESS_CONFIG = {
  // Master switch. false disables all blocking (every tab stays open).
  enabled: true,

  // Console logging when a profile is blocked or unblocked. Never logs the
  // name itself. false to quieten it.
  log: true,

  /* Which tabs to hide when the profile name matches. Tab ids are the keys of
     the app's nav: 'home', 'profile', 'preview', 'about', 'contact'.
     A blocked tab disappears from the nav bar, and if it is the tab currently
     open the app falls back to `fallbackTab` below. Never block 'profile' -
     that is the only place the name can be corrected. */
  blockedTabs: ['preview'],

  // Where to send someone who is sitting on a tab that just became blocked.
  fallbackTab: 'home',

  /* Make Profile > Integrations > Webhook a precondition for generating. With
     this on, `blockedTabs` stays hidden until the profile points at an endpoint
     that webhook.config.js still lists - so a profile that sends no events
     cannot produce a resume. Selecting "None", or keeping an id that has since
     been removed from webhook.config.js, both count as unset.

     The Profile tab marks the dropdown required while this is on.

     Safety valve: if webhook.config.js offers no usable endpoint at all, no
     profile could ever satisfy this, so the rule is ignored (with a console
     warning) rather than locking everyone out. */
  requireWebhook: true,

  /* Default matching rule, applied to every entry in `blocklist` that does not
     override it:
       'startsWith' - the name begins with the entry ("Alex" blocks
                      "Alex Carter", but not "Jo Alex")
       'exact'      - the whole name equals the entry
       'contains'   - the entry appears anywhere in the name
     Leading/trailing spaces are always ignored. */
  match: 'startsWith',

  // false (the default) matches regardless of capitalisation.
  caseSensitive: false,

  /* Salt mixed into every hash. Its only job is to make these digests specific
     to this deployment, so a generic rainbow table does not apply. Generate one
     with `node hash-name.mjs --new-salt`.

     CHANGING THE SALT, `hashIterations` OR `caseSensitive` INVALIDATES EVERY
     ENTRY BELOW - regenerate all of them if you touch any of the three. */
  salt: 'IWMS9jOzHW3TwIEj6_IZIO0NfocOXNxe',

  /* How many times to re-hash. Higher costs a brute-forcer more, and costs the
     page a little on each keystroke (results are cached, so in practice only
     the first check of a name is paid for). 1000 is a sane default; it does not
     make the list secret, only slower to attack. */
  hashIterations: 1000,

  /* The blacklist. Each entry is either:
   *
   *   { hash: '<digest>', len: 6 }              - the normal case, from
   *                                               `node hash-name.mjs "Name"`
   *   { hash: '...', len: 6, match: 'exact' }   - overrides the default rule
   *   { hash: '...', len: 6, note: 'why' }      - `note` is for humans only;
   *                                               keep it free of the name
   *   'PlainName'                               - still accepted, but READABLE
   *                                               by anyone viewing source
   *
   * `len` is the character count of the hashed name. It lets the page check an
   * entry with a single hash instead of one per prefix, and it is required for
   * `match: 'contains'`. hash-name.mjs prints it for you.
   *
   * To add someone, append a line. To let someone back in, delete their line
   * (or comment it out with //).
   */
  blocklist: [
    { hash: '1636710ea5314db5c81c2fbdbf0c5376deb44c0ffa70eda0a919a8f9d45517f9', len: 11, note: 'C1' },
    { hash: '7ea6098d47b3e7f49db08584ee72e781e0ff54cc4b2ee83aa0056f4cd6d4673c', len: 10, note: 'C2 - variant spelling of C1' },
    { hash: '36b87d7999c9e97bb0dfba1c6b6b5574f565db6e0e7f1431508c6cfcb2ad6d30', len:  6, note: 'D1' },
    { hash: 'eee878c2e83b5bc7e3a44c392d9e7809f8ffff44a7b11bdf645161e4f4e4ca61', len:  8, note: 'S1' },
    { hash: 'c2455df4d65dec74a3f5e18ce7e79848c1ec3c30846d1a956be517845ac65497', len:  7, note: 'I1' },
    { hash: '1e7fcf934aafd5cdcc703ca6d0763225fc4d28d30467ce7b6f360f4f7a9e6e2c', len:  6, note: 'A1' },
    { hash: '0eec0c0a20e9cd34fc80819c810c93798cabd34a2ef2b9b9b181849987956602', len:  5, note: 'J1' },
    { hash: 'eb3875675f6fc860bff7857546fd1383d315dcc43c0e637981a718ded83c2dbf', len:  5, note: 'Q1' },
    { hash: '29480caf52613aa246eb58aea82e09c2275638cae16be9c439d8b20d8676fae9', len:  5, note: 'E1' },
    { hash: 'dd197fef481c2a6b9476d42978caa6a3f38c33b71f0ca979caa40f29de64ad20', len: 10, note: 'K1 - full name, not just the first name' }
  ],

  /* Shown on the page in place of a blocked tab's content, if the app ever
     renders it before navigating away. Keep these short. `message` is the
     fallback for a reason with no entry in `messages`. */
  messages: {
    blocklist: 'This profile does not have access to the Preview tab.',
    webhook: 'Choose a webhook under Profile > Integrations to unlock the Preview tab.'
  },
  message: 'This profile does not have access to the Preview tab.'
};
