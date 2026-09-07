# Infographic pipeline

Author a themed HTML infographic → render it to a crisp PNG headlessly → publish it to the
mod's destinations (edition GitHub repos + Steam Workshop descriptions). One tool family
(`server/src/tools/infographic.ts`), three tools:

| Tool | What it does |
| --- | --- |
| `render_html_to_image` | HTML (file / string / URL) → high-res PNG via headless Chrome/Edge |
| `compose_infographic` | Structured data → themed, render-ready HTML (timeline / card-grid / stat-sheet) |
| `publish_infographic` | Fan a PNG out to every edition: GitHub commit+push, imgur + live Steam description upsert |

The canonical flow:

```
compose_infographic (or hand-authored artifact HTML)
  → render_html_to_image { html_path, theme:"dark", width:1200 }
  → publish_infographic { image, name, section_title, editions:["mmf","rp2"] }
```

Tests: `cd server && npm run build && npm run test:infographic` (uses temp git repos + a temp
LOCALAPPDATA; skips render assertions if no Chrome/Edge; never touches imgur or Steam).

## render_html_to_image — how it works, and the gotchas it encodes

Each of these was learned the hard way. **Do not "simplify" them away.**

1. **The HTML is served over loopback HTTP with `Content-Type: text/html; charset=utf-8`**,
   never handed to Chrome as a `file://` path. Without the charset, Chrome guesses the encoding
   and `→ ✓ · ○ ◐` become mojibake (`â†' âœ" Â·`). This is the #1 gotcha. A `<meta charset>` is
   also injected when the source has none (belt and braces).
2. **`--virtual-time-budget=<ms>`** (default 4000, `virtualTimeMs`) makes Chrome fast-forward
   through async work before capturing. Artifact-style pages often build their DOM in a
   `<script>` and Google Fonts arrive async — without this you screenshot a blank/unstyled page.
   Virtual time suspends while network fetches are in flight, so fonts do land. Raise it for
   heavy JS. `--run-all-compositor-stages-before-draw` rides along so the frame is fully drawn.
3. **Theme is forced, never inherited from the OS.** The house HTML is theme-aware (bare
   `:root` = light; `[data-theme="dark"]` + `prefers-color-scheme` media = dark), so the tool
   injects `document.documentElement.setAttribute('data-theme', theme)` at the top of the
   document. `theme: "dark"` is the default; `"none"` leaves the page's own behavior.
4. **Height is measured, not guessed.** Pass 1 runs `--dump-dom` with an injected script that
   keeps writing the content height into a `data-rs-h` attribute; pass 2 screenshots with
   `--window-size=<width>,<measured>` so the PNG is cropped tight with no dead bottom margin.
   `padding` adds slack; an explicit `height` skips the measurement pass. Two traps encoded in
   the measurement: (a) a missing `<!doctype html>` puts the page in **quirks mode**, where the
   body stretches to the viewport and `scrollHeight` lies — the tool always injects the doctype
   (artifact-style pages usually omit it); (b) `scrollHeight` floors at the viewport height, and
   headless new's viewport is ~95px shorter than `--window-size` (window chrome), so content
   shorter than the measure viewport is sized from the body's actual bottom edge instead. (The
   screenshot pass itself captures the full `--window-size` surface — only measurement is
   affected.)
5. **`--force-device-scale-factor=2`** (default, `scale`) renders at 2× — output pixels are
   `width × scale`. Chrome's capture surface tops out around 16k physical pixels, so the CSS
   height is capped at `~16000 / scale` (clipped with a warning; lower `scale` or split the page).
6. `--hide-scrollbars --disable-gpu --force-color-profile=srgb` for clean, deterministic
   output; `background` maps to `--default-background-color` (`"transparent"` works). Every run
   uses a throwaway `--user-data-dir` (parallel-safe, cleaned up afterwards).
7. **Browser discovery**: Chrome in Program Files / Program Files (x86) / LocalAppData, then
   Edge (every Windows box has it and renders identically here). Override with `chromePath` or
   the `RIMAGENTIC_CHROME` env var. No puppeteer/playwright — a raw `--headless=new` invocation
   plus a ~10-line HTTP server is the whole dependency footprint.
8. **URL input** is fetched server-side and re-served locally (with an injected `<base>` so
   relative resources keep resolving) — that's what lets theme forcing and height measurement
   work on remote pages too.

Default output: `%LOCALAPPDATA%\RimAgentic\infographics\<name>.png`.

## compose_infographic — data → themed HTML

Templates emit the house design system (cool-steel neutrals + brass accent, Chakra Petch
display + IBM Plex Sans/Mono via Google Fonts, light+dark CSS tokens) so generated pages match
hand-authored artifact HTML and drop straight into the renderer:

