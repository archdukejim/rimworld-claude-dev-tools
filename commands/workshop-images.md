---
description: Build "pages" of visual content and embed them in a Steam Workshop item description, beating the ~8,000-character cap.
argument-hint: "[workshop fileId]"
allowed-tools: mcp__rimagentic__capture_workshop_image, mcp__rimagentic__make_workshop_image, mcp__rimagentic__render_workshop_infographic, mcp__rimagentic__compose_workshop_page, mcp__rimagentic__list_item_icons, mcp__rimagentic__resolve_item_icon, mcp__rimagentic__list_workshop_images, mcp__rimagentic__compose_workshop_bbcode, mcp__rimagentic__swh_get_item, mcp__rimagentic__swh_update_description, mcp__rimagentic__swh_open_item
---

Embed image "pages" into a Steam Workshop description to pack far more than the ~8,000-character
text cap allows. The published-file id is `$1` (ask if not given).

**The split you must understand:** producing the PNGs and composing/updating the description are
tool calls; the **image upload is a separate step**. Host the images on **imgur** — short
`i.imgur.com/….png` URLs that render in item descriptions (Vanilla Expanded's own pages do exactly
this) and cost ~3× fewer characters than Steam's long `steamuserimages` URLs, which matters against
the ~8,000-char cap. Browsers forbid scripts from setting a file input, so uploading goes through
**Claude in Chrome** (`file_upload` on imgur.com), not the extension bridge — or the user drops the
PNGs on imgur and hands the links back.

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

**Persist the tiles.** Pass `outDir` to `compose_workshop_page` to write the numbered PNGs into the
mod's own repo (e.g. `<mod>/workshop-page/`) so they're version-controlled and re-render-able, not
just left in the ephemeral `%LOCALAPPDATA%` folder.

**Merge to beat the cap.** Every embedded image costs its URL's length against the ~8,000-char cap, so
N separate tiles cost N URLs. `merge` (on `compose_workshop_page`) or `merge_workshop_tiles` stacks the
tiles into ONE tall 800px-wide PNG — so a whole page is a single imgur URL (~42 chars) instead of N.
By default it auto-splits so each image stays under a ~700 KB performance target (`maxBytes`); pass
`chunks:N` to force N evenly-divided images, or set `maxHeight`. This is what makes the description
effectively uncapped: content lives in the merged image(s), not in counted characters.

> **imgur size limit — the real constraint is bytes, not pixels.** imgur has no documented hard
> dimension cap, but it *lossily recompresses* non-animated uploads over **1 MB (anonymous)** / **5 MB
> (with an account)**, and converts any PNG over 5 MB to JPEG — any of which blurs the crisp text. So
> upload merged pages **via an imgur account** (5 MB headroom), and keep each merged PNG under that.
> The merge tools return a `warning` when an image crosses 1 MB; if it does, split with `maxHeight`.
> (A typical page is tiny — the Haul As You Work page is ~250 KB — so this only bites very long ones.)

## 2. Upload the merged image(s) to imgur
imgur URLs are short and render in item descriptions (Vanilla Expanded does this) — prefer them over
Steam's ~3× longer `steamuserimages` URLs. **Uploading is a publishing action — confirm first.**
- **Claude in Chrome:** `navigate` to `https://imgur.com/upload`, `find` the file input, `file_upload`
  the merged PNG(s) in order, and read back each direct `i.imgur.com/….png` link.
- **Manual:** hand the merged PNG path(s) to the user; they drop them on imgur and return the links.
Record the direct links in order. (Steam-hosted upload via the item's edit page still works as a
fallback, at a higher character cost. Confirm the image renders on the live item before relying on it.)

## 3. Compose the description BBCode
- Get the current body: `swh_get_item { fileId: $1 }`.
- Lead with a short **plain-text keyword/SEO block** (a hook line + searchable terms) as `intro` — the
  merged image isn't indexable text, so this is what Steam search bites on.
- `compose_workshop_bbcode { images: [{ url, caption? }, …], intro?, existing: <current body>, mode: "append" }`
  → returns the combined BBCode. With a merged page this is usually one image URL + the keyword intro.

## 4. Update the description (confirm first)
- Updating a public description is a publish action — **show the user the composed BBCode and confirm**.
- `swh_update_description { fileId: $1, description: <bbcode> }` (requires being logged in to Steam as
  the item owner, via the bridge profile).
- Verify with `swh_get_item` that the new body took.

Report: which pages were uploaded (URLs), the final description length, and that it's live.
