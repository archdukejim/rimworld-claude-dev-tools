# CLAUDE.md — rimworld-claude-dev-tools (RimSynapse MCP)

Guidance for Claude Code working in this repo. Keep this file current as the MCP
server grows — new tool families ("expansions") get documented here.

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
- `server/build/` — `tsc` output (git-tracked build artifacts + one-off scripts).
- `manifest.json` — `.mcpb` bundle manifest; **also lists every tool** (name +
  description). Must be kept in sync when tools are added/removed.
- `harness/` — PowerShell build/deploy/launch/test scripts and the triage runner.
- `docs/` — `API.md` (Steam Workshop `window.SWH` API), `MCP-PHASE2.md`,
  `SCHEDULING.md`, `COMMENT-TRIAGE.md`, `CLAUDE-USAGE.md`.
- `extension/` — the Steam Workshop Helper browser extension.
- `.claude/skills/` — includes `steam-comment-triage`.

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
2. Wire it into `server/src/index.ts` in **three** places:
   - `import { <family>Tools, handle<Family>Tool } from "./tools/<family>";`
   - spread `...<family>Tools` into the `ALL_TOOLS` array.
   - add a dispatch block: `if (<family>Tools.some(t => t.name === name)) return await handle<Family>Tool(name, args);`
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
`gameIpc` (live game calls), `testing`, `workshop`/`swh_*` (Steam, via the
loopback `bridge`), `github` (SWH issue tools, repo-map based), `corpusRegistry`
(generic register/index/graph/search), `harmony` (Harmony patching RAG — a
curated corpus in `harmony-knowledge/` bootstrapped into the corpus registry).

## Build / run

- Build: `server/build_server.bat` → runs `npm run build` (`tsc`, `src/` → `build/`).
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
  opens a native paste window, writes `github_token.txt` (gitignored), hot-swaps the running
  server's client (no restart), and live-verifies the PAT. Or set `GITHUB_TOKEN` /
  `github_token.txt` yourself to a PAT with **`repo`, `read:org`, `project`** (classic) —
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

## Planned expansions

The roadmap lives in **`docs/PLANNED-FEATURES.md`** (human-readable snapshot),
with **GitHub issues as the live source of truth** (`archdukejim/rimworld-claude-dev-tools`
issues #1–#3 as of this writing). Update that file + the issues, not a duplicate list here.