- **`roadmap`** (alias `milestones`) — milestone/mechanic CARDS on a vertical rail; items
  `{ label?, title, status?: done|active|planned, body?, bullets? }` with shipped/in-progress
  chips. Reach for this when each entry needs explaining (complex mechanics per milestone).
- **`timeline`** (alias `feature-timeline`) — the compact FEATURE timeline: one slim line per
  entry (`{ label? (version/date), title, status?, desc? }`) plus `{ heading: "2026" }`
  era-divider entries, so a long feature history fits one image. Roadmap = few fat entries;
  timeline = many thin ones.
- **`card-grid`** (alias `matrix`) — `cards: [{ title, badge?, body?, rows: [{k,v}] }]`,
  `columns` 1–4.
- **`stat-sheet`** — `groups: [{ title, stats: [{ k, v, note? }] }]` as labelled panels.

Common fields: `title`, `eyebrow` (mono kicker), `subtitle`, `footer`. All user data is
HTML-escaped. For anything beyond the templates, hand-author the HTML in the same token style
(the artifact-design system) — the renderer doesn't care where the HTML came from.

## publish_infographic — one call, every destination

The mod ships as multiple **editions** sharing content (Core-MMF, Core-RP2). Editions resolve
from the `"editions"` map in `mcp-config/config.json` (key → local repo path) or from literal
repo paths passed in `editions`; each repo's Steam id is read from `About/PublishedFileId.txt`
— nothing is hardcoded.

```jsonc
// mcp-config/config.json
"editions": {
  "mmf": "C:\\github\\regions-and-societies\\Core-MMF",
  "rp2": "C:\\github\\regions-and-societies\\Core-RP2"
}
```

**GitHub target** (per edition): copies the PNG to `About/<name>.png`, upserts a
marker-fenced README section
(`<!-- infographic:<name> --> … <!-- /infographic:<name> -->`), commits and pushes.
Idempotent: re-runs update the image + section in place (content-hash compare → `up-to-date`
when nothing changed) and **never touch content outside the markers**. Keep `name` stable
across republishes — it keys both the file path and the markers. Warns when the checked-out
branch isn't `main`.

**Steam target**: uploads the PNG **once** via `imgur_upload` (content-hash dedup — republishing
an unchanged image reuses the existing link), composes the `[img]` block via
`compose_workshop_bbcode`, then **pushes it into each item's live description**: the
`[h1]<section_title>[/h1]` section is inserted/refreshed in place (matched from its heading to
the next `[h1]` or the end), so republishing never duplicates the section. The image lives in
the description body — it is NOT a separate uploaded screenshot.

The live update is the **CDP ItemEditText workaround** (the swh extension bridge is not
required): it opens `steamcommunity.com/sharedfiles/itemedittext/?id=<id>` in the logged-in
RimAgentic Chrome and runs in-page JS that clones the real edit form, overrides `description`,
and re-POSTs with the session id — the same proven flow the extension used, minus the bridge.
Prerequisites: `launch_chrome`, and that profile signed into Steam **as the item owner** (Steam
only serves the edit page to the owner). After the POST it re-reads the form and verifies the
new `[img]` block is present. When the live path is unavailable (Chrome down, signed out, no
workshop id) it degrades to a **paste-ready handoff file** per item under
`%LOCALAPPDATA%\RimAgentic\infographics\handoff\`, with the item + edit URLs and the exact
BBCode; `steamMode: "handoff"` forces that mode.

**`dryRun: true`** stages everything without side effects: planned README sections (with
markers), composed BBCode, handoff files with a placeholder URL — no copy, no commit, no
upload, no Steam traffic. Use it to review before publishing. `push: false` commits without
pushing. `targets` limits to `["github"]` or `["steam"]`.

Also warns when a description approaches Steam's ~8,000-character cap.

## Gotcha quick-list (for future you)

- Mojibake arrows in the PNG → something bypassed the loopback server / charset header.
- Blank or unstyled PNG → virtual-time budget too low, or the page's JS threw before `load`
  (the height measurement will also fail and say so; pass `height` to bypass).
- PNG has the wrong theme → the page defines tokens only in the media query; forcing needs the
  `[data-theme="dark"]` block too (author pages with both, like the templates do).
- Giant blank bottom margin → you passed a fixed `height`; drop it and let measurement run.
- Steam update says "no edit form" → the RimAgentic Chrome isn't signed in as the owner.
- Duplicate sections in a description → the `[h1]` heading text changed between publishes;
  keep `section_title` stable (it is the section's identity, like `name` is for the README).
