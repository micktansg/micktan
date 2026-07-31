// ctrl-s. — the save file manifest. One entry per memory.
//
// Every sprite is a horizontal sheet of equal-width frames (frames: 1 = still).
// x/y are world coordinates of the sprite's top-left corner; the canvas engine
// pans/zooms over this plane and lazy-loads sheets as the camera approaches.
// Grow the world by appending entries — coordinates are forever, so place new
// memories near their kin (chronology drifts left-to-right, roughly).
//
// `album: true` means encrypted photos exist at /room/ctrl-s/album/<id>/
// (produced by scripts/ctrl-s-encrypt.mjs — photos are AES-GCM encrypted with
// the family passphrase; nothing readable ships without it).

export const memories = [
  {
    id: 'ari-turns-one',
    title: 'ari turns one.',
    date: '2021-07-03',
    blurb:
      'one candle, one gold balloon, arms out like the whole day belonged to her. it did.',
    sheet: '/room/ctrl-s/ari-turns-one.png',
    frames: 2,
    w: 632,
    h: 421,
    x: 0,
    y: 0,
    album: true,
  },
];

// Shared stop-motion heartbeat (ms per frame). One clock for the whole floor —
// every memory breathes on the same beat, floor796-style.
export const FRAME_MS = 550;
