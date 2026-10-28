/* Blocklist and access-code entry generator for Resume Tailor.
 *
 * assets/access.config.js stores blocked names and issued access codes as
 * salted hashes, so neither is readable in this repo or in the browser. This
 * turns one into the line you paste into that file.
 *
 *     node hash-name.mjs "Some Name" "Another Name"
 *     node hash-name.mjs --words "First Last"  # match these words in any order
 *     node hash-name.mjs --new-salt        # print a fresh random salt
 *     node hash-name.mjs --check "Some Name"   # is this name blocked right now?
 *
 *     node hash-name.mjs --new-code [n]        # issue n access codes (default 1)
 *     node hash-name.mjs --hash-code "CODE"    # entry for a code you chose
 *     node hash-name.mjs --check-code "CODE"   # would this code be accepted?
 *
 * ACCESS CODES are the allowlist half of the guard, and the one worth reaching
 * for: with `requireAccessCode: true`, only a profile holding an issued code
 * can open the Preview tab, so somebody blocked by name cannot get back in by
 * picking a different name. --new-code prints the code once - that printout is
 * the only copy, because the config stores only its hash. Keep your own record
 * of who holds which, outside this repo, and revoke by deleting the entry.
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

/* Codes are read aloud and retyped, so the alphabet leaves out the characters
   that get confused for each other: no 0/O, no 1/I/l. 32 symbols over 10
   characters is ~50 bits, far past guessing. */
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 10;

function newCode() {
  // 256 / 32 is exact, so masking the low 5 bits stays uniform.
  const bytes = randomBytes(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[bytes[i] & 31];
  // Grouped for reading out; the page strips the hyphen before comparing.
  return out.slice(0, 5) + '-' + out.slice(5);
}

/* Positional args are names, or codes in the three --*-code modes. --min takes
   a value, so the token after it is not one of them. */
const minIndex = args.indexOf('--min');
const positional = args.filter((a, i) => !a.startsWith('--') && !(minIndex !== -1 && i === minIndex + 1));
const codeMode = args.some((a) => a === '--new-code' || a === '--hash-code' || a === '--check-code');
const names = codeMode ? [] : positional;
const codeArgs = codeMode ? positional : [];

if (names.length === 0 && !codeMode) {
  console.error('Usage: node hash-name.mjs "Some Name" ["Another Name" ...]');
  console.error('       node hash-name.mjs --new-salt');
  console.error('       node hash-name.mjs --check "Some Name"');
  console.error('       node hash-name.mjs --new-code [n]');
  console.error('       node hash-name.mjs --hash-code "SOME-CODE"');
  console.error('       node hash-name.mjs --check-code "SOME-CODE"');
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
const { hash, isBlocked, hashCode, codeAccepted } = sandbox.window.RTAccess;

if (!String(cfg.salt || '').trim()) {
  console.warn('WARNING: access.config.js has no salt. Run --new-salt and set one before generating entries.\n');
}

if (check) {
  for (const name of names) {
    console.log(`${isBlocked(name) ? 'BLOCKED' : 'allowed'}  ${JSON.stringify(name)}`);
  }
  process.exit(0);
}

if (args.includes('--check-code')) {
  for (const code of codeArgs) {
    console.log(`${codeAccepted(code) ? 'accepted' : 'REJECTED'}  ${JSON.stringify(code)}`);
  }
  process.exit(0);
}

if (args.includes('--hash-code') || args.includes('--new-code')) {
  const issuing = args.includes('--new-code');
  const today = new Date().toISOString().slice(0, 10);

  let codes;
  if (issuing) {
    const n = codeArgs.length ? parseInt(codeArgs[0], 10) : 1;
    if (!(n >= 1 && n <= 100)) {
      console.error('--new-code takes how many codes to issue, 1 to 100.');
      process.exit(1);
    }
    codes = Array.from({ length: n }, newCode);
  } else {
    if (!codeArgs.length) {
      console.error('Usage: node hash-name.mjs --hash-code "SOME-CODE"');
      process.exit(1);
    }
    codes = codeArgs;
  }

  const entries = [];
  for (const code of codes) {
    const { hash: h, key } = hashCode(code);
    if (!key) {
      console.error(`  ${JSON.stringify(code)} has no letters or digits in it; skipped.`);
      continue;
    }
    if (key.length < 8) {
      console.warn(`  WARNING: ${JSON.stringify(code)} is only ${key.length} characters once punctuation is dropped. Short codes are guessable; 10 or more is the intent.`);
    }
    entries.push({ code, h });
  }
  if (!entries.length) process.exit(1);

  if (issuing) {
    console.log('Hand each person ONE of these. This is the only time it is printed -');
    console.log('the config keeps just the hash, so a lost code has to be reissued.\n');
    for (const { code } of entries) console.log(`    ${code}`);
    console.log('');
  }

  console.log('Paste into the `accessCodes` array in assets/access.config.js:\n');
  for (const { h } of entries) {
    console.log(`    { hash: '${h}', note: 'issued ${today}' },`);
  }

  console.log('\nDrop the trailing comma on the last entry, and put something in `note` that');
  console.log("tells you whose code it is WITHOUT naming them - the notes ship to every");
  console.log("visitor inside the bundle, so a name there undoes the hashing.");
  console.log('\nThen:  node embed-access.mjs && node stamp-cache-version.mjs');
  console.log('To revoke one person, delete their line and redeploy; nobody else is affected.');
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
