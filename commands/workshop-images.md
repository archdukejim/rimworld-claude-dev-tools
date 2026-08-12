---
description: Build "pages" of visual content and embed them in a Steam Workshop item description, beating the ~8,000-character cap.
argument-hint: "[workshop fileId]"
allowed-tools: mcp__rimagentic__capture_workshop_image, mcp__rimagentic__make_workshop_image, mcp__rimagentic__render_workshop_infographic, mcp__rimagentic__compose_workshop_page, mcp__rimagentic__list_item_icons, mcp__rimagentic__resolve_item_icon, mcp__rimagentic__list_workshop_images, mcp__rimagentic__compose_workshop_bbcode, mcp__rimagentic__swh_get_item, mcp__rimagentic__swh_update_description, mcp__rimagentic__swh_open_item
---

Embed image "pages" into a Steam Workshop description to pack far more than the ~8,000-character
text cap allows. The published-file id is `$1` (ask if not given).

**The split you must understand:** producing the JPEGs and composing/updating the description are
tool calls; the **upload itself is a browser action** — Steam only renders `[img]` from Steam-hosted
URLs, and browsers forbid scripts from setting a file input, so the file upload goes through **Claude
in Chrome** (`file_upload`), not an MCP tool. Do not try to upload via the extension bridge.

## 1. Produce the page images
- **Generated infographics** (Vanilla-Expanded-style banners & feature panels), no screenshot needed:
  `render_workshop_infographic { type, title, ... }`.
  - `type: "header"` → a notched ribbon section banner (800x51) from `title` — use as a divider
    (Overview, Features, FAQ, Credits, …).
  - `type: "feature"` → a feature panel (800x300): `title` (ribbon subtitle), `flavor` (italic quote),
    `body` (paragraph), `rows` (stat grid), `requirements` (chip), `icon` (left tile).
  - **Stat-grid rows with real item icons** (VE "10 skill = steel" style): a row is
    `{ k: "10 Animals skill", icon: "Things/Item/Resource/Fish" }` → renders `label = <texture>`. Each
    row takes `k` (label) plus EITHER `v` (text) or `icon` (a real texture), and `v` can follow an icon
    as a suffix.
  - **Icon resolution** (`icon` on rows and the tile): a ref may be a file path, a RimWorld texPath
    (`Things/Item/Resource/X`), or a bare name (`X`). It resolves against loose mod PNGs, mirroring
    RimWorld's texPath rules (single `X.png`, else the front variant of an `X/` folder). Search order:
    `iconRoots` (caller-supplied, e.g. your mod's project folder) → the icon library
    `%LOCALAPPDATA%/RimAgentic/icons` → the local `Mods` folder → the 294100 Workshop tree only when
    `searchWorkshop: true` (first call walks ~all subscribed mods, ~10s, then cached).
    *Vanilla Core/DLC icons are packed in Unity asset bundles, not loose files* — so populate the
    library once from a running game: launch with the harness active into a live map, then
    `execute_game_tool { tool_name: "dump_item_icons" }` (defaults to official Core/DLC
    items/weapons/apparel → `<defName>.png` in the library; pass `defNames` for a targeted set,
    `everything`/`includeMods` to widen). After that, `icon: "Steel"` resolves with no extra args.
    The render result lists `icons.resolved` / `icons.unresolved` so you can see what matched.
  - `accent: "#rrggbb"` themes every image to your brand (highlight/shadow shades are derived). Keep
    the same accent across a mod's images. A description is a header + several feature panels in order.
  - **Whole page in one call:** `compose_workshop_page { blocks:[{type,title,...}], accent, namePrefix }`
    renders every block to numbered PNGs sharing one accent + icon setup, and returns an ordered
    manifest. Draft-first — it generates local images only, never uploads or edits the description.
  - **Icon discovery:** `list_item_icons { filter? }` shows what the library holds; `resolve_item_icon
    { ref }` reports what a single ref resolves to — use it to confirm a defName before composing.
- Screenshots of the mod in action: bring RimWorld to the foreground on the content, confirm with
  `get_open_windows`, then `capture_workshop_image { name }`. Repeat per page.
- Or process existing images/rendered pages with `make_workshop_image { source, name, crop?, maxWidth? }`.
- `list_workshop_images` shows what you've produced (paths under `%LOCALAPPDATA%/RimAgentic/workshop-images`).

> **Hosting note:** Vanilla Expanded's own item descriptions embed `i.imgur.com` URLs that render fine,
> so external hosts appear to work for *item descriptions* (the Steam-hosted requirement in step 2 was
> the conservative assumption). Imgur is the simpler path — upload the PNG, use the direct `i.imgur.com`
> link in `compose_workshop_bbcode`. Confirm it renders on the live item before relying on it.

## 2. Upload each JPEG to Steam (Claude in Chrome)
Steam-hosted URLs are required. Using the `mcp__claude-in-chrome__*` tools:
- `navigate` to the Steam upload surface (the item's edit page's image section, or
  `https://steamcommunity.com/sharedfiles/managegroups` / the artwork/screenshot upload for the app —
  confirm the exact page with `read_page`).
- For each page image: `find` the file input, then `file_upload` the JPEG path, fill any required
  fields, and submit. **This is a publishing action — confirm with the user before submitting.**
- After each upload completes, read the resulting **Steam image URL** (a `steamuserimages-*` /
  `steamcdn` URL) from the page and record it in order.

If the upload UI is unavailable or blocked, hand the JPEG paths to the user to upload manually and ask
them for the resulting Steam URLs.

## 3. Compose the description BBCode
- Get the current body: `swh_get_item { fileId: $1 }`.
- `compose_workshop_bbcode { images: [{ url, caption? }, …], intro?, existing: <current body>, mode: "append" }`
  → returns the combined BBCode.

## 4. Update the description (confirm first)
- Updating a public description is a publish action — **show the user the composed BBCode and confirm**.
- `swh_update_description { fileId: $1, description: <bbcode> }` (requires being logged in to Steam as
  the item owner, via the bridge profile).
- Verify with `swh_get_item` that the new body took.

Report: which pages were uploaded (URLs), the final description length, and that it's live.
