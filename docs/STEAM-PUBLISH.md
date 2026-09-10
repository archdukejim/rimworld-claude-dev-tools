# Steam Workshop publish path

How the `swh_*` tools reach Steam, what they guard against, and the page anatomy they rely on.
This is the reference behind the `ship-it` skill's PUBLISH half (Steps 7, 8, 9, 9b).

## Routes

Both routes use the **RimAgentic Chrome** — the dedicated profile `launch_chrome` starts with
`--remote-debugging-port=9222` (`%LOCALAPPDATA%\RimAgentic\chrome-profile`). Sign into Steam
there once; the session persists.

| Route | How | Tools |
|---|---|---|
| **Extension bridge** | The bundled extension's service worker long-polls `http://127.0.0.1:8766/poll` and runs `window.SWH.*` in a steamcommunity.com tab (`extension/src/swh-api.js`). | every `swh_*` tool |
| **DevTools** | `server/src/steamCdp.ts`: `PUT /json/new`, a websocket doing `Page.enable` / `Runtime.enable` / `Page.loadEventFired` / `Runtime.evaluate`. Zero dependencies (Node ≥ 22 global `WebSocket`). | `swh_get_auth`, `swh_get_item`, `swh_open_item`, `swh_update_description`, `swh_get_moderation_state`, `swh_post_changelog` |

`workshop.ts` picks the route per call: bridge if `bridge.status().connected`, else DevTools
when `/json/version` answers on the port; a bridge call that fails mid-way also falls back and
reports `bridgeError`. If neither is available the error names `launch_chrome`.

### Why the bridge was "never connected"

Every Claude session runs its own `node server/build/index.js`, and all of them try to bind
8766. Only the first succeeds; the others used to fail with `EADDRINUSE`, keep `bridge = null`,
and answer every `swh_*` call with "Steam loopback bridge not started yet" — while the
extension was in fact connected to the sibling process. `bridge.ts` now returns one of three
bridges and `chrome_status.bridge` reports it honestly:

| `mode` | Meaning |
|---|---|
| `owner` | this process bound 8766; `connected` = the extension polled it within the last ~30 s |
| `proxy` | a sibling owns the port; `call()` is forwarded to its `POST /call`, status mirrors its `/health` (incl. `pid`) |
| `unavailable` | the port is held by something that is not a RimAgentic bridge; `note` says what answered |

A sibling on an **older build** (no `/call`) makes proxy calls fail with a clear message; the
DevTools fallback covers the publish tools regardless. Kill the stale `node …/index.js`
processes when you want a current build to own the port.

How the extension is *supposed* to start: it needs no toggle. `background.js` runs
`bridgeLoop()` on install/startup and re-arms it with a 1-minute alarm; the popup's
"MCP bridge" toggle (`swhBridgeEnabled`) only matters if it was switched off. `launch_chrome`
re-installs the unpacked extension on every launch (`Extensions.loadUnpacked`).

## Guardrails

- **8,000-character cap.** Steam refuses or truncates longer descriptions.
  `compose_workshop_bbcode` returns `ok:false` with the overage; `swh_update_description`
  refuses before touching the page: *"N over Steam's 8000-character cap. Drop the oldest
  `[h2]Changelog (vX)[/h2] ... [/list]` block from About/steam_description.txt (keep the
  `Full version history` link)."*
- **Link domains.** Steam re-scans an item on every description change; an unfamiliar domain
  is the likely trigger for `awaiting_analysis` → `removed` (seen with `polyformproject.org`;
  fixed by linking the repo's own `LICENSE` page). Both tools warn on anything outside
  steamcommunity.com, steampowered.com, github.com, imgur.com / i.imgur.com, ko-fi.com,
  discord.gg (subdomains included).
- **Verification.** `swh_update_description` re-reads the current text first (`previousChars`),
  saves, then opens the public item page as the owner and checks the `Version:` line
  (`verified`, `versionLine`) and moderation notice (`moderation.state`).
- **Consent.** `swh_post_changelog` is a dry run unless `confirm:true`; `dryRun:false` alone is
  refused.

## Moderation states (`swh_get_moderation_state`)

Read from the public page **through the logged-in Chrome** — anonymous fetches see different
text while an item is flagged. Plain body-text matches, most severe first:

| `state` | Notice text |
|---|---|
| `removed` | *This item has been removed from the community because it violates Steam Community & Content Guidelines* |
| `awaiting_analysis` | *… awaiting analysis by our automated content check system* |
| `hidden` | *The item is either marked as hidden or you do not have permission to view it* |
| `incompatible` | *This item is incompatible with RimWorld* |
| `visible` | none of the above |

While `awaiting_analysis` / `removed`, other users cannot see the item and edits or the
in-game file upload can return **Access Denied**. Only the owner can appeal via Steam Support.

## Changelog thread (`swh_post_changelog`)

The item's **Discussions** tab is the running changelog (the Change Notes tab can only be
written from the in-game upload dialog). Flow:

