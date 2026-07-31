// ctrl-s. (Ari's room) — sprite generator. Calls Gemini image generation
// directly with Mick's API key (.env GEMINI_API_KEY, same key Bob uses in prod).
//
// Usage:
//   node scripts/ctrl-s-generate.mjs --list-models
//       → prints models on this key that can generate images (use if the
//         default model id ever rots — pinned Gemini ids have died before)
//
//   node scripts/ctrl-s-generate.mjs \
//     --ref "00. Ctrl-S Assets/sources/ari-bday-1.jpg" --ref "00. Ctrl-S Assets/sources/ari-bday-2.jpg" \
//     --brief "One-year-old girl beside a white cake with one lit pink candle, arms outstretched, big smile, gold foil number 1 balloon behind her." \
//     --count 2
//       → generates candidates into "00. Ctrl-S Assets/out/", style law prepended
//
//   node scripts/ctrl-s-generate.mjs \
//     --base "00. Ctrl-S Assets/out/approved-frame1.png" --no-style \
//     --brief "Exactly the same image. Only change: her arms slightly lower, candle flame bends left, balloon 3 pixels higher. Everything else identical, pixel for pixel."
//       → animation-frame edit mode (base sprite as the reference)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, extname, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const OUT_DIR = join(ROOT, '00. Ctrl-S Assets', 'out');
const STYLE_FILE = join(ROOT, '00. Ctrl-S Assets', 'style.md');
// Rolling caution: if this 404s, run --list-models and swap the id here.
const DEFAULT_MODEL = 'gemini-2.5-flash-image';

// ---------- tiny .env parser (no deps) ----------
const loadEnv = () => {
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
};

// ---------- args ----------
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const optAll = (name) => {
  const vals = [];
  args.forEach((a, i) => { if (a === `--${name}`) vals.push(args[i + 1]); });
  return vals;
};

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const imagePart = (path) => {
  const p = resolve(ROOT, path);
  const mime = MIME[extname(p).toLowerCase()];
  if (!mime) throw new Error(`Unsupported image type: ${path}`);
  return { inline_data: { mime_type: mime, data: readFileSync(p).toString('base64') } };
};

// ---------- main ----------
loadEnv();
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey || apiKey === 'PASTE_YOUR_KEY_HERE') {
  console.error('No GEMINI_API_KEY in .env yet — paste the key in first (same one as Vercel).');
  process.exit(1);
}

if (flag('list-models')) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${apiKey}`);
  if (!r.ok) { console.error(`List failed: ${r.status} ${await r.text()}`); process.exit(1); }
  const { models = [] } = await r.json();
  const imageModels = models.filter((m) =>
    m.name.includes('image') || (m.supportedGenerationMethods || []).includes('predict'));
  console.log('Models with "image" in the id (or predict support) on this key:\n');
  for (const m of imageModels) console.log(`  ${m.name.replace('models/', '')}  —  ${m.displayName || ''}`);
  process.exit(0);
}

const brief = opt('brief');
if (!brief) { console.error('Missing --brief "what this memory shows"'); process.exit(1); }

const model = opt('model') || DEFAULT_MODEL;
const count = Math.min(Number(opt('count') || 1), 4);
const refs = optAll('ref');
const base = opt('base');
const useStyle = !flag('no-style');

const styleBlock = useStyle
  ? readFileSync(STYLE_FILE, 'utf8').split('## The locked prompt block')[1].split('---')[0].trim()
  : '';
const prompt = [styleBlock, brief].filter(Boolean).join('\n\n');

const parts = [{ text: prompt }];
if (base) parts.push(imagePart(base));
for (const ref of refs) parts.push(imagePart(ref));

mkdirSync(OUT_DIR, { recursive: true });
const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

for (let i = 1; i <= count; i++) {
  process.stdout.write(`Generating candidate ${i}/${count}... `);
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    }),
  });
  if (!r.ok) {
    console.error(`\nAPI error ${r.status}: ${(await r.text()).slice(0, 500)}`);
    if (r.status === 404) console.error('\nModel id may have rotted — run with --list-models to find the current one.');
    process.exit(1);
  }
  const data = await r.json();
  const images = (data?.candidates?.[0]?.content?.parts || []).filter((p) => p.inlineData?.data);
  if (!images.length) {
    const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join(' ');
    console.error(`no image returned. Model said: ${text.slice(0, 300) || '(nothing)'}`);
    continue;
  }
  images.forEach((img, j) => {
    const file = join(OUT_DIR, `${stamp}-c${i}${images.length > 1 ? `-${j + 1}` : ''}.png`);
    writeFileSync(file, Buffer.from(img.inlineData.data, 'base64'));
    console.log(`saved ${file}`);
  });
}
