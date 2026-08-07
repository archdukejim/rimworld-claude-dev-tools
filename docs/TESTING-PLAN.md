# RimAgentic — Post-Restart Testing Plan

A comprehensive, ordered checklist to verify everything built this session, live. Most pieces were
unit-tested offline as they were built; this plan re-confirms them **through the real MCP server and a
running game**, which is the part that couldn't be tested without a restart.

Legend: **[offline]** no game needed · **[game]** needs RimWorld running · **[steam]** needs a Steam
login + browser · ✅ = expected pass criteria.

---

## Phase 0 — Restart & activate (do these first)

1. **Quit and reopen Claude Code** (fully quit, not just the window). This surfaces every new MCP tool
   added this session. ✅ In a new session, these tool names resolve: `build_api_graph`,
   `query_api_graph`, `build_def_corpus`, `search_defs`, `validate_mod_defs`, `register_corpus`,
   `index_corpus`, `search_corpus`, `graph_corpus`, `query_corpus_graph`, `list_corpora`,
   `capture_workshop_image`, `make_workshop_image`, `list_workshop_images`, `compose_workshop_bbcode`,
   `perf_baseline_save`, `perf_baseline_list`, `perf_impact`.
2. **Reload the extension** at `chrome://extensions` (Steam Workshop Helper → reload). ✅ Version reads
   **0.3.1** and the popup shows the **"Serve the MCP bridge from this profile"** toggle.
3. **Launch RimWorld into a test map** (for [game] phases): `launch_quicktest`, or
   `launch_rimworld { quicktest: true }`. ✅ A test colony/map loads and `read_rimworld_log` is clean.

---

## Phase 1 — API knowledge & graph **[offline]**

The corpus is already built + enriched (9,047 types) and the graph built; re-confirm through the server.

| Step | Call | ✅ Expect |
|---|---|---|
| 1.1 | `search_game_api { query: "make a pawn go berserk" }` | Hits include `MentalStateHandler` / `MentalState_Berserk`; `retrieval: "hybrid"` |
| 1.2 | `query_api_graph { type: "Pawn", relation: "ancestors" }` | `["Verse.ThingWithComps","Verse.Thing","Verse.Entity"]` |
| 1.3 | `query_api_graph { type: "Verb", relation: "subclasses" }` | ~15 direct (`Verb_LaunchProjectile`, `Verb_CastAbility`, …) |
| 1.4 | `query_api_graph { type: "Hediff", relation: "returns" }` | Members incl. `HediffMaker.MakeHediff`, `HediffSet.GetFirstHediffOfDef` |
| 1.5 (only if re-enriching) | `set_anthropic_key` (no args) | A Windows paste window appears; pasting stores the key, no restart |

If the graph is missing (fresh machine): run `build_api_graph` first (needs the corpus from `dump_game_api`).

---

## Phase 2 — Offline Def corpus **[offline]**

| Step | Call | ✅ Expect |
|---|---|---|
| 2.1 | `build_def_corpus` | `total` ≈ 13,756; modules include Core/Royalty/Ideology/Biotech/Anomaly/Odyssey |
| 2.2 | `search_defs { query: "go berserk" }` | `MentalStateDef Berserk` (+ AbilityDef/MentalBreakDef Berserk) |
| 2.3 | `search_defs { query: "luciferium", defType: "ThingDef" }` | `ThingDef Luciferium` |
| 2.4 | `search_defs { query: "mechanoid raid", defType: "IncidentDef" }` | `IncidentDef RaidEnemy` |

---

## Phase 3 — Corpus registry **[offline]**

| Step | Call | ✅ Expect |
|---|---|---|
| 3.1 | `register_corpus { name: "defs", recordsPath: "<%LOCALAPPDATA%>/RimAgentic/defs/def-corpus.jsonl", idField: "id", textFields: ["defName","name","label","description","defType"] }` | `count` ≈ 13,756 |
| 3.2 | `list_corpora` | `defs` listed with the idField/textFields |
| 3.3 | `search_corpus { name: "defs", query: "go berserk" }` | Result ids include `Berserk` |
| 3.4 | `graph_corpus { name: "defs", edges: [{ relation: "extends", field: "parent" }] }` | `edgeSourceCounts.extends` ≈ 4,097 |
| 3.5 | `query_corpus_graph { name: "defs", node: "<an abstract base, e.g. from a subclasses lookup>", relation: "extends", direction: "reverse" }` | The concrete defs that inherit from it |
| 3.6 (optional, ~10 min) | `index_corpus { name: "defs" }` then `search_corpus { name: "defs", query: "a pawn that has lost its mind" }` | `retrieval: "hybrid"`; berserk/mental-break defs surface semantically |

Also sanity-check a **custom** corpus: `register_corpus { name: "notes", records: [{id:"a", text:"..."}] }` → `search_corpus`.

---

## Phase 4 — Pre-launch Def validation **[offline]**