1. `extract_changelog_block { steamDescriptionPath, version }` (or pass `bbcode`) — the
   `[h2]Changelog (v<version>) …[/h2] … [/list]` block, byte-identical, plus the
   *Full version history* wiki URL.
2. Open `https://steamcommunity.com/workshop/filedetails/discussions/<fileId>/`, list threads.
3. **Find** a thread named "Changelog" (case-insensitive, `PINNED:` prefix ignored, pinned
   preferred) → reply on it; **or create** it with a first post linking the wiki Changelog page,
   then reply with the block.
4. Pin via the owner's admin menu when possible; verify against the thread list (`sticky`
   class) and report `pinned` / `pinNote`.
5. Return `threadUrl` and `postUrl` (`<thread>#c<postId>`).

## Page anatomy (captured 2026-09-05, owner session)

| Page | Selectors |
|---|---|
| Logged in | `#account_pulldown`; `window.g_steamID` |
| Edit page `…/sharedfiles/itemedittext/?id=<fileId>` | `#description` textarea (only served to the owner); Save = `a.btn_green_white_innerfade`; after save the page navigates to `/sharedfiles/itemedittext/` with no id and no error text |
| Public page `…/sharedfiles/filedetails/?id=<fileId>` | `.workshopItemDescription`; stats values `.detailsStatRight` (size, posted, updated) |
| Discussions `…/workshop/filedetails/discussions/<fileId>/` | `div[id$="_newtopic_area"]` → forumId `PublishedFile_<appForumId>_<fileId>` (strip `forum_` / `_newtopic_area`; **read it, don't hardcode the middle number**); "Start a New Discussion" = `javascript:Forum_CreateTopic('<forumId>')`; form `form#forum_<forumId>_newtopic_form` with title `input[name=topic]`, body `#forum_<forumId>_textarea` (`.forumtopic_reply_textarea`), submit `button[id$=_submit]` inside `[id$=_submit_container]`, errors `#forum_<forumId>_newtopic_error`; rows `.forum_topic` (class `sticky` when pinned) → `.forum_topic_name`, `.forum_topic_reply_count`, `a.forum_topic_overlay` |
| Thread `…/workshop/filedetails/discussion/<fileId>/<topicId>/` | reply `textarea#commentthread_ForumTopic_<a>_<b>_<topicId>_textarea` (ignore `#forum_report_reason`), submit = same id with `_submit`; OP `.forum_op`, replies `[id^="comment_"]`; owner admin menu `img.admin_option_icon` → popup items (pin/lock/delete — `Forum_SetTopicFlag` behind it); posts are AJAX, no navigation |

Steam BBCode everywhere (`[h2]`, `[list]`, `[*]`, `[b]`, `[url=]`).

## Tests and live checks

- `cd server && npm run test:steam` — `test/steam-cdp-stub.test.js` runs the real handlers
  against a stub DevTools endpoint (HTTP + a minimal RFC 6455 websocket) that answers
  `Runtime.evaluate` by the `swh:<probe>` marker each expression carries. Covers route selection,
  cap refusal, all moderation notices, block extraction, find-or-create (dry + confirmed),
  update + verify, compose guardrails, bridge owner/proxy/unavailable.
- Live, read-only: `swh_get_auth`, `swh_get_item`, `swh_get_moderation_state`, and a
  `swh_post_changelog` dry run against a real item — none of them changes anything.
