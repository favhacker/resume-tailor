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
 * --words is the one to reach for when somebody edits their name to dodge a
 * prefix entry. `--words "First Last"` matches whenever both words appear, with
 * punctuation and spacing ignored entirely:
 *
 *     First Last / First M Last / First Middle Last / Last, First
 *     First M.Last / First,Last / First/Last / FirstLast
 *
 * while anyone sharing only one of the two words is left alone.
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

// Positional args are names. --min takes a value, so skip the token after it.
const minIndex = args.indexOf('--min');
const names = args.filter((a, i) => !a.startsWith('--') && !(minIndex !== -1 && i === minIndex + 1));

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
  // --min N : how many of the words must appear. Default is all of them.
  const mi = args.indexOf('--min');
  const min = mi !== -1 ? parseInt(args[mi + 1], 10) : 0;
  if (mi !== -1 && !(min >= 1)) {
    console.error('--min needs a number of 1 or more, e.g. --min 2');
    process.exit(1);
  }

  console.log(`salt set: ${!!String(cfg.salt || '').trim()}   hashIterations: ${cfg.hashIterations ?? 1}   caseSensitive: ${cfg.caseSensitive === true}\n`);
  console.log('Paste into the `blocklist` array in assets/access.config.js:\n');
  for (const name of names) {
    const parts = name.split(/\s+/).map((w) => w.trim()).filter(Boolean);
    if (parts.length < 2) {
      console.error(`  "${name}" is a single word — use a normal entry instead, or allWords will block everyone who shares it.`);
      continue;
    }
    if (min > parts.length) {
      console.error(`  --min ${min} is more than the ${parts.length} words in "${name}".`);
      continue;
    }
    const items = parts.map((w) => {
      const { hash: h, len } = hash(w);
      return `{ hash: '${h}', len: ${len} }`;
    });
    const minField = min >= 1 && min < parts.length ? `, min: ${min}` : '';
    console.log(`    { words: [${items.join(', ')}]${minField}, note: '' },`);
  }
  if (min >= 1) {
    console.log(`\nAt least ${min} of the words must appear, in any order, with separators ignored.`);
    console.log('Use this when a name part gets cut down to an initial: listing all three');
    console.log('parts with --min 2 catches "A. Middle Last" and "Ada M. Last" alike, while');
    console.log('anyone sharing only one part is untouched.');
  } else {
    console.log('\nEvery word must appear for the entry to match, in any order, and');
    console.log('separators are ignored - "First M.Last" and "FirstLast" match too.');
    console.log('If a part may be shortened to an initial, regenerate with --min 2.');
  }
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
