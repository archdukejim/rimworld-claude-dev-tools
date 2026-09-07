# CLAUDE.md — rimworld-claude-dev-tools (RimSynapse MCP)

Guidance for Claude Code working in this repo. Keep this file current as the MCP
server grows — new tool families ("expansions") get documented here.

## Worktree isolation & branching (MANDATORY — read first)

Multiple Claude sessions run against this repo concurrently (and forks add more). To make
"two agents stomping the same checkout" impossible, **every session works in its own git
worktree on its own branch.** This is enforced by hooks, not left to discipline.

- **`main` is PROTECTED.** Never commit, merge, rebase, or push to `main`. It is release-only,
  updated solely by PR **from `development`**. A `PreToolUse` hook (`.claude/hooks/protect-main.cjs`)
  hard-blocks any git write to `main`.
- **`development` is the integration branch** — and also protected from *direct* commits. You
  branch **from** it and merge **into** it via PR; you do not commit on it directly.
- **Your work happens in a per-session worktree** at `../worktrees/<repo>/<session-id>` on branch
  `agent/<session-id>`, created automatically by the `SessionStart` hook
  (`.claude/hooks/session-worktree.cjs`) off `development`. **cd into that worktree** and use
  absolute paths under it for all edits/commits. The session-start message tells you the exact path.
- **Landing work:** push your `agent/<id>` branch and open a PR **into `development`** (never `main`).
- **Referencing / absorbing another session's work:** `git worktree list` shows every session's
  path + branch. To pull a finished subtask into your worktree: `git -C <your-wt> merge agent/<other-id>`.
- **Handoff:** a finishing session records what it did in `AGENT-HANDOFF.md` (on its branch) so the
  next agent can absorb it before merging. Read it first when picking up another branch.

Full workflow, rationale, and recipes: **`docs/AGENT-WORKTREES.md`**.

## What this repo is

The **RimSynapse** dev-tools hub: a Model Context Protocol (MCP) server that lets
local AI agents drive the whole RimWorld-mod development loop — GitHub issues &
project boards, wiki sync, deploying mods into the game, launching RimWorld for
automated tests, reading `Player.log`, live game IPC (factions, psychology), and
Steam Workshop management (comments, descriptions, comment triage).

The server is TypeScript, compiled to `server/build/`, and also packaged as an
`.mcpb` bundle described by `manifest.json`.

## Layout

- `server/src/index.ts` — MCP server entry. Aggregates every tool family, exposes
  `ListTools`, and dispatches `CallTool` to the right handler. Supports stdio and
  `--sse` transports.
- `server/src/tools/` — **one module per tool family.** This is where expansions live.
- `server/src/config.ts`, `bridge.ts`, `manager.ts` — config/auth, the Steam
  loopback bridge (for `swh_*` browser tools), and the process manager.
- `server/build/` — `tsc` output. **Not tracked in git** (gitignored); regenerate with
  `cd server && npm run build` (or `server/build_server.bat`). The `.mcpb` bundle is built from
  a fresh compile, and the running dev server (`node server/build/index.js`) uses this on-disk
  output — so rebuild after editing `server/src/` (and restart the server).
- `manifest.json` — `.mcpb` bundle manifest; **also lists every tool** (name +
  description). Must be kept in sync when tools are added/removed.
- `harness/` — PowerShell build/deploy/launch/test scripts and the triage runner.
- `docs/` — `API.md` (Steam Workshop `window.SWH` API), `MCP-PHASE2.md`,
  `SCHEDULING.md`, `COMMENT-TRIAGE.md`, `CLAUDE-USAGE.md`.
- `extension/` — the Steam Workshop Helper browser extension.
- `.claude/skills/` — includes `ui-test`, `workshop-page` (repo-scoped on purpose: they lean on
  in-repo docs/tools). Cross-repo workflow skills live at USER level (`~/.claude/skills/`):
  `work-next-milestone`, `feature-complete`, `work-bugs`, `ship-it` (absorbed the old
  `cut-release`), `steam-comment-triage`. Don't duplicate a skill in both places — one home each.
- `.claude/agents/` — project subagents. `rimworld-isolation-tester` proves a specific
  *gameplay behavior* fires in a controlled in-game environment (precondition gate →
  `perf_watch` funnel → verdict). Use it for "does X actually work in-game / why isn't
  X firing", not for load-time or compile checks.

## Tool-family pattern (the important convention)

Every file in `server/src/tools/<family>.ts` exports exactly two things:

