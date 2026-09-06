# AGENT-HANDOFF — `agent/4c8ab8ba`

## What this branch adds

**A self-sufficient Steam Workshop publish path** — everything the `ship-it` PUBLISH half needs works from a
fresh session with only the RimAgentic Chrome (`launch_chrome`, port 9222, signed into Steam). Reference:
`docs/STEAM-PUBLISH.md`. Motivation: publishing Regions and Societies 0.3.2 (2026-09-05) needed hand-rolled
CDP scripts because every `swh_*` call failed with "bridge not started", the 8,000-char cap bit silently,
and the harness/wiki tooling had `RimSynapse` hardcoded.

- **`server/src/bridge.ts`** — `startBridge` never throws. Modes: `owner` (bound 8766), `proxy` (a sibling
  MCP server owns the port; `call()` forwards to its new `POST /call`, status mirrors its `/health` + pid),
  `unavailable` (port held by something else; `note` says what). `chrome_status.bridge` shows `mode`/`note`.
  Root cause of the years-old symptom: ~13 `node server/build/index.js` processes all race for one port.
- **NEW `server/src/steamCdp.ts`** — zero-dependency DevTools page driver (global `WebSocket`) + Steam page
  scripts. Every `Runtime.evaluate` carries a `/* swh:<probe> */` marker the stub test keys on. Page anatomy
  (edit page, public page, discussions list, thread reply form, admin pin menu) is documented in its header.
- **NEW `server/src/steamLogic.ts`** — pure: cap check (8,000 + "drop the oldest changelog block" advice),
  moderation-notice parser (removed / awaiting_analysis / hidden / incompatible / visible), version-line
  extraction, `extractChangelogBlock`, find-or-create thread plan, well-known-domain check.
- **`server/src/tools/workshop.ts`** — bridge-when-connected, DevTools otherwise, for `swh_get_auth`,
  `swh_get_item`, `swh_open_item`, `swh_update_description` (read-first → cap refusal → save → verify version
  line on the public page → `{ ok, verified, versionLine, moderation }`). NEW `swh_get_moderation_state`,
  `extract_changelog_block`, `swh_post_changelog` (dry-run default; `confirm:true` posts; pins best-effort).
  Comment/notification/title tools stay bridge-only and explain how the bridge starts (`BRIDGE_HOWTO`).
- **`server/src/tools/workshopImages.ts`** — `compose_workshop_bbcode` asserts the cap + domain allow-list.
- **`server/src/tools/sync.ts`** — `sync_repo_wiki { localRepoPath, sourceDir?, message?, prune?, dryRun? }`:
  slug from the checkout's `origin` (any org), token-HTTPS then SSH clone, git-status-based add/update/remove,
  orphans reported, `dryRun` prints the diffstat.
- **`harness/package-release.ps1`** — `-Repo` = name or path; resolution RIMAGENTIC/RIMSYNAPSE_ROOT →
  legacy `C:\github\rimsynapse` → every workspace beside the checkout; `<owner>/<repo>` from `origin` for
  `releases/latest` and `-Upload`; zips land in `<workspace>\_release-zips`. `scripts/sync_wikis.ps1` derives
  the wiki URL from `origin` when no `[Wikis]` entry exists.
- **Docs**: `docs/STEAM-PUBLISH.md` (new), README "Steam Workshop publishing", CLAUDE.md subsection,
  `Changelog.md` entry, `manifest.json` (the swh family was never listed there — added, plus the new tools).
- **Skill**: `~/.claude/skills/ship-it/SKILL.md` Steps 7 (cap rule), 8 (`sync_repo_wiki` dry-run first),
  9 (no manual CDP; record moderation state), NEW 9b (`swh_post_changelog`, confirm-gated), 10 (no
  `RIMSYNAPSE_ROOT` / manual upload), testing-gate note (Steam must be running or RimWorld exits silently).

## Verified this session
- `cd server && npm run build` clean; `npm run test:steam` 50/50 (stub DevTools endpoint incl. a minimal
  RFC 6455 websocket; bridge owner/proxy/unavailable on real sockets).
- Live, read-only, against item 3784666060 through the real RimAgentic Chrome with `bridge = null`:
  `swh_get_auth` loggedIn true (archdukejim); `swh_get_item` returns the v0.3.2 description (7,539 chars);
  `swh_get_moderation_state` → `visible`; `swh_post_changelog` dry run → "create thread Changelog" with the
  exact 0.3.2 block (1,474 chars) and the wiki/Changelog link. Nothing was posted or edited.
- `harness/package-release.ps1 -Repo Core-MMF -Tag v0.3.2` (no upload) resolved
  `Regions-and-societies/Core-MMF` from origin with no env override; zip passed the root-layout assertion.
- `sync_repo_wiki { localRepoPath: …/Core-MMF, dryRun: true }` resolved the same slug and cloned over HTTPS.

## Not verified (needs a real post)
- `swh_post_changelog { confirm:true }` end-to-end on Steam (thread creation, reply anchor, pin via the
  admin menu). The selectors were captured live from an item with threads; the confirmed flow ran only
  against the stub. First real use: run the dry run, then confirm on a mod item, and check `pinned`/`pinNote`.

## Rollout
Rebuild, then kill the stale `node server/build/index.js` processes (`chrome_status.bridge.mode` will show
`proxy` until the owner is a current build; the DevTools route works regardless).
