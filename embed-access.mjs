/* Bakes the runtime guards into the app bundle for Resume Tailor.
 *
 * webhook.js and access.js used to be their own <script> tags. That made them
 * trivial to defeat: block one request in devtools or an ad blocker and the
 * guard never loaded. Blocking access.js removed the blocklist; blocking
 * webhook.js emptied the endpoint list, which switched off the requireWebhook
 * rule by way of its own safety valve.
 *
 * So the four files are concatenated into the top of the bundle instead, inside
 * a marked region, and index.html stops referencing them. There is now one
 * request to block, and blocking it leaves no app at all. The bundle also fails
 * closed, so if the region is ever stripped the gated tabs stay hidden rather
 * than opening up - see RTblockedNow() in the bundle.
 *
 * The files under assets/ remain the editable source of truth. Edit the
 * blocklist in assets/access.config.js as before, then run:
 *
 *     node embed-access.mjs
 *     node stamp-cache-version.mjs
 *
 * Re-running is safe: an existing region is replaced, not stacked.
 *
 * This raises the cost of casual tampering. It is not a security boundary -
 * the page still runs on the visitor's machine, so a local override or an
 * edited copy of the bundle defeats any of it.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const assets = join(root, 'assets');

const START = '/*RT_ACCESS_EMBED_START*/';
const END = '/*RT_ACCESS_EMBED_END*/';

// Load order matters: each config before the script that reads it, and
// webhook.js before access.js, which asks it for the endpoint list.
const SOURCES = ['webhook.config.js', 'webhook.js', 'access.config.js', 'access.js'];

const bundles = readdirSync(assets).filter((f) => /^index-[\w-]+\.js$/.test(f));
if (bundles.length !== 1) {
  console.error(`Expected exactly one assets/index-*.js bundle, found ${bundles.length}: ${bundles.join(', ') || '(none)'}`);
  process.exit(1);
}
const bundleFile = join(assets, bundles[0]);

const parts = SOURCES.map((name) => {
  const body = readFileSync(join(assets, name), 'utf8');
  if (body.includes(START) || body.includes(END)) {
    console.error(`${name} contains the embed marker; refusing to nest regions.`);
    process.exit(1);
  }
  return `/* --- ${name} --- */\n${body}`;
});

// One outer IIFE so nothing here can collide with the bundle's own top-level
// names. The parts themselves only assign to window.
const region = `${START}(function(){\n${parts.join('\n')}\n})();${END}\n`;

let src = readFileSync(bundleFile, 'utf8');

const from = src.indexOf(START);
const to = src.indexOf(END);
let action;

if (from !== -1 && to !== -1 && to > from) {
  src = src.slice(0, from) + region + src.slice(to + END.length).replace(/^\n/, '');
  action = 'replaced';
} else if (from !== -1 || to !== -1) {
  console.error('Bundle has a damaged embed region (one marker without its pair). Fix it by hand or restore the bundle from git.');
  process.exit(1);
} else {
  src = region + src;
  action = 'inserted';
}

writeFileSync(bundleFile, src);

const kb = (n) => `${(n / 1024).toFixed(1)}kB`;
console.log(`${action} embed region in assets/${bundles[0]} (${kb(region.length)} from ${SOURCES.length} files)`);
for (const name of SOURCES) console.log(`  - ${name}`);
console.log('\nNow run: node stamp-cache-version.mjs');
