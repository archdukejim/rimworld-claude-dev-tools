# Agent Handoff — mod-dev session (2026-08-09)

Written by the **mod-dev agent** so a single agent can absorb this work when the two concurrent
sessions on this workspace are collapsed. Read this top-to-bottom before continuing; it covers what
changed, what to know, and where the loose ends are.

---

## 1. TL;DR

This session shipped **four capability areas** to the toolkit. All are built, validated headlessly,
committed, and pushed.

| Area | What you can now do |
|---|---|
| **Mod hard-dependency enforcement** | `configure_active_mods` auto-activates installed `<modDependencies>` and errors on missing ones; `resolve_mod_load_order` / `detect_mod_conflicts` report `missingDependencies`. |
| **Launch first-pass env check** | `launch_rimworld` reports the active modlist + a triaged startup `Player.log` right after launch, so a broken test env is caught immediately. |
| **Generic debug-action bridge** | `list_debug_actions` + `run_debug_action` invoke **any** mod's `[DebugAction]` headlessly (over all loaded assemblies), no per-mod wiring. |
| **Self-describing windows** | `read_window` + `invoke_window_control`, and window-changing commands **auto-attach** the resulting window's buttons/labels/checkboxes to their receipt. |

---

## 2. Git state (do not re-do this)

- **Branch:** `feat/set-github-token-paste`
- **My commit:** `39a6057` — *"feat(toolkit): mod-dependency enforcement, launch env-check, generic debug-action + window-capture bridges"* (12 files). **Pushed** to `origin`.
- **Parents** `fd599bd` (auth/rimsort keyring + RimSort noise) and `ac70e5f` (`set_github_token`) are the **other agent's already-committed work** — I did not touch them. Their source (`auth.ts`, `keystore.ts`, `config.ts`, `rimsort.ts`, `apiSearch.ts`, the CLAUDE.md GitHub-auth docs, manifest v1.2.0) is committed baseline.
- **Working tree: clean.** Full 18-mod list restored in `ModsConfig`; test game closed.

My commit only touches my files; there is nothing entangled to untangle (verified via `git diff fd599bd 39a6057`).

---

## 3. Files changed this session

- `server/src/tools/testing.ts` — hard-dependency logic (`modHardDependencies`, `findMissingDependencies`, `withInstalledDependencies`), wired into `configure_active_mods` / `resolve_mod_load_order` / `detect_mod_conflicts`.
- `server/src/tools/rimworldDev.ts` — `firstPassEnvironmentCheck()`, shared `resolvePlayerLogPath()`, `launch_rimworld` calls the check.
- `server/src/tools/gameIpc.ts` — `ipcDir()` routing + `maybeAttachWindow()` (self-describing receipts).
- `game-mod/Source/Comps/Tools/DebugActionTools.cs` — `list_debug_actions` / `run_debug_action` (generic, all-assembly).
- `game-mod/Source/Comps/Tools/WindowContentTools.cs` — **new**: Harmony capture layer + `read_window` / `invoke_window_control`.
- `game-mod/Source/Comps/SynapseToolRegistry.cs` — registers the two new tool groups.
- `modding-knowledge/04-csharp-and-harmony.md`, `CLAUDE.md`, `manifest.json` — docs (incl. the debug-validation gate).
- `server/build/tools/{gameIpc,rimworldDev,testing}.js` — compiled output (build/ is git-tracked).

---

## 4. Architecture you MUST know

### 4.1 The bridge routing (most important)
- The **toolkit game mod `archdukejim.rimagentic`** is the **canonical dev bridge**. Its
  `SynapseGameComponent.ScriptingDir` defaults to `%LOCALAPPDATA%\RimAgentic\ipc` (honors
  `RIMAGENTIC_IPC_DIR`). It force-loads **last**, so its reflection scan sees every other mod.
- The MCP (`gameIpc.ts` `ipcDir()`) now defaults to that **same** `%LOCALAPPDATA%\RimAgentic\ipc`
  channel. So the bridge works with zero config **as long as `archdukejim.rimagentic` is in the active modlist.**
- RimSynapse `Core` carries a **separate, forked** bridge that polls `<RIMSYNAPSE_ROOT>/Core`. That is
  Core's own channel, not the generic one.
