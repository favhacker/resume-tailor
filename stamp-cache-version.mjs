/* Cache-busting stamper for Resume Tailor.
 *
 * Rewrites the ?v=... marker on every LOCAL asset in index.html to a fresh
 * value, so a normal browser refresh fetches the new files instead of serving
 * stale cached copies (no more "hard refresh to see my change").
 *
 * Run it before you commit/deploy:
 *     node stamp-cache-version.mjs
 *
 * External URLs (Google Fonts, https://...) are left untouched.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const file = join(root, 'index.html');

// Compact, sortable, human-readable: YYYYMMDD-HHMMSS in local time.
const d = new Date();
const p = (n) => String(n).padStart(2, '0');
const version = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;

const html = readFileSync(file, 'utf8');

// Match src="..." / href="..." for LOCAL .js/.css only (skip http/https and //).
// Adds ?v=<version> if missing, or replaces an existing one.
const re = /((?:src|href)=")(?!https?:|\/\/)([^"?]+\.(?:js|css))(?:\?v=[^"]*)?(")/g;

let count = 0;
const out = html.replace(re, (_m, pre, path, post) => {
  count++;
  return `${pre}${path}?v=${version}${post}`;
});

if (count === 0) {
  console.error('No local .js/.css asset references found in index.html - nothing stamped.');
  process.exit(1);
}

writeFileSync(file, out);
console.log(`Stamped ${count} asset reference(s) with ?v=${version}`);
