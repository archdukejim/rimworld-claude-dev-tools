---
description: Set up RimAgentic in the current mod project — build the tools, install the game mod (loaded last), write project instructions, and verify the bridge.
argument-hint: "[path to RimWorld install, optional]"
allowed-tools: Bash, Read, Write, Edit, mcp__rimagentic__list_installed_mods, mcp__rimagentic__get_mod_metadata, mcp__rimagentic__configure_active_mods
---

You are setting up the **RimAgentic** toolkit so this Claude Code session can develop
RimWorld mods end-to-end. The plugin files live at `${CLAUDE_PLUGIN_ROOT}`. Work through
these steps, reporting what you did; stop and ask only if a step genuinely can't proceed.

## 1. Locate the RimWorld install
Use `$1` if the user passed a path. Otherwise probe the common locations and pick the one
that has `RimWorldWin64.exe`:
- `C:\Program Files (x86)\Steam\steamapps\common\RimWorld`
- `C:\GOG Games\RimWorld`
Record it as `$RW`. If none exist, ask the user for their RimWorld folder and stop.

## 2. Build the game-side mod
- If `${CLAUDE_PLUGIN_ROOT}/game-mod/Source/GamePath.props` is missing, copy it from
  `GamePath.props.template` and set `<RimWorldPath>` to `$RW` (leave the Steam workshop /
  Harmony paths as-is unless the user's differ).
- Build it: `dotnet build "${CLAUDE_PLUGIN_ROOT}/game-mod/Source/RimAgentic.csproj" -c Release --nologo`.
  Confirm `game-mod/Assemblies/RimAgentic.dll` was produced.

## 3. Install the game mod into RimWorld (loaded last)
- Symlink `${CLAUDE_PLUGIN_ROOT}/game-mod` → `$RW\Mods\RimAgentic` (remove any existing
  entry first). On Windows: `New-Item -ItemType SymbolicLink`. If symlink creation is denied
  (no admin / dev mode), fall back to copying the folder, and tell the user a symlink would
  keep it live-updating.
- The mod must load **last** so its startup scan sees every other mod. `configure_active_mods`
  already forces `archdukejim.rimagentic` to the end of the order.

## 4. Build the MCP server if needed
If `${CLAUDE_PLUGIN_ROOT}/server/build/index.js` is missing, run
`npm run build` in `${CLAUDE_PLUGIN_ROOT}/server` (Node required).

## 5. Write project instructions
If the current project has no `CLAUDE.md` (or it lacks a RimAgentic section), create/append
one teaching the workflow. Use this content (adjust the intro to the user's mod if known):

```markdown
# CLAUDE.md — RimWorld mod (RimAgentic)

This project uses **RimAgentic**. You are a RimWorld modding agent with the RimAgentic
MCP tools, a game-side tool bridge, and a bundled modding knowledge base.

## Start here
- `query_modding_docs` — how to mod RimWorld (structure, Defs, XML patches, C#/Harmony,
  load order) and how to drive this toolkit. Read `06-using-this-toolkit.md` first.

## The loop
1. Understand the mod set: `list_installed_mods`, `get_mod_metadata`.
2. Author content: edit Defs/XML under `Defs/`/`Patches/`, C# under `Source/`.
3. Load order: `resolve_mod_load_order` (resolve any `ambiguous`/`cycles`), then
   `configure_active_mods` (the RimAgentic mod is forced last automatically).
4. Build + deploy: `deploy_rimworld_mods`.
5. Test in-game: `launch_rimworld` / `run_rimworld_tests`.
6. Read results: `read_rimworld_log` (classified triage) after every run.
7. Inspect the running game: `list_game_tools` then `execute_game_tool` (e.g.
   `search_game_definitions`, `get_map_environment`, `inspect_csharp_field`).
8. **Performance gate (every playtest):** measure tick impact. `perf_scenario_build` a
   standardized scenario (biome × early/late), place the mod's new objects, run
   `perf_benchmark_start`/`perf_benchmark_status`, and `perf_impact` against the stored baseline
   (captured once with the mod off). Report the verdict (+X ms/tick, Y% slower). A playtest isn't
   complete without it.
9. Fix and repeat.

## Rules
- Don't guess at game API. Use `search_game_api` (C# types/methods) AND
  `search_game_definitions` (Defs) together — many concepts (e.g. "berserk") are a Def,
  not a method. Set up `search_game_api` once: `dump_game_api` (in-game) →
  `enrich_api_corpus` (frontier model adds one-line concept descriptions) → `build_api_index` →
  `build_api_graph` (structural relationships for `query_api_graph`: ancestors/subclasses/returns).
  The enrich step is what makes concept queries hit the right type; it needs an Anthropic key —
  `set_anthropic_key` opens a window to paste one (or set `ANTHROPIC_API_KEY`).
- Performance is a gate, not an afterthought: every in-game playtest ends with a `perf_impact`
  report vs. a stored baseline (see step 8). Reuse baselines across runs; only recapture when the
  game version or the other active mods change.
- Prefer the data/tool path over pixel automation; reserve `pcControl` for in-game
  dialogs with no data path.
- Reversible dev work (build/test/config) is autonomous. Publishing to the Workshop or
  pushing git is propose-then-confirm.
```

## 6. Verify
- `get_mod_metadata` for `archdukejim.rimagentic` → should be `found: true` at the Mods
  path (confirms the install is visible).
- Tell the user: the tools may need one MCP reconnect (restart Claude Code or reconnect the
  `rimagentic` server) to appear in this session, and that `/rimagentic:setup` is idempotent.

Finish with a short summary: RimWorld path, mod install method (symlink/copy), whether the
server/mod built, and any manual step left (e.g. enabling Developer mode for symlinks).
