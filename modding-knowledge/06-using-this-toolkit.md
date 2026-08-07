# Driving this toolkit (the agent's workflow)

This toolkit gives an AI agent the MCP tools to develop, deploy, run, and evaluate a
RimWorld mod, plus a bridge into the running game. The typical loop:

## 1. Understand the target mod(s)

- `list_installed_mods` — everything RimWorld can see (local, Workshop, DLC), with
  packageId + source + folder.
- `get_mod_metadata { packageId }` — a mod's About.xml: versions and all ordering /
  dependency / incompatibility declarations. Use it to place a new/unknown mod.
- `query_modding_docs` — this knowledge base (structure, Defs, patches, C#, load order).

## 2. Resolve & apply load order

- `resolve_mod_load_order { mods }` — topologically sorts by declared
  loadAfter/loadBefore/modDependencies and returns `{ resolved, ambiguous, cycles,
  uninstalled }`. Resolve the `ambiguous` entries with judgment (read their metadata),
  then treat `resolved` as the order.
- `configure_active_mods { activeMods }` — writes the resolved order to
  `ModsConfig.xml` (official block first, then dependency-sorted).

## 3. Build & deploy

- `deploy_rimworld_mods { mods? }` — compiles each mod's C# (`Source/`) and packages
  clean files into the RimWorld `Mods/` folder. Omit `mods` to do all discovered mods.
  (During development, a symlink from `Mods/<mod>` to the source folder also works.)

## 4. Launch & test

- `launch_rimworld { savedatafolder?, quicktest?, ... }` — launches an isolated dev
  instance (own save/prefs/log via `-savedatafolder`), muted, dev-mode on.
- `launch_quicktest` — jump straight into a generated test map.
- `run_rimworld_tests { repo?, savedatafolder? }` — full cycle: build in dependency
  order → launch with the in-game TestRunner → classify the log → PASS/FAIL. The
  build/launch config is pinned to the folder you pass, so configure the modlist first.

## 5. Read results

- `read_rimworld_log` — triaged `Player.log`: exceptions, Harmony patch failures,
  XML/Def errors, missing dependencies, version warnings, and any test PASS/FAIL.
  Pass `raw:true` for an unfiltered tail. **Read this after every run** — "did it load
  and pass" is rarely answerable from a screenshot.

## 6. Inspect / act on the running game (the tool bridge)

The game-side toolkit mod exposes in-game dev tools over a file bridge:

- `list_game_tools { query? }` — discover the available in-game tools (spawn/inspect
  defs, fire incidents, dump pawn/object/map state, run debug actions). Mods can
  register their own tools, so this list grows dynamically.
- `execute_game_tool { tool_name, arguments }` — run one. Examples: look up a def with
  `search_game_definitions`, fire an incident with `fire_incident`, run a vanilla/DLC
  debug action (these are reflected automatically), or dump colony state.

Prefer this data bridge over screen automation: query the game for facts, decide, and
call a tool — don't drive menus by pixel unless there is no data/tool path.

## Performance is a GATE — measure impact on every playtest

"How much does my mod slow the game" is one of the first things players judge, so **every in-game
playtest must end with a performance pass**: measure tick rate on standardized scenarios and report
the impact vs. a baseline. Don't skip it, and don't eyeball it from a screenshot — report the number.

The toolkit ships its own profiler + benchmark harness (no Dubs Performance Analyzer dependency),
exposed as game tools via `execute_game_tool` plus host-side baseline tools:

**Snapshot / method profiling**
- `perf_tick_stats` — always-on snapshot: game-tick time (avg/p95/max ms), TPS actual-vs-target with
  a `keepingUp` flag, frame time/FPS, GC pressure. Read-only. First stop for "is it lagging, and is
  it the sim or the renderer?".
- `perf_watch { methods, type? }` → `perf_report { top?, reset? }` → `perf_clear` — profile specific
  methods (`Namespace.Type:Method` or a whole `Namespace.Type`). `perf_report` ranks by **msPerTick**
  (how much of each tick a method eats). Use this to find *which* of your methods is hot.

**Standardized benchmark (the gate)**
- `perf_scenario_build { biome, maturity, newMap?, seed? }` — build a reproducible scenario: a live
  map with a deterministic, seeded colony load. `maturity` is `early` or `late`; `newMap:true`
  force-generates the biome (e.g. `TropicalRainforest`, `Tundra`), else it populates the current map.
- `perf_benchmark_start { warmupTicks?, measureTicks? }` → poll `perf_benchmark_status` until
  `phase:"done"` → standardized result (avg/p95/p99 ms/tick, TPS, GC, map summary).
- `perf_baseline_save { scenarioId, result, fingerprint }` / `perf_baseline_list` — store a baseline
  **once** (captured with your mod OFF), keyed by scenario + fingerprint (game version + other mods).
- `perf_impact { scenarioId, result, fingerprint }` — compare a mod-ON result to the baseline →
  tick-time delta + verdict (none/negligible/minor/moderate/heavy). This is the impact number.

### The performance gate procedure (run it every playtest)

1. Pick scenarios: the standard matrix is `{TemperateForest, TropicalRainforest} × {early, late}`.
   Add a biome/maturity that best stresses whatever the mod does (heavy tick logic → `late`).
2. **Baseline (once per scenario+fingerprint):** with the mod-under-test OFF (`configure_active_mods`
   without it, relaunch), `perf_scenario_build` → `perf_benchmark_start`/`status` → `perf_baseline_save`.
   Reuse it forever after — `perf_baseline_list` shows what you already have; only recapture when the
   game version or the other active mods change (`perf_impact` flags a stale fingerprint).
3. **Test:** with the mod ON, build the SAME scenario (same biome+maturity+seed), **place the mod's
   new objects on the map in quantity** (spawn many of them so their tick cost shows), then
   `perf_benchmark_start`/`status`.
4. `perf_impact` → report: "Impact on <scenario>: <verdict> (+X ms/tick, Y% slower)." Do this for each
   scenario. A `moderate`/`heavy` verdict is a finding — use `perf_watch`/`perf_report` to locate the
   hot method and optimize.

> **You execute this — it is a two-launch sequence, not one call.** Loading or unloading a mod
> requires a RimWorld restart, so measuring impact means running the game **twice** and you drive
> both runs yourself; there is no single tool that does the whole matrix. Explicitly:
>
> **Baseline run (only if `perf_baseline_list` has no fresh entry for this scenario+fingerprint):**
> `configure_active_mods` with a list that EXCLUDES the mod-under-test → `launch_rimworld` (or
> `run_rimworld_tests`) → `perf_scenario_build` → `perf_benchmark_start`/`status` → `perf_baseline_save`.
>
> **Test run (every playtest):** `configure_active_mods` INCLUDING the mod-under-test (kept last) →
> `launch_rimworld` → `perf_scenario_build` (same biome+maturity+seed) → place the mod's new objects →
> `perf_benchmark_start`/`status` → `perf_impact`.
>
> Do not report a playtest as complete until you have run the test leg and produced a `perf_impact`
> verdict. If a fresh baseline already exists, skip the baseline run and reuse it.

### Designing maps to exercise NEW objects

When the mod adds new content, design the test to actually run it:
- **Which biome:** pick the one the object interacts with (a jungle-plant mod → `TropicalRainforest`;
  a cold-weather mechanic → `Tundra`). Use the control (`TemperateForest`) plus that one.
- **Which maturity:** `late` for anything with per-tick logic (comps, hediffs, map components) — a
  big colony surfaces cost that an early colony hides.
- **Place the objects:** after `perf_scenario_build`, spawn many instances of the new thing/pawn/comp
  (use the spawn/`execute_game_tool` tools) so the benchmark measures them, not an empty map. The
  impact = benchmark with your objects placed − the baseline scenario without them.

## Finding the right game API (don't guess — look it up)

When you need a C# type/method (for a Harmony patch or custom behavior) or the right defName,
**use both sources and combine them** — one covers code, the other covers data:

- `search_game_api { query }` — the C# API corpus (types, methods, fields). Great when the
  concept is in the naming ("weather" → `WeatherManager`, "raid" → `IncidentWorker_Raid`).
- `search_game_definitions` (in-game, via `execute_game_tool`) — the **Def** database. Many
  concepts live here, not in the API: e.g. "berserk" is a `MentalStateDef` named `Berserk`,
  not a method.

**Always pair them for "how do I make X happen" questions.** Example — "make a pawn go
berserk": `search_game_definitions("berserk")` → `MentalStateDef Berserk`; `search_game_api
("MentalState")` → `Pawn_MindState`/`MentalStateHandler.TryStartMentalState(def)`. Combine:
`pawn.mindState.mentalStateHandler.TryStartMentalState(MentalStateDefOf.Berserk, ...)`.
Neither source alone gives the whole answer; you reason across both.

**Navigating type relationships (`query_api_graph`).** `search_game_api` finds types by text; the
graph answers structural questions it can't: `query_api_graph { type, relation }` gives a type's
`ancestors` (inheritance chain — `Pawn` → `ThingWithComps` → `Thing`), `subclasses` (what extends
it — `Verb` → `Verb_LaunchProjectile`, …), `returns` (what yields/exposes this type — `Hediff` →
`HediffMaker.MakeHediff`, `HediffSet.GetFirstHediffOfDef`), plus `uses`/`usedby`. Use it after a
search to find the right base class's inherited members, enumerate what you can subclass, or locate
the method that hands you the object you need.

**Setup (once):** `dump_game_api` (in-game, dumps ~9k types) → `enrich_api_corpus` (a frontier
model writes a one-line description per type, so search matches on concept not just identifier) →
`build_api_index` (embeds it) → `build_api_graph` (extracts inheritance + member-type edges for
`query_api_graph`). The enrich step needs an Anthropic key — run `set_anthropic_key` once (it opens
a small window to paste the key into; stored locally, no restart, never shown in chat), or set
`ANTHROPIC_API_KEY` in the server env. The enrich step is what makes concept queries like "rampage"
find `MentalStateHandler`; skip it and search falls back to keyword-ish matching on bare names.
Re-run the chain when the mod set (and thus the API surface) changes.

## The golden loop

`query_modding_docs` (how) → edit Defs/patches/C# → `deploy_rimworld_mods` →
`run_rimworld_tests` → `read_rimworld_log` → inspect with `execute_game_tool` →
**performance gate** (`perf_scenario_build` → `perf_benchmark` → `perf_impact` vs baseline) →
fix → repeat. Load order via `resolve_mod_load_order` whenever the mod set changes. The performance
gate runs on every playtest — a functional pass isn't a full pass until you've reported tick impact.
