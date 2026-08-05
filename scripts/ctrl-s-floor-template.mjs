// ctrl-s. — floor template generator.
//
// Draws the canonical empty floor tile at the house's exact geometry, in the
// house's own wood palette, on the white background the cutout expects. This
// image is attached to EVERY Gemini generation as the tile master.
//
// Why it exists: Gemini will not follow a verbal description of the tile's
// proportions. "True 2:1 isometric diamond, twice as wide as it is tall" was
// ignored across many generations, which produced a 1.55:1 tile where the house
// is ~1.91:1 — off by enough that the memory either floats or has to be squashed
// 19% to fit. Image models copy geometry from a reference image far better than
// from numbers in a prompt, so we hand them the shape instead of describing it.
//
// Usage:  node scripts/ctrl-s-floor-template.mjs
// Output: "00. Ctrl-S Assets/floor-template.png" (committed — it's a tool, not
// private art). Regenerate it if TILE in src/data/ctrl-s-memories.mjs changes.

import { resolve, join } from 'node:path';
import sharp from 'sharp';
import { TILE } from '../src/data/ctrl-s-memories.mjs';

const ROOT = resolve(import.meta.dirname, '..');

// Render the tile larger than world scale so the reference is crisp, keeping
// TILE's exact ratio — the ratio is the whole point of this image.
const SCALE = 1200 / TILE.w;
const halfW = Math.round((TILE.w * SCALE) / 2);
const halfH = Math.round((TILE.h * SCALE) / 2);
const THICK = Math.round(35 * SCALE); // slab depth, averaged from the shipped tiles

const W = halfW * 2 + 120;
const H = halfH * 2 + THICK + 120;
const cx = Math.round(W / 2);
const cy = Math.round((H - THICK) / 2);

// sampled from the birthday tile — the house wood
const TOP_LIGHT = [239, 199, 150];
const TOP_DARK = [232, 188, 138]; // plank seam
const SIDE_LEFT = [184, 134, 101];
const SIDE_RIGHT = [160, 113, 84];
const OUTLINE = [92, 60, 42];

const buf = Buffer.alloc(W * H * 3, 255);
const put = (x, y, c) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2];
};

// --- top face: |dx|/halfW + |dy|/halfH <= 1 ---
const onTop = (x, y) => Math.abs(x - cx) / halfW + Math.abs(y - cy) / halfH <= 1;
for (let y = cy - halfH; y <= cy + halfH; y++) {
  for (let x = cx - halfW; x <= cx + halfW; x++) {
    if (!onTop(x, y)) continue;
    // plank seams run parallel to one tile edge
    const u = (x - cx) / halfW + (y - cy) / halfH;
    const seam = Math.abs(((u + 2) % 0.25) - 0.125) < 0.006;
    put(x, y, seam ? TOP_DARK : TOP_LIGHT);
  }
}

// --- slab sides: drop THICK px below the tile's lower two edges ---
for (let x = cx - halfW; x <= cx + halfW; x++) {
  const dx = Math.abs(x - cx) / halfW;
  const yBottom = Math.round(cy + halfH * (1 - dx));
  for (let y = yBottom; y < yBottom + THICK; y++) put(x, y, x < cx ? SIDE_LEFT : SIDE_RIGHT);
}

// --- 1px outline around the whole silhouette ---
const solid = (x, y) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return false;
  const i = (y * W + x) * 3;
  return !(buf[i] === 255 && buf[i + 1] === 255 && buf[i + 2] === 255);
};
const edges = [];
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (!solid(x, y)) continue;
    if (!solid(x - 1, y) || !solid(x + 1, y) || !solid(x, y - 1) || !solid(x, y + 1)) edges.push([x, y]);
  }
}
for (const [x, y] of edges) put(x, y, OUTLINE);

// --- seam between top face and slab, so the thickness reads clearly ---
for (let x = cx - halfW; x <= cx + halfW; x++) {
  const dx = Math.abs(x - cx) / halfW;
  put(x, Math.round(cy + halfH * (1 - dx)), OUTLINE);
}

const out = join(ROOT, '00. Ctrl-S Assets', 'floor-template.png');
await sharp(buf, { raw: { width: W, height: H, channels: 3 } }).png().toFile(out);

console.log(`floor template -> ${out}`);
console.log(`  canvas ${W}x${H}, top face ${halfW * 2}x${halfH * 2} (ratio ${(halfW / halfH).toFixed(3)}:1), slab ${THICK}px`);
console.log(`  matches TILE ${TILE.w}x${TILE.h} (ratio ${(TILE.w / TILE.h).toFixed(3)}:1)`);
