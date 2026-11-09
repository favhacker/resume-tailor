/* Encrypts a webhook url for the `encryptedUrl` field in assets/webhook.config.js.
 *
 *     node encrypt-webhook.mjs "https://discord.com/api/webhooks/..."
 *
 * Paste the printed line into the endpoint in place of `url`, then run
 * `node embed-access.mjs && node stamp-cache-version.mjs`.
 *
 * The key is URL_KEY in assets/webhook.js, which is what the page decrypts
 * with. It is public along with the page: this keeps the url out of the repo
 * as plain text, it does not make it secret.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto } from 'node:crypto';

const root = dirname(fileURLToPath(import.meta.url));
const url = (process.argv[2] || '').trim();

if (!/^https:\/\//i.test(url)) {
  console.error('Usage: node encrypt-webhook.mjs "https://discord.com/api/webhooks/{id}/{token}"');
  process.exit(1);
}

const src = readFileSync(join(root, 'assets', 'webhook.js'), 'utf8');
const m = src.match(/var URL_KEY = '([A-Za-z0-9_-]+)';/);
if (!m) {
  console.error('Could not find URL_KEY in assets/webhook.js.');
  process.exit(1);
}

const key = await webcrypto.subtle.importKey('raw', Buffer.from(m[1], 'base64url'), { name: 'AES-GCM' }, false, ['encrypt']);
const iv = webcrypto.getRandomValues(new Uint8Array(12));
const ct = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(url)));

console.log(`encryptedUrl: '${Buffer.concat([iv, ct]).toString('base64url')}'`);