| Step | Call | ✅ Expect |
|---|---|---|
| 4.1 | `validate_mod_defs { path: "<your mod folder>" }` | `filesChecked` > 0; malformed XML (if any) with file+line; class refs resolved core/local |
| 4.2 (negative test) | Temporarily typo a class in a Def (e.g. `<thingClass>Verse.Buildng</thingClass>`), re-run | The typo appears under `classRefs.unresolved`; revert after |
| 4.3 | Introduce a malformed XML tag, re-run | `xmlErrors` reports the file + line; `ok:false`; revert after |

---

## Phase 5 — In-game bridge & game-side tools **[game]**

| Step | Call | ✅ Expect |
|---|---|---|
| 5.1 | `list_game_tools` | Includes the new `perf_tick_stats`, `perf_watch`, `perf_report`, `perf_clear`, `perf_benchmark_start`, `perf_benchmark_status`, `perf_scenario_build` |
| 5.2 | `get_open_windows` | Lists open windows with type/rect |
| 5.3 | `execute_game_tool { tool_name: "search_game_definitions", arguments: { query: "berserk" } }` | Live def lookup returns Berserk |
| 5.4 | `execute_game_tool { tool_name: "get_map_environment" }` | Biome/weather/map summary |

If the `perf_*` game tools are absent from 5.1, RimWorld loaded an **old** `RimAgentic.dll` — the mod
must be rebuilt + the game relaunched (the DLL is symlinked, so `dotnet build` then relaunch).

---

## Phase 6 — Performance harness **[game]**

| Step | Call | ✅ Expect |
|---|---|---|
| 6.1 | `execute_game_tool { tool_name: "perf_tick_stats" }` | tick avg/p95 ms, TPS actual-vs-target + `keepingUp`, frame/FPS, GC |
| 6.2 | `execute_game_tool { tool_name: "perf_scenario_build", arguments: { maturity: "late" } }` | Populates the current map; returns scenarioId + added colonists/animals/items |
| 6.3 | `execute_game_tool { tool_name: "perf_benchmark_start", arguments: { warmupTicks: 200, measureTicks: 1000 } }` then poll `perf_benchmark_status` | Progresses warmup→measure→**done**; result has tickMs avg/p95, TPS, GC, map |
| 6.4 | `perf_baseline_save { scenarioId, result: <the benchmark result>, fingerprint: "rw1.6+core" }` then `perf_impact { scenarioId, result: <same>, fingerprint }` | Impact verdict ~`none/negligible` (same result vs itself) |
| 6.5 | `perf_watch { methods: ["Verse.Pawn:Tick"] }` (via execute_game_tool) → let it run → `perf_report` | `Verse.Pawn:Tick` shows calls + msPerTick; `perf_clear` after |
| 6.6 (biome map) | `perf_scenario_build { biome: "TropicalRainforest", maturity: "late", newMap: true }` | Generates/forces a jungle map and populates it (watch for the note if biome override didn't take) |

Full impact loop (mod off vs on) is the two-launch sequence in `06-using-this-toolkit.md`; 6.4 just
confirms the store/verdict mechanics.

---

## Phase 7 — Workshop images **[offline] / [steam]**

| Step | Call | ✅ Expect |
|---|---|---|
| 7.1 [game] | Bring RimWorld to the foreground, then `capture_workshop_image { name: "page1" }` | A JPEG saved under `%LOCALAPPDATA%/RimAgentic/workshop-images`; returns dims |
| 7.2 | `make_workshop_image { source: "<any png>", name: "page2", maxWidth: 1000 }` | Scaled JPEG produced |
| 7.3 | `list_workshop_images` | Lists the produced JPEGs with dims/bytes |
| 7.4 | `compose_workshop_bbcode { images: [{url:"https://steamuserimages-a.akamaihd.net/ugc/AAA.jpg", caption:"Overview"}] }` | Returns `[img]…[/img]` BBCode |
| 7.5 [steam] | Full `/rimagentic:workshop-images <fileId>` workflow (upload via Claude-in-Chrome → embed) | Only with a Steam login + an item you own; **confirm before publishing** |

---

## Phase 8 — Extension bridge toggle **[steam/browser]**

| Step | Action | ✅ Expect |
|---|---|---|
| 8.1 | Open the extension popup | The bridge toggle is visible with a state hint |
| 8.2 | In your **everyday** browser profile, turn the toggle **off** | Hint updates to "off here"; that profile stops polling 8766 |
| 8.3 | In the **dedicated** profile, leave it **on** | Exactly one profile serves the bridge; `swh_*` tools work without races |

---

## Reporting

For each phase, note pass/fail and paste the actual result for any failure. Known dependencies to have
ready: the API corpus + graph (Phase 1), a running game (5, 6, 7.1), a mod folder (4), a Steam login
(7.5, 8). Start at Phase 0 and go in order — later phases assume the earlier setup.
