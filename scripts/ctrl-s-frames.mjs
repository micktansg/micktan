// ctrl-s. — frame processor. Takes the Gemini-generated frames of one memory,
// cuts the white background to transparency (flood fill from the borders, so
// whites INSIDE the art — cake frosting, romper — survive), stitches frames
// into one horizontal sprite sheet, halves the resolution, and drops it in
// public/room/ctrl-s/<slug>.png ready for the manifest.
//
// Usage (1..n frames, order = animation order; one frame = still memory):
//   node scripts/ctrl-s-frames.mjs --slug ari-turns-one \
//     --frame "00. Ctrl-S Assets/memories/2021-07-03-ari-turns-one/frames/f1.png" \
//     --frame "00. Ctrl-S Assets/memories/2021-07-03-ari-turns-one/frames/f2.png"
//
// Feed it whatever size Gemini produced — it measures the floor diamond and
// scales the memory so the diamond is exactly TILE_W, so every tile lands on
// the floor at the same size and the lattice stays flush. It also prints the
// sprite's anchor (its tile centre) for the manifest.
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
// The world tile. Every memory's floor diamond is scaled to exactly this, which
// is what lets the tiles sit edge to edge on the lattice in ctrl-s-memories.mjs.
// Changing it re-scales the entire floor — if you do, reprocess EVERY memory
// and update TILE in ctrl-s-memories.mjs to match, or the floor tears apart.
// --tile <px> overrides it for experiments.
const TILE_W = Number(opt('tile')) || 756;

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

// ---------- fit the floor diamond to the world tile ----------
// Gemini draws the tile at whatever fraction of the canvas it likes, so image
// width is a useless scale reference. The floor diamond is the invariant: fit
// every memory's diamond to TILE_W and the whole floor tessellates.
const measure = ({ data, w, h }) => {
  let bottomY = -1, widest = -1, widestY = 0;
  const rowMin = new Array(h).fill(Infinity), rowMax = new Array(h).fill(-1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 8) {
        if (x < rowMin[y]) rowMin[y] = x;
        if (x > rowMax[y]) rowMax[y] = x;
      }
    }
    if (rowMax[y] >= 0) {
      bottomY = y;
      const rw = rowMax[y] - rowMin[y] + 1;
      if (rw > widest) { widest = rw; widestY = y; }
    }
  }
  // The widest opaque row is the tile's horizontal diagonal — and on a diamond
  // that row passes through the CENTRE, so the tile centre is (midpoint, widestY).
  // Do not average it with the silhouette's bottom: these tiles are slabs, and
  // the paint below the diagonal is the slab's side face, whose thickness varies
  // per memory. Measuring through it tilts every memory off the ground plane by
  // a different amount.
  //
  // Slab thickness = how far paint continues straight down at the tile's left
  // vertex. Subtracting it twice over gives the true top-face height, which is
  // what the lattice must step by.
  const lx = rowMin[widestY];
  let deepest = widestY;
  for (let y = widestY; y < h; y++) {
    if (data[(y * w + lx) * 4 + 3] > 8) deepest = y;
    else if (y > deepest + 4) break;
  }
  const thickness = deepest - widestY;
  return {
    diamondW: widest,
    cx: (rowMin[widestY] + rowMax[widestY]) / 2,
    cy: widestY,
    thickness,
    topFaceH: 2 * (bottomY - thickness - widestY),
  };
};

const m0 = measure(frames[0]);
// scale straight to final size: fit the diamond to TILE_W, one resize not two
const scale = TILE_W / m0.diamondW;
const outFrameW = Math.max(1, Math.round(fw * scale));
const outH = Math.max(1, Math.round(fh * scale));

const scaled = [];
for (const f of frames) {
  scaled.push(await sharp(f.data, { raw: { width: fw, height: fh, channels: 4 } })
    .resize(outFrameW, outH)
    .raw()
    .toBuffer());
}

const sheetW = outFrameW * frames.length;
const sheet = Buffer.alloc(sheetW * outH * 4);
scaled.forEach((buf, i) => {
  for (let y = 0; y < outH; y++) {
    buf.copy(sheet, (y * sheetW + i * outFrameW) * 4, y * outFrameW * 4, (y + 1) * outFrameW * 4);
  }
});

// 256-colour palette PNG. The art only ever holds a few hundred meaningful
// tones, so quantising costs ~2/255 mean colour shift (invisible) and about
// 75% of the file size — which is what buys us a full-resolution tile.
const outPath = join(ROOT, 'public', 'room', 'ctrl-s', `${slug}.png`);
await sharp(sheet, { raw: { width: sheetW, height: outH, channels: 4 } })
  .png({ palette: true, colours: 256, effort: 10 })
  .toFile(outPath);

// anchor = the tile centre in the finished sprite's own pixels, so the manifest
// can hang the sprite off a lattice cell regardless of how much sky it carries
const anchor = { x: Math.round(m0.cx * scale), y: Math.round(m0.cy * scale) };
// measure frame 0 alone — measuring the stitched sheet would span every frame
const check = measure({ data: scaled[0], w: outFrameW, h: outH });

console.log(`sheet: ${outPath} (${sheetW}x${outH}, ${frames.length} frame${frames.length > 1 ? 's' : ''})`);
console.log(`tile fit: diamond ${m0.diamondW}px -> ${check.diamondW}px (target ${TILE_W}), scale ${scale.toFixed(3)}`);
console.log(`tile geometry: top face ${check.diamondW} x ${check.topFaceH}, slab thickness ${check.thickness}px`);
console.log(`  -> compare that height against TILE.h in ctrl-s-memories.mjs; if it drifts far from`);
console.log(`     the others, this memory will sit off the ground plane by half the difference.`);
console.log('\nmanifest entry values ->');
console.log(`  sheet: '/room/ctrl-s/${slug}.png', frames: ${frames.length}, w: ${outFrameW}, h: ${outH},`);
console.log(`  anchor: { x: ${anchor.x}, y: ${anchor.y} },   // tile centre — set col/row, x/y are derived`);
