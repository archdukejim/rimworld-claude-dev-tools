# RimAgentic

**An agent-driven RimWorld modding toolkit.** RimAgentic gives a frontier-model
agent (e.g. Claude) everything it needs to build, deploy, run, and evaluate a
RimWorld mod — plus a live bridge into the running game and a bundled "how to mod
RimWorld" knowledge base. Point it at your mod and let the agent do the loop.

> Forked from the RimSynapse Core tool bridge and generalized: no narrative content,
> no local-LLM assumptions — just the modding-dev surface, for any mod.

## Install (Claude Code plugin)

RimAgentic ships as a Claude Code **plugin** — installing it brings the MCP tools,
skills, and commands together. In any Claude Code session:

```
/plugin marketplace add archdukejim/rimworld-claude-dev-tools
/plugin install rimagentic@rimworld-claude-dev-tools
```

Then, inside your mod's folder, run once:

```
/rimagentic:setup
```

That builds the tools, installs the game-side mod into RimWorld (loaded last), writes
project instructions, and verifies the bridge. After that, every session in that project
already knows the workflow.

**One-click launch** (optional): a deep link opens Claude Code in a folder with the install
command pre-filled — you just press enter (nothing installs silently):

```
claude-cli://open?q=%2Fplugin%20install%20rimagentic%40rimworld-claude-dev-tools
```

**Commands:** `/rimagentic:setup`, `/rimagentic:new-mod`, `/rimagentic:fix-from-log`,
`/rimagentic:deconflict`.

## Two halves

- **MCP server** (`server/`) — the tools an agent calls: discover mods, resolve load
  order, build/deploy, launch an isolated dev instance, run the in-game TestRunner,
  triage `Player.log`, query the modding docs, and drive the in-game tool bridge.
- **Game-side mod** (`game-mod/`) — a standalone RimWorld mod (`RimAgentic`) that
  exposes the base game + DLC surface over a file bridge: discover and invoke in-game
  dev/inspection tools (defs, incidents, reflected debug actions, pawn/object/map
  state). Other mods can register their own tools at runtime, so the surface grows
  dynamically.

## What an agent can do with it

Read `modding-knowledge/` (via the `query_modding_docs` tool) to learn how to mod,
then run the loop: `resolve_mod_load_order` → `configure_active_mods` →
`deploy_rimworld_mods` → `run_rimworld_tests` → `read_rimworld_log` → inspect with
`execute_game_tool` → fix → repeat. See `modding-knowledge/06-using-this-toolkit.md`.

## Layout

- `server/` — the MCP server (TypeScript). `npm run build`, entry `build/index.js`.
- `game-mod/` — the RimAgentic game mod (C#, net48). Build `Source/RimAgentic.csproj`;
  symlink `game-mod` into `RimWorld/Mods/` for development.
- `harness/` — PowerShell build/launch/log scripts the MCP server drives.
- `modding-knowledge/` — bundled RimWorld modding docs served to the agent.
- `manifest.json` — `.mcpb` bundle manifest (tool list + config).

## Configuration

- **Mod workspace** — `RIMAGENTIC_ROOT` (a folder of mods, or a single mod repo).
- **Dev save folder** — `RIMAGENTIC_SAVEDATA` (isolated `-savedatafolder`).
- **Game↔MCP bridge dir** — both default to `%LOCALAPPDATA%\RimAgentic\ipc`; override
  with `RIMAGENTIC_IPC_DIR`. No coordination needed otherwise.
- **GitHub token** — only for the optional GitHub/project tools.

Legacy `RIMSYNAPSE_*` env vars are still read as a fallback.

---
*See the [Changelog](Changelog.md) and `docs/plans/` for the design docs.*
