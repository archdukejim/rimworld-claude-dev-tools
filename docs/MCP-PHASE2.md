# MCP server (Phase 2) — implemented

Phase 1 drives the extension through *Claude in Chrome*. Phase 2 wraps the same
`window.SWH` methods as **MCP tools** so any MCP client can use them. This is
**built** — see [`../mcp/`](../mcp/) and [`../mcp/README.md`](../mcp/README.md).

## What shipped

- A standalone TypeScript MCP server under [`../mcp/server`](../mcp/server),
  laid out like rimsynapse's `Repo-MCP` (`tools/*.ts` with `swhTools` +
  `handleSwhTool`, an `index.ts` dispatcher, `config.ts`, `.mcpb` packaging).
- Registered locally via the repo-root [`../.mcp.json`](../.mcp.json), launched
  over stdio by the MCP client.
- Eight tools: `swh_get_auth`, `swh_get_context`, `swh_list_comments`,
  `swh_post_comment`, `swh_delete_comment`, `swh_get_item`,
  `swh_update_description`, `swh_update_title`.

## Transport decision — loopback, not native messaging

```
MCP client ──stdio──▶ MCP server ──HTTP on 127.0.0.1:8766──▶ extension background ──▶ window.SWH
```

rimsynapse's game IPC uses a file drop because its RimWorld C# side can read
files. A Chrome extension is sandboxed and **cannot read local files**, so the
equivalent local channel is a loopback socket:

- The server hosts a tiny `127.0.0.1` HTTP endpoint. Loopback traffic never
  leaves the machine — as local as a file, and consistent with rimsynapse's own
  HTTP/SSE mode.
- The extension background **long-polls** `GET /poll`, runs each command via the
  existing `callActiveTab(method, args)` helper, and `POST`s the result to
  `/result`. The long-poll keeps the MV3 service worker alive; a 1-minute alarm
  restarts the loop if the worker is torn down.
- The server holds no credentials; it is pure transport. Nothing works without a
  logged-in `steamcommunity.com` tab.

Native messaging was the alternative. It was not chosen because it needs an
OS-registered host manifest per machine **and** would still require a second
channel (file or socket) between the MCP-client-launched server process and the
Chrome-launched host process. The single-process loopback design avoids both.

## If you ever want native messaging instead

Add `chrome.runtime.connectNative(...)` in the background worker and route the
same `{ id, method, args }` envelopes through `callActiveTab`, plus register a
host manifest with `allowed_origins: ["chrome-extension://<EXTENSION_ID>/"]`.
The command/result envelope is identical, so only the transport changes.
