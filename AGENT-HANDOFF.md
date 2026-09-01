# AGENT-HANDOFF — `agent/e2a85d71`

## What this branch adds

**The infographic pipeline** — author a themed HTML infographic → render it to a crisp PNG headlessly →
publish it to the mod's destinations (edition GitHub repos + Steam Workshop descriptions), as a
documented, tested tool family. Full docs + gotchas: **`docs/INFOGRAPHICS.md`** (read it before touching
the renderer — every flag encodes a hard-won lesson).

- **NEW `server/src/tools/infographic.ts`** — tool family `infographic`:
  - `render_html_to_image { html_path|html_string|url, width, scale, theme, virtualTimeMs, padding,
    maxHeight, background, out_path }` → PNG + dimensions. Headless Chrome/Edge (auto-detected, no
    puppeteer): HTML served over loopback HTTP with `charset=utf-8` (mojibake fix), doctype injected
    (quirks mode breaks measurement), `--virtual-time-budget` (JS-built DOM + Google Fonts),
    forced `data-theme`, `--force-device-scale-factor`, and a measure-then-shoot two-pass for a tight
    content-height crop (viewport-floor-aware — see docs).
  - `compose_infographic` — data → themed HTML in the house design system. Templates: `roadmap`
    (milestone/mechanic cards — fat entries with body + bullets), `timeline` (compact feature timeline —
    one line per entry + era headings), `card-grid`, `stat-sheet`.
  - `publish_infographic { image, name, section_title, section_body?, editions, targets, dryRun, push,
    steamMode, port }` — per edition: GitHub (PNG → `About/<name>.png`, marker-fenced README section
    upsert, commit+push, idempotent) and Steam (one `imgur_upload`, `compose_workshop_bbcode`, then a
    LIVE description update: the `[h1]` section is upserted in place via the CDP ItemEditText re-POST in
    the logged-in RimAgentic Chrome — the extension's proven flow without the bridge; falls back to a
    paste-ready handoff file under `%LOCALAPPDATA%\RimAgentic\infographics\handoff\`). Editions resolve
    from `mcp-config/config.json` `"editions"` (mmf/rp2 configured) or literal repo paths; workshop ids
    from `About/PublishedFileId.txt`.
- **NEW `server/src/tools/cdp.ts`** — shared minimal CDP client (`CdpPage`, `openTab`, `closeTab`),
  extracted from `imgur.ts` (which now imports it; behavior unchanged, `test:imgur` 27/27).
- **CHANGED** `server/src/index.ts` (family wired into all four places incl. SSE), `server/src/config.ts`
  (`editions` map), `mcp-config/config.json` (mmf/rp2 paths), `manifest.json` (+3 tools), `CLAUDE.md`
  (family list), `server/package.json` (`test:infographic`).
- **NEW `server/test/infographic.test.js`** — 39 assertions: render fixture (UTF-8 canary, JS-built DOM,
  Google Font, theme forcing asserted by pixel brightness, tight-height incl. the short-page
  viewport-floor regression), template composition/escaping, publish against temp git repos + bare
  remotes (dry-run stages only, real run commits+pushes, re-run no-op, section refresh in place,
  unrelated README content untouched, steam dry-run handoff BBCode). Skips render asserts politely
  when no Chrome/Edge.

## Verified

- `npm run test:infographic` → 39/39; `npm run test:imgur` → 27/27 after the CDP extraction; `tsc` clean.
- Real-world render proof: the finished `faction-codex.html` example renders pixel-perfect
  (2400×4234 @2x, dark forced, fonts + `→` glyphs intact, tight crop).

## NOT verified (needs live services)

- The live CDP Steam description update against a real item (needs launch_chrome + Steam owner
  session) and a real imgur upload. Both paths degrade to warnings + handoff files on failure — first
  real `publish_infographic` run should be watched.
