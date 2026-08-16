---
name: workshop-page
description: Design a Vanilla-Expanded-style Steam Workshop description for one of archdukejim's mods — ribbon section banners + feature panels with real item-icon stat grids, themed to a consistent brand accent. Draft-first: generate images locally and show them; never upload or change the live description without explicit approval. Trigger on "make my workshop page", "design the workshop description", "VE-style / Vanilla Expanded style page", "generate infographics for <mod>", or "advertise <mod> like Vanilla Expanded".
---

# Workshop page designer

Builds an image-based Steam Workshop description in the house style (dark neutral ramp,
notched-hexagon section ribbons, content-height feature panels with monoline accent glyph
tiles, one italic accent flavor line, and bullet fact rows) for a given archdukejim mod,
using the `rimworld-claude-dev-tools` MCP. Own-brand accent, not a VE clone.

Low-level tool mechanics (upload paths, BBCode, description update) live in
`C:\github\rimworld-claude-dev-tools\commands\workshop-images.md` — this skill is the
workflow around them.

## Non-negotiables
- **Draft-first.** Do Phases 1–4 only. Generate images locally, deliver them to the user,
  and **stop**. Uploading images and updating the live Steam description (Phase 5) happen
  **only after explicit approval**.
- **One brand accent per mod**, reused across every image so the page reads as one set.
  Pick/confirm the accent hex once (default `#c8873a`); do not clone VE's red. The accent
  marks structure (ribbons, subtitle tabs, bullets, glyphs, tile borders, the flavor line) —
  never body prose. If tempted to accent a paragraph for emphasis, restructure it into a row.
- **Copy voice is concrete and declarative.** No marketing adjectives ("powerful",
  "seamless", "immersive"), no exclamation marks, no second-person hype. State what the
  thing does and what it costs. Where the mod contradicts a common assumption, say so
  plainly in the body — that is the most persuasive sentence on the page. Panel titles are
  short sentence-case phrases ("Never closer than safe"); the flavor line is one short
  sentence with a turn in it; a row is a fact, not a sentence.
- **Icons are real textures.** Vanilla Core/DLC icons come from the library
  (`%LOCALAPPDATA%\RimAgentic\icons`, populated by `dump_item_icons`); the mod's OWN item
  icons resolve from its `Textures/` folder via `iconRoots`. Confirm a defName with
  `resolve_item_icon` before relying on it — never invent an icon that shows blank.
- **Copy is the mod's, not invented.** Base flavor/body text on the mod's real About.xml
  description and features; don't fabricate mechanics.

## Workflow

**Phase 1 — Gather.** Identify the mod and its Workshop fileId (ask if unknown). Read its
`About/About.xml` (name, description, `modDependencies`) and, if it's already published,
the current body via `swh_get_item { fileId }`. List the mod's own item defs/textures if
its own icons will appear.

**Phase 2 — Plan the page.** Draft an ordered block list: a `header` banner per section
(Overview / Features / Requirements / FAQ …) and a `feature` panel per point. For each
feature panel draft `title`, `flavor` (one-line quote), `body` (2–4 sentences), and any
`rows` (stat grid). Choose the accent. Show this plan to the user before rendering.

**Phase 3 — Resolve icons.** For every `rows[].icon`: `resolve_item_icon { ref }` (vanilla
by bare defName; the mod's own items with `iconRoots:["<mod folder>"]`). If a vanilla icon
is missing, populate the library first — see `commands/workshop-images.md` → `dump_item_icons`
(needs a running game with the harness). Use `list_item_icons { filter }` to find defNames.

**Phase 4 — Render (draft).** `compose_workshop_page { blocks, accent, namePrefix, iconRoots? }`
→ numbered PNGs + a manifest. Deliver the images to the user (SendUserFile) and report any
`unresolved` icon refs. **Stop here.** This is the draft.

**Phase 5 — Publish (approval-gated only).** After explicit approval: upload the PNGs in
order with **`imgur_upload`** (the API path — a publish action, confirm; run `imgur_login`
first if `imgur_status` shows no credentials; **never try to drive the imgur website in a
browser** — agents get lost in its drag-drop UI every time), `compose_workshop_bbcode`
with the returned `bbcodeImages`/URLs in order, show the final BBCode, **confirm again**,
then `swh_update_description { fileId, description }`. Verify with `swh_get_item`.

## Tools (rimworld-claude-dev-tools MCP)
- Plan/draft (safe): `swh_get_item`, `list_item_icons`, `resolve_item_icon`,
  `compose_workshop_page`, `render_workshop_infographic`, `render_workshop_preview`,
  `list_workshop_images`.
- Populate icon library (from a running game): `execute_game_tool { tool_name:"dump_item_icons" }`.
- Publish (approval-gated): `imgur_upload` (after `imgur_login`), `compose_workshop_bbcode`,
  `swh_update_description`. `imgur_resolve` turns any user-pasted imgur link into direct URLs.

## Preconditions
The MCP registered. For Phase 5, Chrome with the Steam Workshop Helper extension and logged
into Steam. For icon dumping, RimWorld running with the `archdukejim.rimagentic` harness at a
live map. If a precondition is missing, say so and stop — don't guess.

## Where to run this (central skill, per-mod target, outputs in the mod repo)
This skill and the MCP live in the **dev-tools repo**; the mods are **separate content repos**.
Don't copy the skill into each mod repo — that just drifts. The pattern:

- **Run it from a dev-tools session.** That's the one place both this skill (`.claude/skills/`)
  and the `rimworld-claude-dev-tools` MCP are guaranteed registered. (If you routinely work
  *inside* a mod repo's own session and want the skill there too, install it at **user level**
  `~/.claude/skills/workshop-page/` — but the dev-tools MCP still has to be registered in that
  session, or the tools won't exist.)
- **Point at the mod, don't move it.** Read the target mod's own `About/About.xml` for copy, and
  resolve its own item icons with `iconRoots: ["<path to that mod's folder>"]`. The vanilla/DLC
  icon library (`%LOCALAPPDATA%\RimAgentic\icons`) is **global** — populate it once with
  `dump_item_icons`; every mod's page reuses it.
- **Persist outputs into the mod's own repo.** Pass `outDir: "<mod>/workshop-page/"` to
  `compose_workshop_page` so the numbered PNGs + manifest land next to the mod they advertise,
  version-controlled and re-renderable — then commit them **in that mod's repo, on its own
  branch/PR**, never in dev-tools. The `%LOCALAPPDATA%\RimAgentic\workshop-images` copy is scratch.
