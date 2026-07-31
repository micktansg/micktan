# The Style Law — ctrl-s.

Room: **ctrl-s.** — save points you can't load.
An ever-growing isometric pixel world of Ari's memories.

STATUS: DRAFT (locks after the cutout + animation tests pass)

Winning style from the 2026-07-31 test: "Style A" — fine-grained pixel art,
delicate outlines, soft warm palette. Reference result: Ari's first birthday
sheet (Mick's Gemini run, panel A).

Every sprite generation MUST prepend this block verbatim to the memory brief.
Never edit casually — consistency across years is the entire point of this file.

---

## The locked prompt block

Fine-grained detailed isometric pixel art vignette, delicate 1px outlines,
rich soft shading, warm cream-toned palette. True isometric camera (45-degree
top-down game view). The scene sits on a small square light-wood floor tile,
isolated like a game sprite. Solid pure white background (#FFFFFF), no shadows
cast outside the tile, no other background elements, no text, no watermark,
no border.

The people must closely match the supplied reference photo(s): same face,
hair, outfit, and proportions, rendered in the pixel style above.

---

## Rules for the operator (Claude, during /add-memory)

- Always include the memory's source photo(s) as reference images in the API call.
- Also include 1-2 recently approved sprites as style anchors when available
  ("match the pixel style of these exactly; take the people from the photo").
- Generate 2-4 candidates; Mick picks. Reject any candidate that breaks the
  camera angle, palette, or tile framing — no exceptions, drift compounds.
- Animation frames are edits of the approved frame 1: "exactly the same image,
  except <tiny delta>". 2-3 frames max, stop-motion cadence.
