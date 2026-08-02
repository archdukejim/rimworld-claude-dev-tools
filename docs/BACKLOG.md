# Project Backlog

Planned MCP features — **logged, not yet built.** Newest first.

---

## Window navigation + screenshot capture → JPEG for Steam Workshop embedding
- **Status:** proposed (2026-08-02)
- **Area:** MCP (RimWorld dev tools + Steam Workshop)

**Idea.** Give Claude the ability to drive RimWorld's UI to a specific window/menu
via a **lookup table**, capture a screenshot, inspect its contents, and **save it
as a JPEG** for upload to the Steam Workshop.

Flow:
1. Open the game.
2. Navigate to a named window/menu using a **window lookup table** (name → how to
   open/reach it).
3. Take a screenshot.
4. Inspect the screenshot's contents.
5. Save it as a JPEG suitable for Workshop upload.

**Motivation — beat the 8,000-character description cap.** Steam Workshop
descriptions are limited to ~8k characters of BBCode. By rendering "pages" of
content as images and embedding them as photo links, we can pack far more
information into a description — effectively **compressing the limited text space**
and giving users richer, denser content in the item description.

**Builds on existing tools:** `pcControl`/`pc` (screen capture, UI automation),
`rimworldDev` (launch), `gameIpc` (drive in-game state), and `sharp` (image
processing / JPEG output).

**Open design points:**
- The window lookup table format (named window → open/navigate steps; ideally
  data-driven so modded windows can be added without code).
- JPEG export settings (quality/size) fit for Workshop.
- Content-page rendering (how "pages of content" are laid out before capture).

**Follow-up (separate item):** photo scaling + clean embedding in the Steam
Workshop so generated content-page images render nicely (correct dimensions, not
stretched, sensible layout in the description). Tracked below.

---

## (Follow-up) Steam Workshop image scaling + embedding polish
- **Status:** proposed (2026-08-02) — depends on the item above
- **Area:** Steam Workshop

Fine-tune photo scaling and how generated images embed in a Workshop description
so they render cleanly (right dimensions, crisp, well-placed). Split out from the
capture feature because it's a presentation concern, not a capture one.
