# the room

Mick Tan's personal site at [micktan.com](https://micktan.com). A door someone walks into to get a sense of who I am. Each thing here is an object that says something about the inhabitant.

This README is for me (and any future-me) on **how to add new rooms**. There's no CMS, no dashboard, no logging in. New rooms are files — write a file, push to GitHub, the site updates itself in about 30 seconds.

---

## Running it locally (only when I want to preview changes before pushing)

I usually don't bother — I just push and look at the live site. But if I want a local preview:

```bash
npm install      # only the first time after cloning
npm run dev      # opens http://localhost:4321
```

To stop, press `Ctrl + C` in the terminal.

---

## How to add a new room — three patterns

### Pattern A — A text post (markdown)

For thoughts, writing, anything that's mainly words.

1. Open `src/content/rooms/_example.md` and copy it.
2. Rename the copy. Whatever you name it becomes the URL slug.
   - `coffee.md` → lives at `micktan.com/room/coffee/`
   - `tuesday-afternoon.md` → lives at `micktan.com/room/tuesday-afternoon/`
   - Use lowercase, hyphens, no spaces.
3. Open the new file. Edit the frontmatter at the top:
   ```yaml
   ---
   title: A short title shown at the top of the post
   summary: An optional one-liner shown on the room index page
   date: 2026-04-29
   draft: false
   ---
   ```
   Set `draft: true` if you want to write it but not publish yet — it'll be hidden on the live site until you flip it to `false`.
4. Write below the second `---`. Markdown, plain English.
5. Commit and push:
   ```bash
   git add .
   git commit -m "new room: coffee"
   git push
   ```
6. ~30 seconds later, it's live.

### Pattern B — A fully custom interactive page

For one-off weird things — a tool, a generative piece, a takeover, anything that isn't just text.

1. Open `src/pages/room/_example/` and copy the whole folder.
2. Rename the folder. The folder name becomes the URL slug.
   - `synth/` → lives at `micktan.com/room/synth/`
3. Open `src/pages/room/synth/index.astro`. Edit it however you want:
   - Bring your own HTML, CSS, JS.
   - Drop in a Three.js scene, a generative canvas, a video takeover, ASCII art on black, whatever.
   - Each interactive room is its own world — no shared design system to fight with.
4. Commit and push:
   ```bash
   git add .
   git commit -m "new room: synth"
   git push
   ```

If a markdown post AND an interactive folder ever exist with the same slug, the interactive folder wins. (Useful: start with a markdown post, then upgrade to interactive later by creating the folder. Same URL, no link breaks.)

### Pattern C — Adding media (images, audio, video)

**External (preferred)** — paste the embed code straight into a markdown or astro file. Works for YouTube, Vimeo, Spotify, SoundCloud, etc.

```html
<iframe
  src="https://www.youtube.com/embed/VIDEO_ID"
  width="100%"
  height="400"
  frameborder="0"
  allowfullscreen
></iframe>
```

**Local files** — drop them under `public/room/<slug>/`. Reference with an absolute path:

1. Save `cover.jpg` at `public/room/coffee/cover.jpg`.
2. In `src/content/rooms/coffee.md`, write:
   ```markdown
   ![A morning cup](/room/coffee/cover.jpg)
   ```
3. Same for video: `<video src="/room/coffee/clip.mp4" controls />`
4. Same for audio: `<audio src="/room/coffee/song.mp3" controls />`

Keep big files external when possible — Vercel has free-tier limits and large local media bloats the deploy.

---

## Folder cheat sheet (so I remember what each file does)

```
src/
├── content/
│   └── rooms/             ← markdown posts go here
│       └── _example.md    ← template (underscore = ignored, leave it)
├── pages/
│   ├── index.astro        ← THE FRONT PAGE (the cursor void)
│   └── room/
│       ├── index.astro    ← /room/ — the warm index page
│       ├── [slug].astro   ← auto-renders any markdown post above
│       └── _example/      ← interactive page template (underscore = ignored)
├── layouts/
│   ├── Layout.astro       ← base HTML head, fonts, etc.
│   └── RoomDefault.astro  ← default look for plain-text posts
└── styles/
    └── global.css         ← Tailwind base import
```

Anything starting with `_` is **excluded from the live site**. Use it freely for templates, drafts, scratch work.

---

## Deploying

I never run a deploy command myself. Vercel is connected to the GitHub repo. Every `git push` triggers a build. If I want to see deploy status, I open Vercel.

If I'm paranoid about a change, I can run `npm run build` locally first — that produces the exact same output Vercel will serve. If it builds locally, it builds on Vercel.

---

## Stack

- [Astro](https://astro.build) — static site framework
- [Tailwind CSS](https://tailwindcss.com) — utility styling (used sparingly)
- TypeScript (kept minimal — only the content collection schema)
- [Vercel](https://vercel.com) — hosting
- Domain: Dynadot, DNS via Cloudflare

That's it. No CMS, no database, no analytics, no comments, no newsletter. Just files and a deploy hook.
