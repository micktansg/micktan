// ctrl-s. — the save file manifest. One entry per memory.
//
// Every sprite is a horizontal sheet of equal-width frames (frames: 1 = still).
//
// PLACEMENT. Memories sit on an isometric lattice, one memory per cell, tiles
// flush edge to edge. You give a cell (col/row); x/y are derived below — never
// hand-write them. col walks the floor down-right, row walks it down-left:
//
//        (0,0)                 chronology drifts left -> right, so the next
//       /     \                memory is usually col+1 on the same row. Kin
//   (0,1)     (1,0)            cluster by sharing a row or a column.
//       \     /
//        (1,1)
//
// TILE is the floor diamond every sprite is scaled to — ctrl-s-frames.mjs fits
// each memory's diamond to TILE.w, and prints the `anchor` (the tile's centre
// inside that sprite) that hangs the artwork off its cell. A sprite carrying a
// lot of sky (a balloon, a railing) has a lower anchor and is drawn higher; the
// tile still lands exactly on the lattice. Cells are forever — the world grows
// outward, old memories never move.
//
// `album: true` means encrypted photos exist at /room/ctrl-s/album/<id>/
// (produced by scripts/ctrl-s-encrypt.mjs — photos are AES-GCM encrypted with
// the family passphrase; nothing readable ships without it).

// Sized to the native resolution of what Gemini produces (a tile diamond of
// ~750px), so sheets are stored at 1:1 and nothing is thrown away. Sheets are
// 256-colour palette PNGs, which makes a full-res tile cheaper on the wire than
// the old half-res truecolour one. w must match TILE_W in ctrl-s-frames.mjs.
//
// h is the TOP FACE height — not the sprite's silhouette, which also contains
// the slab's side face and would sit every memory off the ground plane by half
// its own thickness. Gemini's camera wobbles a degree or two between runs, so
// measured top faces vary (388 and 404 so far); h is their average, which
// splits the error and keeps seams under ~1% of a tile. The processor prints
// each memory's measured top face — if a new one drifts far from this, it will
// visibly float, and the fix is a reroll, not a nudge.
export const TILE = { w: 756, h: 396 };

const entries = [
  {
    id: 'ari-turns-one',
    title: 'ari turns one.',
    date: '2021-07-03',
    blurb:
      'one candle, one gold balloon, arms out like the whole day belonged to her. it did.',
    sheet: '/room/ctrl-s/ari-turns-one.png',
    frames: 2,
    w: 1272,
    h: 848,
    anchor: { x: 641, y: 568 },
    col: 0,
    row: 0,
    album: true,
  },
  {
    id: 'balcony-outside',
    title: 'the balcony was outside.',
    date: '2021-11-28',
    blurb:
      'infant care sent a souvenir home. the flat went quiet, the balcony became the outdoors, and we ate every meal facing the skyline.',
    sheet: '/room/ctrl-s/balcony-outside.png',
    frames: 2,
    w: 960,
    h: 640,
    anchor: { x: 473, y: 399 },
    col: 0,
    row: -1, // up-right of the birthday: one step back along the row axis
    album: true,
  },
  {
    id: 'hello-tooth-fairy',
    title: 'hello tooth fairy.',
    date: '2026-07-31',
    blurb:
      'she gnawed a rusk at six months waiting for these. at six years she sealed the first one in a bag and wrote the label herself.',
    // Processed WITH --fit-height: Gemini drew this tile's top face at 932px
    // against a 396 house tile, and no prompt wording moved its camera, so the
    // sprite is squashed 18.8% vertically to sit flush. Reprocess it with that
    // flag or it will float half the difference above its neighbours.
    sheet: '/room/ctrl-s/hello-tooth-fairy.png',
    frames: 2,
    w: 804,
    h: 1160,
    anchor: { x: 402, y: 619 },
    col: 0,
    row: -2,
    album: true,
  },
];

// cell -> world position of that tile's centre
const cellCentre = (col, row) => ({
  x: (col - row) * (TILE.w / 2),
  y: (col + row) * (TILE.h / 2),
});

// Hang each sprite off its cell by its anchor, then sort back-to-front so the
// canvas paints in isometric depth order (a tile lower on screen is nearer, so
// it draws last and overlaps its neighbour behind). Sorting here means adding a
// memory anywhere in the list above is always safe.
export const memories = entries
  .map((m) => {
    const c = cellCentre(m.col, m.row);
    return { ...m, x: Math.round(c.x - m.anchor.x), y: Math.round(c.y - m.anchor.y) };
  })
  .sort((a, b) => a.col + a.row - (b.col + b.row));

// Shared stop-motion heartbeat (ms per frame). One clock for the whole floor —
// every memory breathes on the same beat, floor796-style.
export const FRAME_MS = 550;
