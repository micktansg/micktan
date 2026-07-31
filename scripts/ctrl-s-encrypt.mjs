// ctrl-s. — album encryptor. Turns a memory's source photos into AES-GCM
// encrypted blobs the room can only open with the family passphrase.
// The passphrase is never stored anywhere; wrong passphrase = decrypt fails.
//
// Usage:
//   node scripts/ctrl-s-encrypt.mjs --id ari-turns-one --src "00. Ctrl-S Assets/sources/Ari Turns One" --pass "the family words"
//
// Output: public/room/ctrl-s/album/<id>/  ->  album.json + <n>.enc files.
// Photos are resized to max 1400px and recompressed before encryption, so the
// site never ships full-resolution originals even to passphrase holders.
// Then set `album: true` on the memory in src/data/ctrl-s-memories.mjs.

import { readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { webcrypto as crypto } from 'node:crypto';
import sharp from 'sharp';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const id = opt('id');
const src = opt('src');
const pass = opt('pass');
if (!id || !src || !pass) {
  console.error('Need --id <memory-id> --src <photo folder> --pass <passphrase>');
  process.exit(1);
}

const ROOT = resolve(import.meta.dirname, '..');
const srcDir = resolve(ROOT, src);
const outDir = join(ROOT, 'public', 'room', 'ctrl-s', 'album', id);
mkdirSync(outDir, { recursive: true });

const photos = readdirSync(srcDir).filter((f) =>
  ['.jpg', '.jpeg', '.png', '.webp'].includes(extname(f).toLowerCase())
);
if (!photos.length) { console.error(`No photos found in ${srcDir}`); process.exit(1); }

const salt = crypto.getRandomValues(new Uint8Array(16));
const baseKey = await crypto.subtle.importKey(
  'raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']
);
const key = await crypto.subtle.deriveKey(
  { name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' },
  baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt']
);

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const files = [];
let n = 0;
for (const photo of photos) {
  n++;
  const jpeg = await sharp(join(srcDir, photo))
    .rotate() // respect EXIF orientation
    .resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, jpeg);
  const name = `${n}.enc`;
  writeFileSync(join(outDir, name), Buffer.from(cipher));
  files.push({ src: name, iv: b64(iv) });
  console.log(`${photo} -> ${name} (${Math.round(cipher.byteLength / 1024)} KB)`);
}

writeFileSync(join(outDir, 'album.json'), JSON.stringify({ salt: b64(salt), files }, null, 2));
console.log(`\nalbum.json + ${files.length} encrypted photos -> ${outDir}`);
console.log(`Now set album: true for "${id}" in src/data/ctrl-s-memories.mjs`);