```ts
export const <family>Tools = [
  {
    name: "my_tool",                 // snake_case, globally unique across ALL families
    description: "What it does.",
    inputSchema: {                   // JSON Schema
      type: "object",
      properties: { foo: { type: "string", description: "..." } }
    }
  }
];

export async function handle<Family>Tool(name: string, args: any /*, deps */) {
  if (name === "my_tool") {
    // ...
    return { content: [{ type: "text", text: "result" }] };  // MCP content shape
  }
  throw new Error(`Unknown <family> tool: ${name}`);
}
```

Handlers **always** return `{ content: [{ type: "text", text }] }`. On failure,
either throw (Claude sees the error) or return an error string in `text`.

`wiki.ts` is the smallest, cleanest reference implementation — read it first.

## Adding a new tool / tool family (checklist)

1. Create `server/src/tools/<family>.ts` following the pattern above.
2. Wire it into `server/src/index.ts` in **four** places:
   - `import { <family>Tools, handle<Family>Tool } from "./tools/<family>";`
   - spread `...<family>Tools` into the `ALL_TOOLS` array.
   - add a dispatch block to the `CallToolRequestSchema` handler (stdio):
     `if (<family>Tools.some(t => t.name === name)) return await handle<Family>Tool(name, args);`
   - add the **same branch to the SSE `app.post("/api/tools/:name")` chain** further down — it is a
     separate `else if` ladder, and a family wired only into the stdio path 404s over SSE.
3. If the tool needs a GitHub token, add its name to the `GITHUB_BACKED_TOOLS`
   set. Token is optional server-wide and checked per-call — non-GitHub families
   (RimWorld, pc-control, wiki, factions, psychology) must stay usable with no token.
4. Add the tool(s) to `manifest.json`'s `"tools"` array (name + description only).
5. Build: `server/build_server.bat` (or `cd server && npm run build`). Output → `server/build/`.
6. Adding a whole new family? Update the "Tool families" list below.

## Tool families (current)

GitHub-backed (need a token): `issues`, `projects`, `codebase`, `sync`, plus
`create_testing_plan_issues` from `testing`.

