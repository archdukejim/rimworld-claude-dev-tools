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

**Setup (once):** `dump_game_api` (in-game, dumps ~9k types) → `enrich_api_corpus` (a frontier
model writes a one-line description per type, so search matches on concept not just identifier) →
`build_api_index` (embeds it). The enrich step needs an Anthropic key — run `set_anthropic_key`
once (it opens a small window to paste the key into; stored locally, no restart, never shown in
chat), or set `ANTHROPIC_API_KEY` in the server env. The enrich step is what makes concept
queries like "rampage" find `MentalStateHandler`; skip it and search falls back to keyword-ish
matching on bare names. Re-run the trio when the mod set (and thus the API surface) changes.

## The golden loop

`query_modding_docs` (how) → edit Defs/patches/C# → `deploy_rimworld_mods` →
`run_rimworld_tests` → `read_rimworld_log` → inspect with `execute_game_tool` →
fix → repeat. Load order via `resolve_mod_load_order` whenever the mod set changes.
