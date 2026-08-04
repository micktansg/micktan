# Ctrl-S Assets — where the raw material lives

Working folder for the **ctrl-s.** room. Everything here is local: `memories/`
is gitignored, so no family photo and no raw Gemini frame ever reaches GitHub.
Only `style.md` (the style law) and this file are committed.

The shipped output lives elsewhere and IS committed:
`public/room/ctrl-s/<slug>.png` (the sprite sheet) and
`public/room/ctrl-s/album/<slug>/` (the encrypted photos).

## The shape

One folder per memory. Everything about that memory lives inside it.

```
memories/
  2021-07-03-ari-turns-one/
    photos/       the family photos — these become the encrypted album
    candidates/   every frame-1 Gemini gave us, kept as a record
    frames/       the approved frames, normalised — this is what ships
    scratch/      proofs, previews, experiments, dead ends
  2021-11-28-balcony-outside/
    ...
```

## The rules

**Folder name — `YYYY-MM-DD-<slug>`.** The date is when the memory happened,
not when we made the sprite. The slug is character-for-character the `id` in
`src/data/ctrl-s-memories.mjs`. One word ties the folder, the manifest entry,
the sprite sheet and the album URL together. Date-first means the folder list
sorts in the same order the floor reads, left to right.

**`photos/` — `NN-<original filename>`.** The two-digit prefix IS the album
order, because `ctrl-s-encrypt.mjs` encrypts whatever it finds in alphabetical
order. Keep the original camera filename after it; that's the provenance, and
the capture date is sitting in its EXIF. Nothing but album photos goes in here
— the encryptor takes every image it finds, so a stray screenshot ends up in
the family album.

**`candidates/` — `c1.png`, `c2.png`, `c3.png`…** Rerolls in the order they
were generated. Never delete them: when a memory two years from now drifts off
style, the record of what we accepted and what we rejected is the only way back.
PNG, never JPEG — Gemini's share button gives `.jfif`, its download button
gives PNG, and JPEG noise fuzzes the white-background cutout.

**`frames/` — `f1.png`, `f2.png`, `f3.png`.** The approved animation frames in
loop order, exactly as Gemini gave them; `f1.png` is a copy of the winning
candidate, so this folder alone is enough to rebuild the sprite. One condition,
enforced by the processor: **every frame of a memory is the same pixel
dimensions.** Don't resize them yourself.

Scale is not your job — `ctrl-s-frames.mjs` handles it. Gemini returns whatever
size it feels like (1264×842 and 2528×1686 have both turned up) and draws the
floor tile at whatever fraction of that canvas it fancies, so image width tells
you nothing. The processor measures the **floor diamond** — the widest opaque
row of the artwork — and scales the memory so that diamond is exactly 756px,
the world tile. That's the invariant that lets every tile sit flush on the
lattice no matter how the source was framed.

756 is not arbitrary: Gemini's own output puts the diamond at roughly 750px, so
sheets store the art at 1:1 and throw nothing away. Going higher would only
save upscaled pixels. Sheets are written as 256-colour palette PNGs, which
costs about 2/255 of mean colour shift (invisible) and roughly 75% of the file
size — that discount is what pays for a full-resolution tile.

**Never resize a frame yourself, and never overwrite one in place.** The
original resolution is the one thing you cannot get back; `candidates/` is the
safety net that has already saved one frame from exactly that mistake.

**`scratch/` — anything goes.** Nothing here is load-bearing; it can all be
deleted without consequence.

**Inside a memory folder, no filename repeats the slug.** The folder already
said it. `frames/f2.png`, not `frames/ari-turns-one-f2.png`.

## The floor

Memories sit on an isometric lattice, one memory per cell, tiles edge to edge.
`src/data/ctrl-s-memories.mjs` holds a `col`/`row` per memory and derives the
world x/y — never hand-write coordinates. `col` walks the floor down-right,
`row` walks it down-left; chronology drifts left to right, so the next memory
is usually `col + 1` on the same row.

The processor prints the two values the manifest needs: `w`/`h` (the fitted
sprite) and `anchor` (where that sprite's tile centre sits inside its own
artwork). The anchor is what hangs a sprite off its cell — a memory carrying a
lot of sky, like a balloon or a balcony railing, has a lower anchor and gets
drawn higher up, while its tile still lands exactly on the lattice.

Because tiles touch, sprite bounding boxes overlap, so the room hit-tests
against the artwork's alpha channel rather than its rectangle. That's already
handled in the room page; it's why you can click a baby and not open her
neighbour's card.

### Ground plane — the one that bit us

These tiles are slabs, not flat diamonds: below the tile's horizontal diagonal
sits a side face whose thickness Gemini draws differently every time (35px on
one memory, 23px on another). Two rules follow, and breaking either makes a
memory hover above or sink below its neighbours:

- **The tile centre is the widest opaque row**, full stop. On a diamond that row
  passes through the centre. Averaging it with the sprite's lowest pixel drags
  the anchor down through the slab by half a thickness.
- **`TILE.h` is the top-face height**, not the silhouette height. Measure the
  silhouette and you bake the slab in, the lattice over-steps vertically, and
  every neighbour drifts upward.

The processor prints `tile geometry: top face W x H, slab thickness N` for each
memory. Gemini's camera wobbles a degree or two per run, so top faces vary a
little (388 and 404 so far) and `TILE.h` is their average — that keeps the seams
under ~1% of a tile. If a new memory's top face lands far from `TILE.h`, it will
visibly float; reroll the image rather than nudging coordinates, because the
coordinates aren't what's wrong.

## Adding a memory

Run `/saveari` — the skill drives the whole loop and knows these paths.
