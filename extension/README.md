# Steam Workshop Helper

A Chrome (MV3) extension that exposes a small, reliable **API for managing your
Steam Workshop items** — listing/posting/deleting comments and updating item
titles and descriptions — so an automation client can drive it like a set of
MCP tools.

It's built to be driven by **Claude** (via the *Claude in Chrome* browser tools)
today, and is structured so a real **MCP server** can be layered on later
without rewriting the core (see [Phase 2](docs/MCP-PHASE2.md)).

> You must be logged into Steam in the browser as the item **owner** for edit
> and delete actions. Reading comments works for any account.

---

## How it works

The extension injects `window.SWH` into `steamcommunity.com` pages **in the page
context** (MAIN world). Because it runs same-origin, its calls to Steam's
comment and edit endpoints carry your session automatically — no API key, no
scraping fragility for the parts that matter.

- **Comments** use Steam's native AJAX endpoints
  (`/comment/PublishedFile_Public/{render|post|delete}/…`).
- **Title / description** are edited by **cloning the item's real edit form**
  and re-submitting it, so every hidden field and session token Steam requires
  comes along for the ride.
- **Owner / app IDs** are resolved automatically from a workshop `fileId`
  (falling back to the creator profile's `?xml=1` lookup when needed), so you
  usually only need the workshop ID.

```
Claude (Claude in Chrome)  ──javascript_tool──▶  window.SWH  ──fetch──▶  Steam
                                                    ▲
MCP client ─stdio▶ MCP server ─127.0.0.1▶ background ─bridge─┘
                   (mcp/, all local)      (long-poll)
```

Two ways to drive it:

- **Claude in Chrome** — call `window.SWH.*` directly in the tab (no server). See
  [docs/CLAUDE-USAGE.md](docs/CLAUDE-USAGE.md).
- **Local MCP server** — the [`mcp/`](mcp/) folder is a standalone MCP server
  (modeled on rimsynapse's Repo-MCP) that exposes the same operations as MCP
  tools over a `127.0.0.1` loopback bridge, so any MCP client can use it. See
  [mcp/README.md](mcp/README.md).

> **One profile serves the bridge.** The loopback bridge is a single port
> (`127.0.0.1:8766`); if the extension is installed in more than one Chrome
> profile, each one polls it and they race for commands. The popup has a
> **"Serve the MCP bridge from this profile"** toggle (stored per profile) —
> leave it **on** in your dedicated/automation profile and turn it **off** in
> your everyday browser so exactly one profile answers MCP calls.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder
   (`steam-workshop-helper`).
4. Open any workshop item, e.g.
   `https://steamcommunity.com/sharedfiles/filedetails/?id=3775176411`.
5. Click the extension icon — the popup should detect the item.

## Quick start (driving it from Claude)

With a workshop page open, Claude runs JavaScript in the tab:

```js
await window.SWH.getContext();
// → { fileId, appId, ownerSteamId, title, ... }

await window.SWH.listComments({ fileId: "3775176411" });
await window.SWH.postComment({ fileId: "3775176411", text: "Fixed in v1.1 — thanks!" });
await window.SWH.updateDescription({ fileId: "3775176411", description: "[b]v1.1[/b]\nChangelog…" });
```

See **[docs/CLAUDE-USAGE.md](docs/CLAUDE-USAGE.md)** for the full agent workflow
and **[docs/API.md](docs/API.md)** for the complete method reference.

## Your workshop items

| Mod | File ID |
| --- | --- |
| Dynamic Walk Speeds | `3775191933` |
| Performance Custom Maps | `3775179446` |
| Room Auto Light | `3775176411` |

App ID for RimWorld is `294100` (resolved automatically).

## Files

| Path | Role |
| --- | --- |
| `manifest.json` | MV3 manifest |
| `src/swh-api.js` | Core `window.SWH` API (MAIN world) |
| `src/bridge.js` | Relay: `chrome.runtime` ⇄ page `window.SWH` (isolated world) |
| `src/background.js` | Service worker; routes popup/MCP calls to the right tab |
| `src/popup.*` | Toolbar popup (detect item, list comments, copy snippet) |
| `docs/` | API reference, agent usage, Phase-2 MCP plan |

## Safety

The extension only ever acts on **your** Steam session in **your** browser, and
only on `steamcommunity.com`. Deletes and edits are irreversible on Steam's
side — treat `deleteComment` and `updateDescription`/`updateTitle` as
destructive and confirm before running them in bulk.

## License

MIT © archdukejim
