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
