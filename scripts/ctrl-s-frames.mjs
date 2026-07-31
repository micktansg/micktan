// ctrl-s. — frame processor. Takes the Gemini-generated frames of one memory,
// cuts the white background to transparency (flood fill from the borders, so
// whites INSIDE the art — cake frosting, romper — survive), stitches frames
// into one horizontal sprite sheet, halves the resolution, and drops it in
// public/room/ctrl-s/<slug>.png ready for the manifest.
//
// Usage (1..n frames, order = animation order; one frame = still memory):
//   node scripts/ctrl-s-frames.mjs --slug ari-turns-one \
//     --frame "00. Ctrl-S Assets/out/ari-turns-one-c3.png" \
//     --frame "00. Ctrl-S Assets/out/ari-turns-one-f2.png"
//
// Prints the manifest w/h to paste into src/data/ctrl-s-memories.mjs.

import { resolve, join } from 'node:path';
import sharp from 'sharp';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const optAll = (name) => {
  const vals = [];
  args.forEach((a, i) => { if (a === `--${name}`) vals.push(args[i + 1]); });
  return vals;
};

const slug = opt('slug');
const framePaths = optAll('frame');
if (!slug || !framePaths.length) {
  console.error('Need --slug <memory-slug> and at least one --frame <png>');
  process.exit(1);
}

const ROOT = resolve(import.meta.dirname, '..');
const THR = 232; // near-white threshold (tolerates JPEG-ish noise)

const cutout = async (path) => {
  const { data, info } = await sharp(resolve(ROOT, path))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const visited = new Uint8Array(w * h);
  const queue = [];
  for (let x = 0; x < w; x++) { queue.push(x, (h - 1) * w + x); }
  for (let y = 0; y < h; y++) { queue.push(y * w, y * w + w - 1); }
  while (queue.length) {
    const idx = queue.pop();
    if (visited[idx]) continue;
    visited[idx] = 1;
    const o = idx * 4;
    if (data[o] >= THR && data[o + 1] >= THR && data[o + 2] >= THR) {
      data[o + 3] = 0;
      const x = idx % w, y = (idx - x) / w;
      if (x > 0) queue.push(idx - 1);
      if (x < w - 1) queue.push(idx + 1);
      if (y > 0) queue.push(idx - w);
      if (y < h - 1) queue.push(idx + w);
    }
  }
  return { data, w, h };
};

const frames = [];
for (const p of framePaths) frames.push(await cutout(p));

const fw = frames[0].w, fh = frames[0].h;
for (const f of frames) {
  if (f.w !== fw || f.h !== fh) {
    console.error(`Frame size mismatch: expected ${fw}x${fh}, got ${f.w}x${f.h}. ` +
      'All frames of a memory must come out of Gemini at identical dimensions.');
    process.exit(1);
  }
}

// stitch horizontally, then halve
const sheet = Buffer.alloc(fw * frames.length * fh * 4);
frames.forEach((f, i) => {
  for (let y = 0; y < fh; y++) {
    f.data.copy(sheet, (y * fw * frames.length + i * fw) * 4, y * fw * 4, (y + 1) * fw * 4);
  }
});

const outW = Math.round((fw * frames.length) / 2);
const outH = Math.round(fh / 2);
const outPath = join(ROOT, 'public', 'room', 'ctrl-s', `${slug}.png`);
await sharp(sheet, { raw: { width: fw * frames.length, height: fh, channels: 4 } })
  .resize(outW, outH)
  .png()
  .toFile(outPath);

const memW = Math.round(fw / 2), memH = outH;
console.log(`sheet: ${outPath} (${outW}x${outH}, ${frames.length} frame${frames.length > 1 ? 's' : ''})`);
console.log(`manifest entry values ->  sheet: '/room/ctrl-s/${slug}.png', frames: ${frames.length}, w: ${memW}, h: ${memH}`);
