---
name: saveari
description: Add a memory of Ari to the ctrl-s. room — guides Mick through the manual Gemini loop (photos → pixel sprite → animation → world placement → encrypted album), keeping every memory consistent with the locked style law. Use when Mick says /saveari, "add a memory", "new save point", or drops photos for the ctrl-s room.
---

# /saveari — add a save point to ctrl-s.

You are running the proven production loop for the ctrl-s. room (an isometric
pixel world of Ari memories at /room/ctrl-s/). Mick generates images in his
paid Gemini app (the API has no free image tier); you do everything else.
The style law lives in `00. Ctrl-S Assets/style.md` — READ IT FIRST, never
paraphrase it from memory, never edit it during this workflow. The folder
convention lives in `00. Ctrl-S Assets/README.md` — read it too; every path
below comes from it.

## Step 0 — intake (ask Mick for these, in this order)

Ask only for what's missing; he often supplies some upfront:

1. **Photos** — "Drop the photos anywhere and tell me where." You create
   `00. Ctrl-S Assets\memories\<YYYY-MM-DD>-<slug>\photos\` once you know the
   date and slug, and move them in numbered `NN-<original name>` — the prefix
   is the album order. (Every photo in that folder joins the encrypted album,
   so nothing else goes in there; you'll pick 1–3 as generation references.)
2. **The moment** — "One or two lines: what's happening, who's in it, what made
   it worth saving." (Becomes the generation brief AND the card blurb.)
3. **Date** — "When was this? (day month year)"
4. **Album** — "Should the photos ride along in the passphrase-locked album? (default yes)"
5. **Animation** — "Should it move? If yes, what are the 2–3 tiny motions?
   (e.g. arms bounce, flame flickers, balloon drifts — small is charming, big is chaos)"

Derive yourself (offer, don't ask): a lowercase title in house style (e.g.
"ari turns one."), a slug (kebab-case), and a free cell on the lattice —
chronology drifts left→right, thematic kin share a row or column; pick a cell
adjacent to related memories and say where you're putting it.

## Step 1 — generation packet

View the photos (Read tool) and pick 1–3 references: clearest face, plus
whichever carries the scene's props/outfit. Then hand Mick a packet:

- **Attach:** the exact filenames you chose.
- **Paste:** the FULL locked prompt block from style.md's "The locked prompt
  block" section, verbatim, followed by a blank line and the scene brief
  (who/pose/props, from his description). Keep the brief concrete and visual.
- **Save as:** `<memory folder>\candidates\c1.png` (c2, c3 for rerolls) —
  **PNG, not JPEG/JFIF** (the Gemini share button sometimes gives .jfif; the
  download button gives PNG. JPEG noise fuzzes the cutout).

## Step 2 — review candidates

Read each candidate and check against the law, hard requirements:
- 100% pixel art, NO photographic elements bleeding in (the classic failure:
  real floors/limbs from the reference photos collaged into the image —
  harden the prompt with the CRITICAL identity-only clause from style.md if it happens)
- flat pure-white background edge to edge; scene isolated on its floor tile
- isometric camera, warm cream palette, likeness carried from the photos
Iterate with Mick until one is approved. Drift is rejected, charm is kept.

## Step 3 — animation packet (skip if still)

- **Attach:** the approved candidate file itself (NOT the source photos).
  Copy it to `frames\f1.png` first — the frames folder is what ships.
- **Paste:** "Edit the attached pixel art image. Keep EVERYTHING identical —
  same framing, same position, same size, same style, same colors, pure white
  background — except exactly these tiny changes: <the 2–3 motions>. Nothing
  else may move or change. This is frame 2 of a stop-motion loop."
- **Save as:** `<memory folder>\frames\f2.png` (and f3 if a 3-frame loop is
  wanted; 2 is plenty).
- Review: frames must be the same dimensions and framing; tiny wobble is the
  charm, a redraw is a reject.

## Step 4 — process frames into the world

Feed it the frames at whatever size Gemini produced — do NOT resize them first.

```
node scripts/ctrl-s-frames.mjs --slug <slug> --frame "<memory folder>/frames/f1.png" --frame "<memory folder>/frames/f2.png"
```

(One --frame for a still memory.) It cuts the white to transparency, measures
the floor diamond and scales the memory so that diamond is exactly the world
tile (756px), stitches the sheet into public/room/ctrl-s/<slug>.png as a
256-colour palette PNG, and prints the manifest values including the sprite's
`anchor`. Sanity-check the printed "tile fit" line: the resulting diamond should
land within a pixel or two of 756.

## Step 5 — manifest

Add the entry to `src/data/ctrl-s-memories.mjs` with the printed sheet/frames/
w/h/anchor, your chosen `col`/`row`, title, date (ISO), blurb (his words,
tightened, house lowercase), `album: false` for now.

Never hand-write x/y — the manifest derives them from the cell. col walks the
floor down-right, row down-left; chronology drifts left→right, so the next
memory is usually col+1 on the same row, and thematic kin share a row or a
column. Cells are forever — don't move old memories to make room; the world
grows outward.

## Step 6 — album (if photos ride along)

Mick runs this himself with the family passphrase — the SAME passphrase as
every other album, one phrase unlocks the whole room. Never write the
passphrase into any file, and don't ask him to tell you it; give him the
command with `<family passphrase>` as a placeholder:

```
node scripts/ctrl-s-encrypt.mjs --id <slug> --src "<memory folder>/photos" --pass "<family passphrase>"
```

Then flip `album: true` in the manifest.

## Step 7 — verify, then ship on his word

Dev server (preview_start "astro-dev"), then check: sprite draws and animates
on the floor; click → card shows title/date/blurb; album unlocks (ask Mick to
test the passphrase himself in the browser); Ctrl+S toast still fires.
Run `npm run build` — must pass. Show him the result. Commit + push ONLY when
he says ship (message style: `ctrl-s: <memory title> joins the floor`, with
the Claude co-author line).

## Gotchas (learned the hard way, do not relearn)

- Sheets are stored at world scale; drawImage source rect = w/h in the manifest.
  A mismatched source rect = invisible sprite.
- Scale is fitted from the floor DIAMOND, never the image width — Gemini frames
  the tile differently every time. Don't pre-resize frames; let step 4 do it.
- NEVER resize a frame in place. Resolution is the one thing you can't recover,
  and a full-res frame 2 was already lost that way once. If you must transform a
  frame, write to a new filename and keep the original.
- Tiles are SLABS. The tile centre is the widest opaque row; TILE.h is the top
  FACE height, not the silhouette (which includes the slab's side face, and its
  thickness varies per generation). Measure either through the slab and the
  memory floats off the ground plane. Check the processor's "tile geometry" line
  against TILE.h in the manifest — a big drift means reroll, not renudge.
- Tiles touch, so sprite bounding boxes overlap and the room hit-tests on the
  alpha channel. If you ever change how sprites are drawn, re-check that
  clicking one memory doesn't open its neighbour's card.
- Gemini stamps a near-invisible sparkle watermark in a corner. Its pixels sit
  around 234 and the cutout threshold is 232, so it erases itself — check the
  value before rejecting a candidate over it.
- Never preview animation with stacked transparent PNGs + CSS opacity, and
  never background-position animation — canvas loop only (that's what the room uses).
- The room page never needs touching to add a memory — manifest + sheet only.
- `00. * Assets/` is gitignored; `memories/` never gets committed (style.md and
  README.md do). The sheet in public/ and the .enc album files do.