- **GOTCHA:** do **not** junction `%LOCALAPPDATA%\RimAgentic\ipc` → `Core`. If both mods are active,
  that collapses them onto one folder and they **race** to consume each request (calls intermittently
  hit the wrong registry → "Tool not found"). Keep the channels separate. Remove such a junction with
  `cmd /c rmdir` (link only — never `Remove-Item -Recurse`, which deletes the target).

### 4.2 MCP server rebuild
After editing anything under `server/src/`, run `npm run build` **and kill the running
`node build/index.js`** so the host respawns it on the new build. There are often multiple server
instances — kill all matching `*rimworld-claude-dev-tools*index.js*`, or a stale one answers on old code.

### 4.3 Session contention (the thing you're collapsing)
Two concurrent agents shared **one** RimWorld instance and **one** `C:/RimWorldDevData` config. A
`harness/launch.ps1 -Test` run from one session killed the other's game mid-validation. Collapsing to a
single agent fixes this. If you ever see a surprise `-synapse-test` launch you didn't start, that's the
symptom.

### 4.4 TestRunner quits the game
`rimsynapse.testrunner` (in the full modlist) runs its suite on quicktest and then **shuts the game
down**. For interactive/UI validation, launch a **minimal modlist** (harmony + rimworld + DLCs +
`archdukejim.rimagentic`) — no TestRunner, and vanilla world-gen is fast. `RegionsAndTerritories` makes
full-list world-gen slow (>180s).

### 4.5 Debug-command validation gate (now mandatory — see CLAUDE.md)
Any new mechanic is **not done** until a debug command has exercised it and confirmed intent. Build a
`[DebugAction]`, then trigger it headlessly via `run_debug_action` (or `execute_game_tool`), and read the
result/log. This is a definition-of-done gate alongside the UI-testing protocol.

---

## 5. How I validate (process to keep)

- **Positive + negative, headless.** Every UI/behavior change gets ≥1 positive and ≥1 negative case run
  through the game via the bridge tools, plus a clean `read_rimworld_log`. Example from this session
  (window capture): open Options → `read_window` shows buttons/checkboxes → `invoke_window_control "OK"`
  → dialog closes (`found:false`); negative: bogus label → `success:false` + available list.
- **Verify against source, not memory.** For game-internal signatures (e.g. `Widgets` overloads) I
  decompiled `Assembly-CSharp` with `ilspycmd` (needs `DOTNET_ROLL_FORWARD=Major`) rather than guessing.
- **Build commands:**
  - MCP: `cd server && npm run build` (Node at `C:\Program Files\nodejs`).
  - Game mod: `cd game-mod/Source && dotnet build -c Release`. The mod is symlinked into
    `RimWorld/Mods/RimAgentic`, so the built DLL is live without a separate deploy.

---

## 6. New tools — quick reference

- `list_debug_actions {query?, includeVanilla?}` — enumerate `[DebugAction]`s across all mods (name, category, signature).
- `run_debug_action {name, category?, pawnName?, x?, z?}` — invoke one; dispatches on signature (no-arg / pawn / cell).
- `read_window {windowType?}` — topmost real dialog's buttons/checkboxes/radios/labels + rects (skips transient `ImmediateWindow`).
- `invoke_window_control {label?|index?, windowType?}` — press a control by name/index, no coordinates.
- After `open_window` / `activate_gizmo` / `invoke_window_control`, the MCP auto-attaches the new window as `{result, window}`.

All are reachable via `execute_game_tool` and require `archdukejim.rimagentic` active as the bridge.

---

## 7. Persisted memory (shared project memory)

These files in the project memory dir capture the durable facts — read them for detail:
`rimagentic-bridge-architecture`, `debug-actions-for-every-mechanic`, `window-capture-feature`,
`mcp-server-rebuild-gotcha`, `mod-resolution-gotchas`, `ui-testing-protocol`, `headless-map-testing`.

---

## 8. Loose ends / open items

- **`search_issues` doesn't reliably honor `repo:`** (documented in CLAUDE.md) — pre-existing bug, not mine.
- **`run_rimworld_tests` can run a stale binary** (builds to `<repo>/Assemblies` but doesn't redeploy) — deploy first.
- Window capture currently invokes **buttons/radios** by label (force-click). **Checkboxes** are read
  (with state) but not yet toggled by `invoke_window_control` — coordinate-click via the returned rect
  still works. Natural next enhancement if needed.
- Nothing is mid-flight from my side; the branch tip is clean and pushed.
