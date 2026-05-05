// One-shot slicer for the new MOS character sheet.
//
// Approach: for each labeled zone, find every CONNECTED COMPONENT of dark
// pixels. Each component becomes its own output PNG (tight bbox + alpha
// mask = is-pixel-part-of-this-component). Light pixels inside a
// component (joint marker dots) become transparent — at game scale these
// are sub-pixel holes that disappear, but we get clean per-piece sprites
// even when one panel contains a stacked assembly.
//
// Run from project root:  node scripts/slice-mos.cjs

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const SRC = 'C:/Users/hello/Desktop/CLAUDE/PROJECTS/MickRoom/00. MOS Assets/newMOS.png';
const OUT_DIR = path.join('public', 'room', 'mos');

const src = PNG.sync.read(fs.readFileSync(SRC));
const W = src.width, H = src.height;
console.log('source:', W + 'x' + H);

// Zones (x0, y0, x1, y1) — measured by per-column vertical-band scan.
// Some panels (upper_arm, forearm, thigh) contain two stacked pieces;
// connected-components splits them automatically.
const ZONES = {
  head:       [220, 138,  600,  456],
  torso:      [220, 597,  600, 1059],
  briefcase:  [220, 1176, 600, 1456],
  upper_arm:  [820, 154, 1180,  712],
  forearm:    [820, 876, 1180, 1460],
  thigh:     [1430, 875, 1780, 1459],
  hand:      [1990, 172, 2310,  342],
  shin:      [1990, 558, 2310, 1127],
  shoe:      [1990, 1326, 2310, 1435],
};

const DARK_T = 180;
const PAD = 8;
const MIN_COMPONENT = 800; // ignore tiny ink fragments (anti-alias bits)

function lumAt(x, y) {
  const i = (y * W + x) * 4;
  return (src.data[i] + src.data[i + 1] + src.data[i + 2]) / 3;
}

// 4-connected components of dark pixels within the zone.
// Returns: array of { bbox: [x0,y0,x1,y1], pixels: Set<flat-index> }
function findDarkComponents([zx0, zy0, zx1, zy1]) {
  const w = zx1 - zx0;
  const h = zy1 - zy0;
  const dark = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      dark[y * w + x] = lumAt(zx0 + x, zy0 + y) < DARK_T ? 1 : 0;
    }
  }
  const seen = new Uint8Array(w * h);
  const components = [];
  const queue = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (!dark[idx] || seen[idx]) continue;
      const pixels = new Set();
      let minX = x, maxX = x, minY = y, maxY = y;
      seen[idx] = 1;
      queue.push(x, y);
      while (queue.length) {
        const py = queue.pop();
        const px = queue.pop();
        pixels.add(py * w + px);
        if (px < minX) minX = px; if (px > maxX) maxX = px;
        if (py < minY) minY = py; if (py > maxY) maxY = py;
        for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const nx = px + dx, ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const nidx = ny * w + nx;
          if (!dark[nidx] || seen[nidx]) continue;
          seen[nidx] = 1;
          queue.push(nx, ny);
        }
      }
      if (pixels.size >= MIN_COMPONENT) {
        components.push({
          bbox: [zx0 + minX, zy0 + minY, zx0 + maxX + 1, zy0 + maxY + 1],
          pixels,
          zoneOrigin: [zx0, zy0],
          zoneW: w,
        });
      }
    }
  }
  // Sort by Y then X so we can name parts top→bottom.
  components.sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
  return components;
}

// Save one component as a tight PNG: alpha = is-pixel-part-of-component
// (with PAD margin around bbox).
function saveComponent(comp, outPath) {
  const [bx0, by0, bx1, by1] = comp.bbox;
  const cx0 = Math.max(0, bx0 - PAD);
  const cy0 = Math.max(0, by0 - PAD);
  const cx1 = Math.min(W, bx1 + PAD);
  const cy1 = Math.min(H, by1 + PAD);
  const w = cx1 - cx0;
  const h = cy1 - cy0;
  const out = new PNG({ width: w, height: h });
  const [zx0, zy0] = comp.zoneOrigin;
  const zw = comp.zoneW;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const di = (y * w + x) * 4;
      // Map output pixel (cx0+x, cy0+y) → zone pixel (zx, zy)
      const zx = (cx0 + x) - zx0;
      const zy = (cy0 + y) - zy0;
      const inComp = zx >= 0 && zy >= 0 && zx < zw &&
        comp.pixels.has(zy * zw + zx);
      out.data[di + 0] = 0;
      out.data[di + 1] = 0;
      out.data[di + 2] = 0;
      out.data[di + 3] = inComp ? 255 : 0;
    }
  }
  fs.writeFileSync(outPath, PNG.sync.write(out));
  return [w, h];
}

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

for (const [name, zone] of Object.entries(ZONES)) {
  const comps = findDarkComponents(zone);
  if (comps.length === 0) {
    console.warn('[skip]', name, 'no dark components in', zone.join(','));
    continue;
  }
  if (comps.length === 1) {
    const [w, h] = saveComponent(comps[0], path.join(OUT_DIR, name + '.png'));
    console.log(name.padEnd(16), `${w}×${h}`);
  } else {
    // Stacked panel — name pieces top→bottom.
    comps.forEach((c, i) => {
      const suffix = i === 0 ? '_top' : i === 1 ? '_bot' : '_' + i;
      const [w, h] = saveComponent(c, path.join(OUT_DIR, name + suffix + '.png'));
      console.log((name + suffix).padEnd(16), `${w}×${h}`, 'pixels=' + c.pixels.size);
    });
  }
}