No token required: `wiki`, `factions`, `psychology`, `pcControl` (desktop
automation via `@nut-tree-fork/nut-js`), `rimworldDev` (deploy/launch/log),
`gameIpc` (live game calls), `testing`, `workshop`/`swh_*` (Steam — extension
loopback `bridge` when connected, DevTools fallback otherwise; see below),
`github` (SWH issue tools, repo-map based), `corpusRegistry`
(generic register/index/graph/search), `harmony` (Harmony patching RAG — a
curated corpus in `harmony-knowledge/` bootstrapped into the corpus registry),
`auth` (local secret keyring — `set_github_token`, `list_keys`, `delete_key`,
`set_active_key`; multiple labelled keys per service, active-key resolution),
`imgur` (host generated images for Workshop descriptions — see below),
`chromeCtl` (launch/own a dedicated Chrome + tab-group hygiene — see below),
`rimsort` (`suppress_rimsort_warnings` — quiets RimSort's dev-noise dialogs),
`promptLab` (`simulate_llm_prompt`, `list_prompt_families` — the universal game-free
prompt/response harness — see below),
`discussions` (`swh_list/find/get/create/reply/edit/pin_discussion` — Steam Workshop
Discussions threads over the DevTools route; the backlog/milestone threads that replace the
GitHub backlog + changelog for players. Conventions + write discipline: **`docs/DISCUSSIONS.md`**;
driven by the user-level `workshop-backlog` skill).

### Game-free prompt iteration (`promptLab`)

The **universal** RimSynapse prompt/response harness. `simulate_llm_prompt` composes the EXACT prompt a
given LLM call site (**family**) would send and — unless `dryRun` — sends it to the same local model the
game uses, with **no RimWorld launch**, returning the **raw** response (+ composed system/user, an
optional family parse, and metadata). It replaces the deploy→launch→load→debug-action→read-log loop for
tuning prompts (e.g. the Conversations #44 clinical-technobabble regression). **It does NOT judge** —
parsing/scoring the raw is the job of whatever specific tool is built on top, tuned to that tool's goal.

- **Family registry.** Each call site is an `IPromptFamily` (`promptlab/Contract.cs`), discovered by
  reflection (`Registry.cs`). Current families: `conversation` (Conversations dialogue), `newspaper`
  (WorldNews broadsheet), and `psychology.voice` / `psychology.break` / `psychology.childhood` (Psychology —
  note `psychology.voice` produces the `voiceProfile` the `conversation` #44 logic consumes, so the whole
  register loop is tunable game-free). `list_prompt_families` returns each family's input contract (fields, types,
  provenance) + catalog size. `mode:"suite"` runs a family's built-in scenario catalog; `mode:"scenario"`
  runs your own `inputs` (family-specific — see the contract). `dryRun` builds prompts without an LLM.
- **Faithful by construction:** a family `<Compile>`-links the PURE, Verse-free composer authored ONCE
  in its mod (`ThinPromptComposer`/`IdentityComposer` in Conversations; `NewspaperPromptComposer` in
  WorldNews), so the lab can't drift from the game. A TS reimplementation would silently diverge — don't
  build one. Add a family = add a mod-owned pure composer + a `promptlab/Families/<X>Family.cs` adapter.
- **Pipeline:** MCP tool → `harness/promptlab.ps1` → `promptlab/PromptLab.exe`. The console links each
  mod's pure composer from the workspace (`$RS_Root\<Mod>`), reads the **live Core config** for
  endpoint/model, auto-maps the loaded local model like the game, and POSTs the faithful non-agentic body
  `{model, messages}` + thinking-disable flags — no temperature/max_tokens/response_format.
- **Mod source location:** a family only compiles in if its mod's pure composer is present at
  `$RS_Root\<Mod>`. To test a family against a mod **branch/worktree** before it lands, set the matching
  `*_SRC` env var (`CONVERSATIONS_SRC`, `WORLDNEWS_SRC`, …) to that checkout — `promptlab.ps1` passes it
  through as an MSBuild property. Requires `dotnet`.

### The RimAgentic Chrome (`chromeCtl`)

`launch_chrome` starts a Chrome the agent owns, so browser-driven work never depends on the
user having a browser open. Key facts, each of which cost a debugging cycle to establish:

- **Dedicated profile**, `%LOCALAPPDATA%\RimAgentic\chrome-profile` — never the user's. Chrome
  can't add a debugging port to an *already running* instance, so sharing the default profile
  would mean the launcher only works when Chrome happens to be closed. Sessions persist, so you
  sign into Steam/imgur there once.
- **`--load-extension` is ignored by Chrome 137+** (anti-malware hardening) — and it fails
  *silently*. The extension is installed over CDP via `Extensions.loadUnpacked`, which needs
  `--enable-unsafe-extension-debugging` at launch and a **forward-slash** path (a Windows
  backslash path returns "File path cannot be resolved"). This is per-session, so the launcher
  re-installs on every launch — which also means the running extension is always current.
- **Don't detect the extension by sniffing for any `chrome-extension://` service worker** —
  Chrome runs its own component extensions and you'll get a false positive. Match the background
  script path (`/src/background.js`), and treat the bridge connection as the real liveness signal:
  MV3 service workers spin down when idle.
- `close_chrome` only kills processes whose command line matches `--user-data-dir=<our profile>`
  anchored at a word boundary — a bare substring match would also catch sibling profiles.

**Tab groups** (`chrome_tabs`, `chrome_tidy`) are not a DevTools concept — `chrome.tabGroups` is
extension-only — so they route through the loopback bridge to the service worker
(`extension/src/tabs.js`, exposed as `tabsInventory` / `tabsTidy`). `chrome_tidy` is deliberately
aggressive (closes duplicates + idle tabs, dissolves singleton/empty groups, regroups by site with
stable names and colours, collapses inactive groups) because every tab in that profile belongs to
automation. Guard rails: pinned, active, and `keep`-matching tabs are never closed, and one tab
always survives. Run it at the end of any browser task. Tests: `npm run test:chrome` (needs a real
browser; it self-launches).

### Steam Workshop publish path (`workshop` / `swh_*`)

The full reference is **`docs/STEAM-PUBLISH.md`**. The facts that cost a release to learn:

- **Two routes, chosen automatically.** The extension bridge (`bridge.ts`, port 8766) is used
  when connected; otherwise `swh_get_auth` / `swh_get_item` / `swh_open_item` /
  `swh_update_description` / `swh_get_moderation_state` / `swh_post_changelog` drive the
  RimAgentic Chrome over the DevTools protocol (`steamCdp.ts`, zero deps, global `WebSocket`).
  Comment/notification/title tools are bridge-only. **Never hand-roll a CDP script** for a
  publish — extend `steamCdp.ts` (every `Runtime.evaluate` carries a `swh:<probe>` marker the
  stub test keys on).
- **The bridge port has ONE owner.** Every session's MCP server tries to bind 8766; the first
  wins, later servers proxy to it (`POST /call`), and `chrome_status.bridge.mode` says
  `owner` / `proxy` / `unavailable` with a `note`. "bridge not started" is gone; a stale owner
  build (no `/call`) shows up as a proxy error and the tools fall back to DevTools.
- **8,000-character description cap** — `compose_workshop_bbcode` and `swh_update_description`
  refuse over it; the fix is to drop the OLDEST `[h2]Changelog (vX)[/h2] … [/list]` block and
  keep the `Full version history` link. **Unfamiliar link domains** trigger Steam's content
  check (item hidden, edits return Access Denied) — both tools warn; only steamcommunity,
  github, imgur, ko-fi, discord.gg are on the known-good list.
- **`swh_post_changelog` is dry-run by default**; only `confirm:true` posts (find-or-create the
  pinned "Changelog" Discussions thread, reply with the block from `extract_changelog_block`).
  With `milestoneName` it instead closes out the `Next milestone: <version> …` thread: final
  reply, retitle to `<version> <name> - shipped`, unpin (the `workshop-backlog` skill's flow).
- **Discussions tools** (`swh_*_discussion*`, `docs/DISCUSSIONS.md`) share the route, the
  dry-run/confirm discipline, the post cap, and the domain allow-list.
- Tests: `cd server && npm run test:steam` (stub DevTools endpoint; touches nothing real).

### Image hosting for Workshop descriptions (`imgur`)

Steam BBCode embeds images by URL only, so nothing this server generates
(`capture_*`, `render_workshop_infographic`, `merge_workshop_tiles`, the
`showcase` gallery) is usable in a description until it's hosted. The pipeline is:

```
showcase_add / render_* → imgur_upload → bbcodeImages → compose_workshop_bbcode → swh_update_description
```

- **One-time setup:** register an app at <https://api.imgur.com/oauth2/addclient>
  ("OAuth 2 authorization with a callback URL", callback exactly
  `http://localhost:8788/imgur/callback`), then `imgur_login { clientId, clientSecret }`.
  It opens the consent page in the **RimAgentic Chrome** (launching it if needed — see
  `chromeCtl` above), catches the loopback redirect, and stores tokens in the same
  keyring as the GitHub PATs (service `imgur`, JSON blob; multiple accounts via `label`).
  A registered client id is unavoidable: imgur ships its web client id inside a webpack
  bundle, so there is no registration-free upload path that isn't reverse-engineering
  their site — don't go looking for one again.
  `imgur_login { clientId, anonymousOnly: true }` skips OAuth entirely — uploads then
  aren't tied to an account and are only deletable via the deletehash in the local ledger.
- **`imgur_upload` is idempotent** — it dedups on file *content* hash against a local ledger
  (`%LOCALAPPDATA%\RimAgentic\imgur\uploads.json`), so rebuilding a workshop page reuses
  existing links instead of burning imgur's daily quota. `force: true` overrides.
- It returns a ready-made `bbcodeImages: [{url, caption}]` — pass it straight to
  `compose_workshop_bbcode` as `images`. Uploading by `mod` pulls from the showcase gallery
  and carries each item's caption through, so passing UI-test evidence becomes a description
  with no manual step.
- **Upload preference order:** `imgur_upload` (API; needs `imgur_login` once) → `imgur_web_upload`
  (no credentials: drives the RimAgentic Chrome's logged-in session over CDP `DOM.setFileInputFiles`
  — no window focus, no drag-drop; needs `launch_chrome` + a signed-in imgur session). **Never drive
  the imgur website manually** (clicks/keystrokes/paste into the page) — blind desktop input on a
  contested desktop is what stranded past agents. Browser-session uploads have no deletehash.
- **`imgur_resolve`** turns any imgur reference (album/gallery/image-page/direct URL, bare hash)
  into direct full-size image URLs: local ledger first (zero network for anything uploaded via
  `imgur_upload`), then the imgur API, then a normalised scrape (browser UA; strips query strings
  and the one-char resize suffix, prefers .png, dedups by base hash, optionally verifies real
  dimensions). Never hand-roll this with a page fetch — scrapes surface thumbnails first, and
  WebFetch is blocked for imgur.com.
- Tests: `cd server && npm run test:imgur` (stub API + temp `LOCALAPPDATA`; touches neither
  imgur nor your real keyring). The OAuth round-trip itself isn't covered — it needs real credentials.

## Build / run

- Build: `server/build_server.bat` → runs `npm run build` (`tsc`, `src/` → `build/`).
- **`server/node_modules` is untracked** (it used to be committed, which made every worktree
  checkout crawl). In session worktrees it's a **junction to the main checkout's copy** (made by
  the SessionStart hook) — treat it as read-only there; `npm install` / `npm ci` runs ONLY in
  `C:\github\rimworld-claude-dev-tools\server`. The committed `package-lock.json` is kept in
  sync with `package.json`, so `npm ci` works in a fresh clone.
- Run (stdio): `node server/build/index.js`. SSE: add `--sse --port <n>`.
- The packaged runtime is `server/localMCP.exe`; `manifest.json` entry point is
  `server/index.js` launched with `node`.
- Node lives at `C:\Program Files\nodejs` (the batch files put it on PATH).

## Conventions & gotchas

- Windows / PowerShell is the primary shell; a Bash tool is also available.
- `__dirname` in handlers resolves against `server/build/tools/`, not `src/`.
  Path math like `path.resolve(__dirname, "../../../../Wiki")` is relative to the
  **compiled** location — count directories from `build/tools/`.
- Tool names are a single global namespace — no collisions across families.
- Keep families independent: a native-module or bridge failure should disable only
  that family, not crash the server (see the try/catch around `startBridge`).
- **`search_issues` doesn't reliably honour `repo:`** — a `repo:owner/name is:issue`
  query has returned issues from other repos. Don't trust a repo-scoped search to be
  scoped; verify each result's repo before acting, and prefer per-repo listing when it
  matters. (Bug to fix: pass the `repo:` qualifier through instead of OR-ing terms.)
- **`run_rimworld_tests` can run a stale binary** — it builds to `<repo>/Assemblies`
  but does **not** redeploy to the Steam `Mods/` folder the game loads from. Run
  `deploy_rimworld_mods` first, or the test launches whatever binary was last deployed.
  (Deploy now reports whether the assembly hash actually changed, and launch warns when a
  real deployed copy is older than the repo build — but redeploying first is still the fix.)
- **The harness guards against false-green runs** — base-game-less modlists, ModsConfig drift
  to safe mode, stale/collapsed-to-vanilla runs, and empty runs are detected and refused rather
  than reported as clean. The durable reference (what's enforced, the known-good test modlist,
  and headless-testing guidance incl. the RP2 / recovery-NRE caveats) is
  **`docs/HARNESS-RELIABILITY.md`**.

## GitHub auth & release ops (rules)

The GitHub token resolves in this order (`getGitHubToken`, `server/src/config.ts`):
`GITHUB_TOKEN` env → `github_token.txt` (`TOKEN=…`) → **fallback** `gh auth token`.

- **The `gh auth token` fallback is a trap for Projects v2.** It returns the gh
  CLI's own OAuth keyring token (`gho_…`, scopes `repo read:org gist admin:public_key`),
  which can only gain `project`/`read:project` via an interactive `gh auth refresh` —
  never the user's PAT. So issues/files/wiki (`repo`) work while **every org-board op
  fails**: `get_project_items` (needs `read:project`), `add_project_item`,
  `update_project_item_status`, `update_project_item_iteration`, `cleanup_project_board`
  (all need `project`). The GraphQL error to recognize is `requires ['project']` /
  `requires ['read:project']`.
- **Rule: provision an explicit PAT — never rely on the fallback for board work.** The
  easy path is the **`set_github_token`** tool (`server/src/tools/auth.ts`): with no arg it
  opens a native paste window, saves the PAT to the local keyring (`%LOCALAPPDATA%\RimAgentic\keys.json`,
  also mirrored to `github_token.txt`), hot-swaps the running server's client (no restart), and
  live-verifies the PAT. Multiple PATs are supported — pass a `label` (e.g. one per org) and switch
  with `set_active_key`; inspect/prune with `list_keys` / `delete_key`. Token resolution is
  **env `GITHUB_TOKEN` → active keyring key → `github_token.txt` → `gh` fallback** (see `keystore.ts`
  + `getGitHubToken`). Or set `GITHUB_TOKEN` / `github_token.txt` yourself to a PAT with
  **`repo`, `read:org`, `project`** (classic) —
  `project` covers both read and write of Projects v2. Fine-grained PAT must be authorized
  for the org with Projects: Read and write, Issues RW, Contents RW, Metadata R. Provisioning
  the scopes in GitHub is not enough — the PAT must actually be *installed* where the MCP
  reads it (env → `github_token.txt` → `gh` fallback), else the fallback silently wins.
- **Rule: on a scope error, don't surface the raw GraphQL error.** Say which token is in
  use (`gho_…` from `gh auth token` means the fallback fired) and that it needs `project`
  scope — point at setting `GITHUB_TOKEN` to a PAT or `gh auth refresh -s read:project,project`.
- **Release/tagging: `--target` rejects a short SHA.** Creating a tag/release (e.g.
  `gh release create vX.Y.Z --target …`) must pass a **branch name or a full 40-char SHA**,
  not an abbreviated SHA. When `main`'s HEAD is a merge commit, the branch name (`main`)
  is the reliable target.

## Testing UI changes (required)

Any change that adds or alters in-game UI — a **gizmo**, a **window/dialog/float
menu**, an **inspect-pane** element, a **colonist-bar** element, or a **map-overlay /
play-settings toggle** (including Def changes that surface a new gizmo/comp) — must be
verified with **both a positive and a negative test case per changed element**, run
headlessly through the game, before it is considered done.

- The protocol (positive/negative definitions, per-type playbooks, the assertion
  tools, and the definition-of-done gate) is **`docs/UI-TESTING.md`** — the source of
  truth. Run it via the **`ui-test`** skill.
- A UI change with only a positive case, or missing evidence (screenshot +
  clean `read_rimworld_log`), is **not done**. If the game can't launch, author the
  matrix, mark it `BLOCKED — needs game`, and report the change as *unverified*.
- Assertions come from the headless UI tools (`get_gizmos`, `activate_gizmo`,
  `read_float_menu`, `get_open_windows`, `get_colonist_bar`, `get_play_settings`,
  `set_play_setting`, `sample_environment`, …); `capture_*` screenshots are evidence.

## Debug-command validation (required — part of the testing gate)

Building or changing a **code or mechanic setup** in a mod — a comp, manager, incident,
mental state, trigger, or def-driven behavior — is **not done** until it has been exercised
by a debug command and observed to behave as intended. Assuming the code works is not
validation. This is a definition-of-done requirement that sits alongside the UI-testing gate
below. For every mechanic you build or change, you **MUST**:

1. **Build** a `[DebugAction]` that forces the mechanic to run (bypassing its trigger
   conditions) and/or dumps its state — a required deliverable of the change, not optional tooling.
2. **Trigger** it — in-game via the Debug Actions menu, or headlessly via `execute_game_tool`.
3. **Confirm** from the result / `read_rimworld_log` output that the behavior matches intent.

A mechanic change with no debug command exercised against it is **unverified**, exactly like a
UI change missing its positive/negative case. (This is proof-of-function for what you touched —
not a mandate to retrofit debug actions onto untouched existing mechanics.)

- Use `[DebugAction("RimSynapse", "...", actionType = ..., allowedGameStates = ...)]` on static
  methods, grouped under the mod's category — this gives the in-game **Debug Actions menu** entry.
  The house pattern and the full playbook live in
  **`modding-knowledge/04-csharp-and-harmony.md`** ("Debug actions").
- **A plain `[DebugAction]` is headlessly triggerable** via the toolkit mod's generic bridge tools
  `list_debug_actions` / `run_debug_action` (call them through `execute_game_tool`). `run_debug_action`
  reflects over every loaded assembly and dispatches on signature: no-arg runs immediately, `Pawn`
  takes `pawnName`, `IntVec3` takes `x`/`z`. So one `[DebugAction]` yields both the human menu entry
  and the agent's headless hook — no per-mod `RegisterTool` needed just to validate. This requires the
  toolkit mod (`archdukejim.rimagentic`) to be the active bridge (it loads last; the MCP defaults to
  its `%LOCALAPPDATA%\RimAgentic\ipc` channel). Use `SynapseToolRegistry.RegisterTool(...)` only when
  you want a first-class tool with a structured arg schema / JSON return.

## Planned expansions

The roadmap lives in **`docs/PLANNED-FEATURES.md`** (human-readable snapshot),
with **GitHub issues as the live source of truth** (`archdukejim/rimworld-claude-dev-tools`
issues #1–#3 as of this writing). Update that file + the issues, not a duplicate list here.
