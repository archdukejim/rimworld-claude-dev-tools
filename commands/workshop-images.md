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
the ~8,000-char cap. **Upload with `imgur_upload` (the API path) — never by driving the imgur
website in a browser.** The browser upload UI is drag-drop-oriented and agents reliably get lost in
it; `imgur_upload` needs only a one-time `imgur_login` and is idempotent (content-hash dedup).

## 1. Produce the page images
- **Generated infographics** (Vanilla-Expanded-style banners & feature panels), no screenshot needed:
  `render_workshop_infographic { type, title, ... }`.
  - `type: "header"` → a section ribbon (800x74): a notched-hexagon accent bar with a centred
    uppercase title — section dividers only (Overview, Features, FAQ, Credits, …), no body copy.
  - `type: "feature"` → a feature panel (800 wide, **height derived from the content — never
    fixed**): `title` (subtitle), `flavor` (ONE italic accent line — the only italic on the page),
    `body` (~40-60 words), `rows` (max 5 bullet facts, bold label + muted value), `requirements`
    (chip under the tile), `icon`/`tile` (left glyph tile). The tile and the content panel are
    centred vertically independently of each other.
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
  - `accent: "#rrggbb"` is the ONE swappable brand token (default `#c8873a`); everything else is a
    fixed neutral ramp. The accent marks structure (ribbons, tabs, bullets, glyphs, tile borders,
    the flavor line) — never body prose. Keep the same accent across a mod's images. A description
    is a header + several feature panels in order.
  - **Preview card:** `render_workshop_preview { title, subtitle?, tagline?, glyph? }` renders the
    640x360 mod-list preview and 512x512 Workshop thumbnail from one spec, on the same tokens.
  - **Whole page in one call:** `compose_workshop_page { blocks:[{type,title,...}], accent, namePrefix }`
    renders every block to numbered PNGs sharing one accent + icon setup, and returns an ordered
    manifest. Draft-first — it generates local images only, never uploads or edits the description.
  - **Icon discovery:** `list_item_icons { filter? }` shows what the library holds; `resolve_item_icon
    { ref }` reports what a single ref resolves to — use it to confirm a defName before composing.
  - **Feature-panel tile art:** each feature block's left tile is filled from `tile` — `{ glyph:"crosshair" }`
    (built-in monoline symbols: crosshair, standoff, bipod, tracks, box, broom, backpack, venn, check,
    book, wrench, bolt, gear — pick the one that literally depicts the feature) or `{ image:"<path>" }`
    (external / AI-generated art). Each tile is written as its own `<prefix>-tile-NN.png` and reused if it
    already exists — the **override gate**: drop custom/AI art at that path (or `render_tile`) and it wins;
    pass `regenerateTiles:true` to rebuild from the spec. `render_tile { glyph|image }` makes one on its own.
  - **Screenshots go inline, not in the tile:** add an `{ type:"image", source:"<png>", caption? }` block
    right after the feature it illustrates — it's framed full-width on the page background and merges in
    with everything else. Capture gameplay with `capture_workshop_image` first, then reference the file.
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
- **Primary — `imgur_upload { paths: [...] }`:** uploads via the imgur API, returns direct
  `i.imgur.com` links plus a ready-made `bbcodeImages` array for `compose_workshop_bbcode`.
  Idempotent (dedups on file content hash), so re-runs reuse existing links. Needs a one-time
  `imgur_login` (`imgur_status` tells you the auth state; `{ clientId, anonymousOnly: true }` works
  without an account).
- **Do NOT drive the imgur website in a browser to upload.** The web UI is drag-drop-oriented and
  agent-hostile; every past attempt got lost in it. If `imgur_upload` reports no credentials, run
  `imgur_login` (or ask the user for a clientId) instead of falling back to the browser.
- **Manual fallback:** hand the merged PNG path(s) to the user; they drop them on imgur and return
  the links. Resolve any user-pasted album/page link to direct image URLs with `imgur_resolve`.
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
