/* Resume Tailor - profile access rules (blacklist)
 *
 * Decides which tabs a profile may open, based on the name typed into
 * Profile > Full Name. The check re-runs every time the profile is saved
 * (which is on every keystroke, debounced by the app's autosave), so a
 * blocked name takes effect immediately - no reload needed.
 *
 * This file is plain JS (not part of the compiled bundle), so the list can be
 * edited here or through GitHub's web UI without rebuilding anything. Add,
 * remove or reword entries freely; nothing else has to change.
 *
 * NOTE: this is a UI guard, not security. Everything runs in the browser, so
 * anyone who can open devtools can bypass it. Use it to keep people out of a
 * tab by accident or by policy, not to protect secrets.
 */
window.RT_ACCESS_CONFIG = {
  // Master switch. false disables all blocking (every tab stays open).
  enabled: true,

  // Console logging when a profile is blocked or unblocked. false to quieten.
  log: true,

  /* Which tabs to hide when the profile name matches. Tab ids are the keys of
     the app's nav: 'home', 'profile', 'preview', 'about', 'contact'.
     A blocked tab disappears from the nav bar, and if it is the tab currently
     open the app falls back to `fallbackTab` below. Never block 'profile' -
     that is the only place the name can be corrected. */
  blockedTabs: ['preview'],

  // Where to send someone who is sitting on a tab that just became blocked.
  fallbackTab: 'home',

  /* Default matching rule, applied to every entry in `blocklist` that does not
     override it:
       'startsWith' - the name begins with the entry ("Dennis" blocks
                      "Dennis Carter", but not "Jo Dennis")
       'exact'      - the whole name equals the entry
       'contains'   - the entry appears anywhere in the name
     Leading/trailing spaces are always ignored. */
  match: 'startsWith',

  // false (the default) matches regardless of capitalisation.
  caseSensitive: false,

  /* The blacklist. Each entry is either:
   *
   *   'Dennis'                                  - uses `match` above
   *   { value: 'Dennis', match: 'exact' }       - overrides the rule
   *   { value: 'Dennis', note: 'why' }          - `note` is for humans only
   *
   * To add someone, append a line. To let someone back in, delete their line
   * (or comment it out with //).
   */
  blocklist: [
    { value: 'Christopher', note: 'blocked from resume preview/generation' },
    { value: 'Christoper',  note: 'common misspelling of the above' },
    { value: 'Dennis',      note: 'blocked from resume preview/generation' }
  ],

  /* Shown on the page in place of the blocked tab's content, if the app ever
     renders it before navigating away. Keep it short. */
  message: 'This profile does not have access to the Preview tab.'
};
