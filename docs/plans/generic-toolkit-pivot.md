# Build Plan — Pivot to a Generic RimWorld Mod-Dev Toolkit

**Decision (2026-08-02):** pivot this repo from archdukejim's private RimSynapse
harness into a **distributable, mod-agnostic development toolkit** — a frontier-model
agent (Claude) that helps *any* modder build and test *their* RimWorld mod. Product-first.

Not to be confused with **RimSynapse Core** (a shipped game content mod: in-game AI
Director / narrative on lightweight local LLMs). This is dev-time tooling on a
frontier model. See memory `project-identity-vs-rimsynapse-core`.

## Shape of the product (two halves, one repo)

1. **Game-side dev-toolkit mod** (C#) — forked from Core's generic bridge, stripped
   of RimSynapse narrative + LLM. A RimWorld mod any developer installs (Steam
   Workshop, or **symlinked** into `Mods/` during dev) that exposes a generic
   in-game tool/IPC surface: discover + invoke dev/inspection tools inside a running
   game (spawn/inspect defs, dump pawn/object state, trigger incidents, debug actions).
2. **Agent + MCP side** (this server + an Agent SDK app) — drives the game-side mod
   and the build/test/deploy loop for the developer's target mod.

Both live **in this repo**. Dev install = symbolic link of the game-side mod folder
into RimWorld's `Mods/` (`deploy_rimworld_mods` already handles symlink-vs-copy).

## RimSynapse coupling inventory (what "generic" must sever)

Mapped 2026-08-02. Most is small and localized; the harness already discovers mods
generically (`lib.ps1` `Get-HarnessMods` / `Resolve-WorkspaceRoot`).

| # | Coupling | Location | Fix |
|---|---|---|---|
| C1 | Hardcoded mod list `modDefs` (10 RimSynapse mods, names, hasCsharp) | `server/src/tools/rimworldDev.ts:141` | Discover mods by scanning root for `About.xml`; detect `Source/*.csproj` for hasCsharp. Optional config override. |
| C2 | Hardcoded build order `$RS_BuildOrder` + `$RS_DataOnly` | `harness/lib.ps1:105` | Derive build order from each mod's `Source/*.csproj` `<ProjectReference>` graph (real assembly deps), fallback to About.xml load order. |
| C3 | Hardcoded dep logic ("Core first, Factions needs Regions") | `harness/build.ps1:20` | Replace with the derived build graph from C2. |
| C4 | Faction/psychology tools assume RimSynapse Core is loaded | `server/src/tools/factions.ts`, `psychology.ts` | **Hard-fork out** (decided): remove from the product; the game-side mod exposes generic tools via `execute_game_tool` instead. |
| C5 | Stale hardcoded `d:/` IPC path | `factions.ts:54`, `psychology.ts:28` | Already chipped (task_06612997). Moot if C4 drops them; otherwise route via `workspaceRoot()` like `gameIpc.ts`. |
| C6 | Default modlist name `RimSynapse-Test` | `harness/modlist.ps1:20` | Configurable default. |
| C7 | Product identity: name `rimsynapse-mcp`, README, server name | `manifest.json`, `README.md`, `index.ts` | Rename to the toolkit product; write modder-facing docs. |

**Already generic (no change):** `resolve_mod_load_order`, `list_installed_mods`,
`get_mod_metadata`, `configure_active_mods`, `read_rimworld_log`, `runTestCycle`,
`launch_rimworld`, and `lib.ps1`'s mod-discovery helpers.

**Progress:** C1 ✅ (discover mods in `rimworldDev.ts`, parity-verified). C2/C3 ✅
(`lib.ps1` derives build order by matching csproj `<Reference>` DLL names to each mod's
`<AssemblyName>`, topo-sorted; `build.ps1` builds a repo's transitive deps first — all
constraints verified against the RimSynapse workspace). C6 ✅ (`RS_MODLIST_NAME` env).
**Behavior change:** the derived build now includes any compiled mod (e.g. `LLM-Trainer`,
which the old hardcoded list skipped); exclude with `RS_BUILD_EXCLUDE=Name1,Name2`.
Remaining: C4 (hard-fork narrative tools), C5 (chip), C7 (identity/rename).

## Game-side fork line (mapped from Core/Source)

**IPC contract:** `tool_input.json` `{ "name", "arguments": {…} }` → `tool_output.json`
(raw JSON result; errors `{ "error": "…" }`). Path resolves from `RIMSYNAPSE_ROOT/Core`
then the mod's own `Content.RootDir` — **not hardcoded**. The tool channel routes
*only* through `SynapseToolRegistry.ExecuteTool`, which is the clean seam. Tools are
`GameTool` POCOs registered by explicit `RegisterXxxTools()` calls; **companion mods
can `RegisterTool(...)` at runtime** (so a modder can register their own tools — a
product feature). Only hard dep: Harmony. Targets .NET 4.8 + Newtonsoft.

**KEEP (drop-in, zero refactor):** `SynapseToolRegistry`, `SynapseToolIndex`,
`SynapseScriptValidation`, `SynapseScriptRunner`, `SynapseResultStore`; tools
`MetaTools`, `ResultTools`, `ColonistTools`, `MoodTools`, `StockpileTools`,
`ThreatTools`, `SearchTools`, `DefinitionTools`, `PawnStateTools`, `IncidentTools`,
`DebugActionTools`; the `tool_input`/`tool_output` poll block + `ToolRequest` + the
`ScriptingDir` resolver.

**DROP (narrative — hard-fork):** tools `PossessionTools`, `HackingTools`,
`BreakTools`, `CombatTools`; GameComponent `script_input`/`storyteller_input`
channels, pause-time opportunistic firing, tier/VRAM checks, possession/hacking
ticks; the whole LLM/context stack (`RimSynapseAPI`, `SynapseClient`,
`SynapseLlmPlanner`, `SynapseContext*`, `Internal.*`, `SynapseTierController`,
`VramAdvisor`) and managers `SynapsePossessionManager`, `SynapseObjectControlManager`.

**MUST-REFACTOR to compile standalone (7 seams):**
1. Replace `SynapseLogger` with a thin `Log.Message` wrapper.
2. Strip `SynapseGameComponent` to: main-thread queue + `PollScriptInputFile` (tool
   channel only) + `ScriptingDir`.
3. Rename the `RIMSYNAPSE_ROOT` env var → toolkit's own; repoint the RootDir fallback.
4. `EnvironmentTools` — stub out ~8 `SynapseObjectControlManager` hack-status fields.
5. `ObjectStateTools` — replace `SynapseObjectControlManager.LockedDoors` with a local
   `HashSet<int>` (or drop the lock action).
6. New minimal `Mod` entry: Harmony `PatchAll` + `SynapseToolRegistry.EnsureInitialized()`.
7. `EnsureInitialized` — delete the narrative `Register*`/`MarkMutating` lines.

## Workstreams & sequencing

- **W1 — Decouple mod discovery (C1–C3, C6).** Foundational; makes the dev loop work
  for any mod. In-repo TS + PowerShell, testable against the RimSynapse workspace
  (must yield the same mods/order it does today = the parity check). **Start here.**
- **W2 — Fork the game-side bridge (C4 fork line).** New in-repo mod folder; strip
  narrative + LLM; compile standalone; symlink-install. Depends on the Explore map.
- **W3 — Kill RimSynapse assumptions (C4, C5).** Drop faction/psychology tools from
  the product surface (or gate them behind a "RimSynapse profile").
- **W4 — Public contract, packaging, identity (C7).** Define the stable generic tool
  surface, symlink dev-install flow, rename product, prep a Workshop listing + docs.
- **W5 — Agent SDK app (was A1).** Now targets a config-discovered mod, not RimSynapse.

## Definition of done (v1)

A developer clones this repo, points it at *their* mod folder, symlinks the game-side
toolkit mod into `Mods/`, and Claude can: discover their mod, resolve its load order,
deploy it, launch RimWorld, run the test cycle, read the classified log, and invoke
generic in-game dev tools — with **zero RimSynapse-specific code paths** touched.

## Open questions

1. **Build-order source of truth** — csproj `<ProjectReference>` graph (accurate for
   assemblies) vs About.xml load order (accurate for RimWorld runtime)? Likely csproj
   for build, About.xml for the deployed load order. Confirm they can differ.
2. **Multi-mod vs single-mod target** — does a user develop one mod or a workspace of
   several? (Harness already supports both layouts.)
3. **Keep a "RimSynapse profile"?** so archdukejim's existing workflow still works
   after genericization (the narrative tools behind a flag), or hard-fork them out.
