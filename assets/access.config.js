/* Resume Tailor - profile access rules (blacklist)
 *
 * Decides which tabs a profile may open, based on the name typed into
 * Profile > Full Name. The check re-runs every time the profile is saved
 * (which is on every keystroke, debounced by the app's autosave), so a
 * blocked name takes effect immediately - no reload needed.
 *
 * This file is the editable source of truth for the list, but it is NO LONGER
 * served on its own - it is baked into the app bundle so it cannot be blocked
 * by a request blocker. After editing, run:
 *
 *     node embed-access.mjs && node stamp-cache-version.mjs
 *
 * Editing it through GitHub's web UI alone will NOT change the live page.
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
 * The other half of the guard is `accessCodes`, further down. That one is an
 * allowlist, and it is the part that actually holds: a blocked name can be
 * changed in a second, an issued code cannot be guessed. Issue codes with:
 *
 *     node hash-name.mjs --new-code 3
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

  /* Reject names that cannot be a person's name at all - "\", "123", "asdf!!",
     a lone letter, an emoji. This is a rule rather than a blocklist entry
     because there is no way to enumerate every piece of junk somebody might
     type; `blocklist` handles named individuals, this handles nonsense.

     A name passes when every character is a letter, a mark (accents and the
     like), a space, or one of - ' . , and when it contains at least
     `minLetters` letters in total.

     So these pass:  Ada Lovelace / O'Neill / Jean-Luc / Zoe Ångström / 李雯
     and these do not:  \ / 123 / a / -- / test@example.com / asdf!!! / 😀

     allowEmpty  - true lets a blank name through, for when a profile is only
                   half filled in. false (the default) treats blank as nonsense,
                   so the gated tabs stay shut until a name is typed.
     extraChars  - punctuation to permit on top of the defaults, as a plain
                   string, e.g. '_/' . Regex metacharacters are taken literally.

     Set enabled: false to switch the whole rule off. */
  nameRules: {
    enabled: true,
    minLetters: 2,
    allowEmpty: false,
    extraChars: ''
  },

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

  /* Make Profile > Integrations > Access code a precondition for generating.
     With this on, `blockedTabs` stays hidden until the profile holds one of the
     codes in `accessCodes` below.

     This is the allowlist, and it is the rule to lean on. `blocklist` names the
     people who may not generate, which means it has to be widened every time
     somebody retypes their name - and each widening also catches strangers
     whose name happens to start the same way. A code cannot be worked around by
     editing the Profile tab, so the arms race stops.

     What it costs: every legitimate person needs a code from you before they
     can generate anything. And a code identifies an issue of access, not a
     person - whoever it is passed to can use it until you delete that entry.

     Safety valve: if `accessCodes` is empty, no profile could ever satisfy
     this, so the rule is ignored (with a console warning) rather than locking
     everyone out - including you. */
  requireAccessCode: true,

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
   *   { words: [{ hash, len }, { hash, len }] } - from
   *                                               `node hash-name.mjs --words "First Last"`.
   *       Matches when EVERY word appears in the name after punctuation and
   *       spacing are stripped out, so all of these are caught:
   *           First Last / First M Last / First Middle Last / Last, First
   *           First M.Last / First,Last / First/Last / FirstLast
   *       while "First Other" and "Other Last" are not. Reach for this when a
   *       prefix entry gets dodged by padding or re-punctuating the name. The
   *       entry-level `match` does not apply. A plain word may stand in for a
   *       { hash, len } pair while editing, at the cost of being readable.
   *
   *   { words: [...], min: 2 }                  - from `--words --min 2`.
   *       Only `min` of the listed words need appear, instead of all of them.
   *       This is the answer to a name part being cut down to an initial: list
   *       all three parts with min 2 and "First M Last", "F. Middle Last" and
   *       "First Middle L." all match, while anyone who shares just one part
   *       is untouched. Lower min means broader reach and more collateral.
   *
   * `len` is the character count of the hashed name. It lets the page check an
   * entry with a single hash instead of one per prefix, and it is required for
   * `match: 'contains'`. hash-name.mjs prints it for you.
   *
   * To add someone, append a line. To let someone back in, delete their line
   * (or comment it out with //).
   */
  blocklist: [
    { hash: '3d3b83832c99ef46cb1fe36acd11658ad5c1dc0ad4a2e5b8eaed4d796f8ff3f0', len: 11, note: 'C1' },
    { hash: 'cea80e1fd4971580053b5531eb5bb05ffecae6f802ea96a1a70e11f64fe7b9a0', len: 10, note: 'C2 - variant spelling of C1' },
    { hash: 'ee159821fa10cb3881ae8f76cf7a44f8dc8c364ca956be376fc493d639cedc12', len:  6, note: 'D1' },
    { hash: 'b846077df641c304890ddfb3b708b15921fb3dab7a3d7d12cd88c2e2d3298bf0', len:  8, note: 'S1' },
    { hash: '75e8e55c6e29bd38b37dfc038f27415f0c7480de3529f0cba6ea1e36f2d8897e', len:  7, note: 'I1' },
    { hash: 'b72daa6e1bb7cad9dbd90103b00a227f2224c5b66cedfc18a70c39b4af506f17', len:  6, note: 'A1' },
    { hash: '0eec0c0a20e9cd34fc80819c810c93798cabd34a2ef2b9b9b181849987956602', len:  5, note: 'J1' },
    { hash: 'eb3875675f6fc860bff7857546fd1383d315dcc43c0e637981a718ded83c2dbf', len:  5, note: 'Q1' },
    { hash: '29480caf52613aa246eb58aea82e09c2275638cae16be9c439d8b20d8676fae9', len:  5, note: 'E1' },
    { words: [{ hash: '64e25d22647e96d912920def488d026a7c482c7c33248552ebf44c99bd5e8ea2', len: 5 }, { hash: '13e0df5c435488f58a23b0e2e832bd9244a3a08a33cbc615560ababd8a06dd8d', len: 5 }, { hash: 'b93f86f000922e439c661f5fc76ac459df13c12d4ad4eb69654582ae3d011747', len: 4 }], min: 2, note: 'K1 - any 2 of 3 name parts; prefix, whole-word and all-words entries were each dodged in turn' },
    { hash: '426b19ec5427acfdd60773a4f351a9c91a897ee4267e7aa09d7260a2d9c11138', len: 11, note: 'M1 - full name, not just the first name' },
    { hash: 'a15dbec9b2d0e21e7bdf5f1aa7091d9da5e8f8c168592fe4879715bb325ac736', len:  6, note: 'J2' },
    { hash: 'c0b7b36f0b70ce0c75348321efc675071e42a0ddb931848a58a261cb7d9a1f4b', len:  5, note: 'T1' },
    { hash: '6de43f48cc9bef5caf1cc6dd37f750fca70fabc6b72848c599d510fe8c705ee9', len:  5, note: 'J3' },
    { words: [{ hash: '34a16d7922254527bae76c7eeae89f6b2be1564b6917fbb96f74eb3803c5b04d', len: 5 }, { hash: '4dd62701e04a1ddfc78366faff15a3b2d469b3412a76fc1a404cf4d88b9792d3', len: 6 }], note: 'A2 - full name, any order; catches surname-first forms the A3 prefix cannot' },
    { hash: '34a16d7922254527bae76c7eeae89f6b2be1564b6917fbb96f74eb3803c5b04d', len:  5, note: 'A3 - first name prefix, deliberately broad; also catches unrelated people whose name starts the same way' },
    { hash: '5cf468ee902912c76f8a70998fefb462ac168aa7ac87418c26906675b1c9b89d', len:  6, note: 'H1' },
    { hash: '9bc795b3bcf26f66c63eb6ace008ce2441432a92de7afa539d1151ea6dba7d59', len:  6, note: 'S2' },
    { hash: 'b1d2e8ad2c5e0a31422096d3bb1f773ab643069566fc7b4456b024b002fe9b5a', len:  4, note: 'K2' },
    { hash: '4dd62701e04a1ddfc78366faff15a3b2d469b3412a76fc1a404cf4d88b9792d3', len:  6, match: 'contains', note: 'R1 - surname, matched anywhere in the name; first name not known' },
    { hash: 'f7a1ca4a01280bdf545b589fbbbd60a0a409ea08c8a7e087eaea0b712f8581fb', len:  7, note: 'M2 - first name only; surname not known' },
    { hash: 'bfa5efc761fb373847b512efc4337cd6916c0cecc4191abd9bc7e321ccfaf509', len:  6, note: 'A4 - first name only; surname not known' },
    { hash: 'b05e512ea9bc91e7fea9615d5189c67d104b0a1deacc2b0e2da463846d5fcac5', len:  4, note: 'L1 - first name only; surname not known' },
    { hash: 'c8734e4a49d40f7257367d87576cbcf48410987f4962fd4768801fe13b068ec4', len:  4, note: 'C3 - first name only; surname not known' }
  ],

  /* The access codes currently issued, as salted hashes. Generate them with
   *
   *     node hash-name.mjs --new-code 3      # issue three
   *     node hash-name.mjs --hash-code "..." # hash a code you chose yourself
   *
   * and paste the lines it prints here. --new-code prints each code ONCE; this
   * file keeps only the digest, so a code nobody wrote down has to be reissued.
   * To check one against the list as it stands:
   *
   *     node hash-name.mjs --check-code "ABCDE-FGHJK"
   *
   * Each entry is { hash: '<digest>', note: 'why' }, or a plain 'SOME-CODE'
   * string while testing - readable by anyone viewing source, so not for real
   * use. Comparison ignores case and anything that is not a letter or a digit,
   * so 'abcde fghjk' and 'ABCDEFGHJK' are the same code.
   *
   * KEEP `note` FREE OF NAMES. These notes ship inside the bundle to every
   * visitor; a name in one undoes the point of hashing the blocklist.
   *
   * TO REVOKE one person's access, delete their line and redeploy. Nobody
   * else's code is affected. Keep your own record of who holds which, outside
   * this repo.
   *
   * Changing `salt` or `hashIterations` invalidates these too, exactly as it
   * does the blocklist.
   */
  accessCodes: [
    { hash: '27babfc8ed30f41383254b4ad5c4ccfa2a88acd3ec8526c3a99460779f59e962', note: 'issued 2026-10-28, #1' },
    { hash: 'd1207f9e61323d047bfcd34c9043172aac15711910d57fc47f78f50bacf088fc', note: 'issued 2026-10-28, #2' },
    { hash: '8315fca70c453c66aefa5984de6e9486ac0f00946a1519d969a8358a9d94993f', note: 'issued 2026-10-28, #3' },
    { hash: '5cd74ba304221ecb990765a568a02b165e02055da0d8bf490793522200673535', note: 'issued 2026-10-28, #4' },
    { hash: '647633a1437d2f329aa624b3fe15c5e2693ea52bbce7c177fe4013ae6bc792b7', note: 'issued 2026-10-28, #5' }
  ],

  /* Shown on the page in place of a blocked tab's content, if the app ever
     renders it before navigating away. Keep these short. `message` is the
     fallback for a reason with no entry in `messages`. */
  messages: {
    blocklist: 'This profile does not have access to the Preview tab.',
    name: 'Enter a real full name under Profile to unlock the Preview tab.',
    webhook: 'Choose a webhook under Profile > Integrations to unlock the Preview tab.',
    code: 'Enter your access code under Profile > Integrations to unlock the Preview tab.'
  },
  message: 'This profile does not have access to the Preview tab.'
};
