/* Blocklist entry generator for Resume Tailor.
 *
 * assets/access.config.js stores blocked names as salted hashes, so the names
 * themselves are not readable in this repo or in the browser. This turns a name
 * into the line you paste into that file.
 *
 *     node hash-name.mjs "Some Name" "Another Name"
 *     node hash-name.mjs --words "First Last"  # match these words in any order
 *     node hash-name.mjs --new-salt        # print a fresh random salt
 *     node hash-name.mjs --check "Some Name"   # is this name blocked right now?
 *
 * --words is the one to reach for when somebody pads their name out to dodge a
 * prefix entry: `--words "First Last"` blocks "First Last", "First M Last",
 * "First Middle Last" and "Last, First" alike, while leaving anyone who shares
 * only one of the two words alone.
 *
 * It reads the salt, hashIterations and caseSensitive already in
 * access.config.js and uses the same hashing code the page uses, so what it
 * prints is guaranteed to match at runtime. Change any of those three settings
 * and every existing entry has to be regenerated.
 *
 * You can also do this from the browser console on the live page:
 *     RTAccess.hash('Some Name')
 *
 * Reminder: hashing hides the names from a casual reader, nothing more. The
 * salt ships with the page, so a list of common first names run through the
 * same function will recover a match. Do not treat this as a secret.
 */
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(root, 'assets', 'access.config.js');
const GUARD = join(root, 'assets', 'access.js');

const args = process.argv.slice(2);

if (args.includes('--new-salt')) {
  console.log(randomBytes(24).toString('base64url'));
  console.log('\nPaste that as `salt` in assets/access.config.js, then regenerate every blocklist entry.');
  process.exit(0);
}

const check = args.includes('--check');
const names = args.filter((a) => !a.startsWith('--'));

if (names.length === 0) {
  console.error('Usage: node hash-name.mjs "Some Name" ["Another Name" ...]');
  console.error('       node hash-name.mjs --new-salt');
  console.error('       node hash-name.mjs --check "Some Name"');
  process.exit(1);
}

// Run the two browser scripts in a sandbox that looks enough like a window.
// webhook.js is not loaded here, so access.js sees no endpoints and complains
// that requireWebhook is unsatisfiable. That is true of this sandbox and not of
// the page, and hashing does not care either way, so drop just that one.
const sandbox = {
  console: {
    log() {},
    warn: (...a) => { if (!String(a.join(' ')).includes('requireWebhook')) console.warn(...a); }
  }
};
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const file of [CONFIG, GUARD]) {
  vm.runInContext(readFileSync(file, 'utf8'), sandbox, { filename: file });
}

const cfg = sandbox.window.RT_ACCESS_CONFIG || {};
const { hash, isBlocked } = sandbox.window.RTAccess;

if (!String(cfg.salt || '').trim()) {
  console.warn('WARNING: access.config.js has no salt. Run --new-salt and set one before generating entries.\n');
}

if (check) {
  for (const name of names) {
    console.log(`${isBlocked(name) ? 'BLOCKED' : 'allowed'}  ${JSON.stringify(name)}`);
  }
  process.exit(0);
}

if (args.includes('--words')) {
  console.log(`salt set: ${!!String(cfg.salt || '').trim()}   hashIterations: ${cfg.hashIterations ?? 1}   caseSensitive: ${cfg.caseSensitive === true}\n`);
  console.log('Paste into the `blocklist` array in assets/access.config.js:\n');
  for (const name of names) {
    const parts = name.split(/\s+/).map((w) => w.trim()).filter(Boolean);
    if (parts.length < 2) {
      console.error(`  "${name}" is a single word — use a normal entry instead, or allWords will block everyone who shares it.`);
      continue;
    }
    const hashes = parts.map((w) => `'${hash(w).hash}'`);
    console.log(`    { words: [${hashes.join(', ')}], note: '' },`);
  }
  console.log('\nEvery word must appear for the entry to match, in any order.');
  console.log("Drop the trailing comma on the last entry and fill in `note`.");
  process.exit(0);
}

console.log(`salt set: ${!!String(cfg.salt || '').trim()}   hashIterations: ${cfg.hashIterations ?? 1}   caseSensitive: ${cfg.caseSensitive === true}`);
console.log(`match: ${cfg.match || 'startsWith'}\n`);
console.log('Paste into the `blocklist` array in assets/access.config.js:\n');

for (const name of names) {
  const { hash: h, len } = hash(name);
  console.log(`    { hash: '${h}', len: ${len}, note: '' },`);
}

console.log('\nDrop the trailing comma on the last entry, and put something in `note` that');
console.log("identifies the person to you without naming them (e.g. 'req 2026-02, see ticket 41').");
