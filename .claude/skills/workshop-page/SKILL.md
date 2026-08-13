---
name: workshop-page
description: Design a Vanilla-Expanded-style Steam Workshop description for one of archdukejim's mods — ribbon section banners + feature panels with real item-icon stat grids, themed to a consistent brand accent. Draft-first: generate images locally and show them; never upload or change the live description without explicit approval. Trigger on "make my workshop page", "design the workshop description", "VE-style / Vanilla Expanded style page", "generate infographics for <mod>", or "advertise <mod> like Vanilla Expanded".
---

# Workshop page designer

Builds an image-based Steam Workshop description in the Vanilla Expanded house style
(dark contour background, notched ribbon banners, gray feature panels with italic flavor
quotes and item-icon stat grids) for a given archdukejim mod, using the
`rimworld-claude-dev-tools` MCP. Own-brand accent, not a VE clone.

Low-level tool mechanics (upload paths, BBCode, description update) live in
`C:\github\rimworld-claude-dev-tools\commands\workshop-images.md` — this skill is the
workflow around them.

## Non-negotiables
- **Draft-first.** Do Phases 1–4 only. Generate images locally, deliver them to the user,
  and **stop**. Uploading images and updating the live Steam description (Phase 5) happen
  **only after explicit approval**.
- **One brand accent per mod**, reused across every image so the page reads as one set.
  Pick/confirm the accent hex once (default `#b9622b`); do not clone VE's red.
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
order (imgur or Steam via Claude in Chrome — a publish action, confirm), `compose_workshop_bbcode`
with the resulting URLs in order, show the final BBCode, **confirm again**, then
`swh_update_description { fileId, description }`. Verify with `swh_get_item`.

## Tools (rimworld-claude-dev-tools MCP)
- Plan/draft (safe): `swh_get_item`, `list_item_icons`, `resolve_item_icon`,
  `compose_workshop_page`, `render_workshop_infographic`, `list_workshop_images`.
- Populate icon library (from a running game): `execute_game_tool { tool_name:"dump_item_icons" }`.
- Publish (approval-gated): image upload via Claude in Chrome, `compose_workshop_bbcode`,
  `swh_update_description`.

## Preconditions
The MCP registered. For Phase 5, Chrome with the Steam Workshop Helper extension and logged
into Steam. For icon dumping, RimWorld running with the `archdukejim.rimagentic` harness at a
live map. If a precondition is missing, say so and stop — don't guess.
