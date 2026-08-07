---
description: Build "pages" of visual content and embed them in a Steam Workshop item description, beating the ~8,000-character cap.
argument-hint: "[workshop fileId]"
allowed-tools: mcp__rimagentic__capture_workshop_image, mcp__rimagentic__make_workshop_image, mcp__rimagentic__list_workshop_images, mcp__rimagentic__compose_workshop_bbcode, mcp__rimagentic__swh_get_item, mcp__rimagentic__swh_update_description, mcp__rimagentic__swh_open_item
---

Embed image "pages" into a Steam Workshop description to pack far more than the ~8,000-character
text cap allows. The published-file id is `$1` (ask if not given).

**The split you must understand:** producing the JPEGs and composing/updating the description are
tool calls; the **upload itself is a browser action** — Steam only renders `[img]` from Steam-hosted
URLs, and browsers forbid scripts from setting a file input, so the file upload goes through **Claude
in Chrome** (`file_upload`), not an MCP tool. Do not try to upload via the extension bridge.

## 1. Produce the page images
- Screenshots of the mod in action: bring RimWorld to the foreground on the content, confirm with
  `get_open_windows`, then `capture_workshop_image { name }`. Repeat per page.
- Or process existing images/rendered pages with `make_workshop_image { source, name, crop?, maxWidth? }`.
- `list_workshop_images` shows what you've produced (paths under `%LOCALAPPDATA%/RimAgentic/workshop-images`).

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
