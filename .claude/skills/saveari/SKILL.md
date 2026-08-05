---
name: saveari
description: Add a memory of Ari to the ctrl-s. room — guides Mick through the manual Gemini loop (photos → pixel sprite → animation → world placement → encrypted album), keeping every memory consistent with the locked style law. Use when Mick says /saveari, "add a memory", "new save point", or drops photos for the ctrl-s room.
---

# /saveari — add a save point to ctrl-s.

You are running the proven production loop for the ctrl-s. room (an isometric
pixel world of Ari memories at /room/ctrl-s/). Mick generates images in his paid
Gemini app (the API has no free image tier); you do everything else.

Read these two first, every time, and never paraphrase them from memory:
- `00. Ctrl-S Assets/style.md` — the style law. Never edit it during this workflow.
- `00. Ctrl-S Assets/README.md` — the folder convention and the floor geometry.
  Every path and number below comes from it.

## Step 0 — intake

Ask only for what's missing, and derive everything you can rather than asking:

1. **Photos** — "Drop the photos anywhere and tell me where." You create
   `00. Ctrl-S Assets\memories\<YYYY-MM-DD>-<slug>\photos\` and move them in as
   `NN-<original name>`; the prefix IS the album order. Nothing but album photos
   goes in that folder — the encryptor takes every image it finds.
2. **The moment** — "One or two lines: what's happening, who's in it, what made
   it worth saving." Becomes the generation brief AND the card blurb.
3. **Date** — don't just ask. `ls -l` the photos first: the camera timestamps are
   usually the answer, and they outrank memory. Sanity-check against Ari's age in
   the shots (born ~3 Jul 2020) and raise the discrepancy before building
   anything — a stated date has already been wrong by five years.
4. **Album** — don't ask. Every photo he supplies goes into the passphrase-locked
   album; the only exception is one supplied purely as art direction for the
   generation (a style reference, or an old shot included so Gemini can see an
   outfit), which stays out. Ask only if it's genuinely unclear which a photo is.
   **Settle it before the first push** either way: the repo is PUBLIC and pushed
   ciphertext is permanent, so pulling a photo later removes it from the site but
   not from git history. A photo he wants kept but not shown goes in
   `photos-omitted/`, not `photos/`.
5. **Animation** — "Should it move? If yes, what are the 2–3 tiny motions?"
   (arms bounce, flame flickers, balloon drifts — small is charming, big is chaos.)

Derive and offer, don't ask: a lowercase title in house style ("ari turns one."),
a kebab-case slug, and a free lattice cell (see step 5).

## Step 1 — design the scene, then the packet

**The sprite is the memory, not a symbol.** If Mick proposes an icon — a floating
virus, a logo, an object on its own — say so and fold his idea into the
*animation* instead, keeping the scene as the sprite. That is how the covid
memory worked: the balcony scene became the tile, the virus became the thing that
spins above it. A tile with no people in it is the one entry that isn't a memory.

Read the photos (Read tool) and pick 1–3 references: clearest face, plus whichever
carries the scene's props and outfit. Then hand him a packet:

- **Attach:** the exact filenames you chose.
- **Paste:** the FULL locked prompt block from style.md, verbatim, then a blank
  line, then the scene brief. Write the brief concrete and visual — name the
  clothes, the props, their positions, the colours.
- **Save as:** `<memory folder>\candidates\c1.png` (c2, c3 for rerolls) —
  **PNG, not JPEG/JFIF.** The Gemini share button gives .jfif; the download
  button gives PNG, and JPEG noise fuzzes the cutout.

## Step 2 — review candidates

Read each candidate against the law. Hard requirements:
- 100% pixel art, NO photographic elements bleeding in (the classic failure: real
  floors or limbs collaged in from the reference photos — if it happens, harden
  the prompt with the CRITICAL identity-only clause from style.md)
- flat pure-white background edge to edge; scene isolated on its floor tile
- isometric camera, warm cream palette, likeness carried from the photos

Drift is rejected, charm is kept. Never delete a rejected candidate — the record
of what was accepted and refused is how the style holds across years, and the
full-resolution original in `candidates/` has already been the only surviving
copy of a frame once.

## Step 3 — animation packet (skip if still)

- **Attach:** the approved candidate itself, NOT the source photos. Copy it to
  `frames\f1.png` first — `frames/` is what ships.
- **Paste:** "Edit the attached pixel art image. Keep EVERYTHING identical — same
  framing, same position, same size, same style, same colors, pure white
  background — except exactly these tiny changes: <the 2–3 motions>. Nothing else
  may move or change. This is frame 2 of a stop-motion loop."
- **Save as:** `<memory folder>\frames\f2.png` (f3 if a 3-frame loop is wanted;
  2 is plenty). Frames must share exact dimensions — the processor enforces it.

**Judge wobble vs redraw with numbers, not vibes.** Pixel-diff frame 1 against
frame 2 and look at where the change lands, not just how much:

```
node -e "import('sharp').then(async({default:s})=>{const a=await s('<f1>').removeAlpha().raw().toBuffer(),b=await s('<f2>').removeAlpha().raw().toBuffer();let c=0,st=0,n=0;for(let i=0;i<a.length;i+=3){n++;const d=Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2]);if(d>30)c++;if(d>120)st++;}console.log('changed '+(100*c/n).toFixed(2)+'%, strongly '+(100*st/n).toFixed(2)+'%')})"
```

Benchmark from the accepted covid frame: **9.8% changed, 3.4% strongly** — the
strong changes sitting exactly on the intended motions, everything else a 1px
edge jitter. That jitter is the hand-made "boiling line" and it is desirable.
Faces and composition must be untouched; if they moved, it's a redraw — reject.

## Step 4 — process frames into the world

Feed the frames at whatever size Gemini produced. Do NOT resize them first.

```
node scripts/ctrl-s-frames.mjs --slug <slug> --frame "<memory folder>/frames/f1.png" --frame "<memory folder>/frames/f2.png"
```

(One `--frame` for a still memory.) It cuts the white to transparency, measures
the floor diamond, scales the memory so that diamond is exactly the world tile
(756px), stitches a 256-colour palette PNG into public/room/ctrl-s/<slug>.png,
and prints the manifest values including `anchor`.

Check both printed lines before moving on:
- `tile fit` — the resulting diamond should land within a pixel or two of 756.
- `tile geometry` — the top-face height should sit near `TILE.h` in the manifest
  (388 and 404 so far). A big drift means this memory will visibly float; the fix
  is a reroll, not a coordinate nudge.

## Step 5 — manifest

Add the entry to `src/data/ctrl-s-memories.mjs`: the printed sheet/frames/w/h/
anchor, your chosen `col`/`row`, title, date (ISO), blurb (his words, tightened,
house lowercase), `album: false` for now.

**Never hand-write x/y** — the manifest derives them from the cell and sorts
back-to-front for isometric depth. `col` walks the floor down-right, `row` walks
it down-left, so up-right (the usual next spot) is `row - 1`. Chronology drifts
left→right; thematic kin share a row or column. Cells are forever — the world
grows outward, old memories never move.

## Step 6 — album (if photos ride along)

The family passphrase is in memory ([[ctrl-s-album-passphrase]]) — one phrase
unlocks every album in the room, so every run must use the same one. **Never
write it into any project file**, and keep the `<family passphrase>` placeholder
in anything you show in chat.

**Verify it against an existing album before encrypting a new one.** If it were
misremembered you'd silently create an album nobody can open alongside ones that
work. Decrypt an existing album's files in node and confirm they come back as
valid JPEGs (they start `FF D8`) before proceeding.

```
node scripts/ctrl-s-encrypt.mjs --id <slug> --src "<memory folder>/photos" --pass "<family passphrase>"
```

Then flip `album: true` in the manifest.

**Re-encrypting an existing album** (a photo added or pulled): delete the whole
output folder's contents first. The script writes `1.enc … N.enc` and will happily
leave a stranded `4.enc` behind when the count shrinks. Re-encryption also mints a
new salt, so every file must be regenerated together — never partially.

## Step 7 — verify

Dev server (`preview_start "astro-dev"`), then check all of it:

- sprite draws on the floor at the right scale, flush against its neighbours
- it animates — sample the canvas repeatedly and confirm it settles into exactly
  `frames` distinct states (transients during camera easing are normal)
- click the new sprite → its own card, with title/date/blurb
- click a NEIGHBOUR's artwork → the neighbour's card, not this one (tiles touch,
  so bounding boxes overlap; this is the regression that hides)
- album: wrong passphrase rejected with no photos leaked, right passphrase loads
  exactly N photos with `naturalWidth > 0`
- Ctrl+S toast still fires
- `npm run build` passes, browser console clean

**Drive it with real clicks.** Synthetic events do not work here: `pointerdown`
calls `setPointerCapture`, which throws on a pointerId the browser doesn't know,
aborting the handler before the tap registers — so a dispatched PointerEvent can
never open a card. Take a `computer` screenshot, then click by coordinate.

**If the album fails to unlock in dev, suspect the dev server before the crypto.**
It negative-caches files deleted during re-encryption and will 404 one of them
forever; the app reports that as a wrong passphrase. Curl each `.enc` directly,
and restart the preview server to clear it. Confirm the files exist in the build
output before believing production is affected.

## Step 8 — ship on his word

Commit + push ONLY when he says ship. Message style:
`ctrl-s: <memory title> joins the floor`, with the Claude co-author line.

Before committing, check the diff for leaks: `memories/` must be absent (it's
gitignored), and grep the tree for the passphrase — it legitimately lives in
`.claude/settings.local.json` from approved commands, which is untracked, but
confirm that rather than assuming.

## Gotchas (learned the hard way, do not relearn)

- Sheets are stored at world scale; drawImage source rect = w/h in the manifest.
  A mismatched source rect = invisible sprite.
- Scale is fitted from the floor DIAMOND, never the image width — Gemini frames
  the tile differently every run, which once left one tile 1.33× its neighbour.
- NEVER resize a frame in place. Resolution is the one thing you can't recover,
  and a full-res frame 2 was destroyed exactly that way. Write to a new filename.
- Tiles are SLABS. The tile centre is the widest opaque row; `TILE.h` is the top
  FACE height, not the silhouette (which includes the side face, whose thickness
  varies per generation). Measure through the slab and the memory floats.
- Tiles touch, so bounding boxes overlap and the room hit-tests the alpha channel.
  If you change how sprites are drawn, re-check neighbour clicks.
- Gemini stamps a near-invisible sparkle watermark in a corner. Its pixels sit
  around 234 against a 232 cutout threshold, so it erases itself — check the value
  before rejecting a candidate over it.
- GLOW IS THE CUTOUT'S ENEMY, but near-white is not. The fill is a connectivity
  flood from the border through pixels where all three channels are >=232, so
  anything sealed inside a 1px outline survives even at rgb(255,255,254) — 32k
  such pixels came through on the balcony sheet. What dies is a soft, unoutlined
  glow: it gets eaten inward to wherever it first drops below threshold, leaving
  a clipped halo, and at worst gives the fill a channel to tunnel into the scene.
  So any luminous subject (a fairy, a flame, a lamp) needs a rendering clause in
  the brief: light drawn as discrete outlined pixel shapes — four-point sparkles,
  dots, stars — never blur, bloom, gradients or feathered edges.
- Never preview animation with stacked transparent PNGs + CSS opacity, and never
  background-position animation — canvas loop only.
- The room page never needs touching to add a memory — manifest + sheet only.
- `00. * Assets/` is gitignored; `memories/` never gets committed (style.md and
  README.md do). The sheet in public/ and the .enc album files do.
- The repo is PUBLIC and history is permanent. Encrypted is not deleted.
