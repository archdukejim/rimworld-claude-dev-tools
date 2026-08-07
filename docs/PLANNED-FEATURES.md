# Planned Features

A human-readable roadmap for **RimAgentic** (`rimworld-claude-dev-tools`). The
GitHub issue tracker is the live source of truth; this file is a snapshot.
Newest first.

---

## Shipped

Things that are built and in the toolkit today.

### Generic modding-toolkit pivot → RimAgentic
The repo is a distributable, agent-driven RimWorld modding toolkit: a plugin +
MCP server + game-side tool bridge + bundled modding knowledge base, installable
by any modder and driven by Claude Code. Plan: `docs/plans/generic-toolkit-pivot.md`,
`docs/plans/rimagentic-agent-package.md`.

### Mod-introspection connectors (read-only)
`resolve_mod_load_order` (topo-sorts declared `loadAfter`/`loadBefore`/
`modDependencies`, shares the resolver with `configure_active_mods`),
`list_installed_mods`, `get_mod_metadata`, and `detect_mod_conflicts`
(duplicate packageIds, incompatible pairs, load-order cycles).

### Async job broker (was #3)
The test harness is an async job broker: `submit_test_job` returns a `job_id`
immediately; runs execute serially on one worker (build worker + run worker
overlap), with per-job pinned config (own mod list + savedatafolder + rotated
log, verified at launch), git-worktree build isolation, and cancel-mid-run.
Plan: `docs/plans/async-job-broker.md`.

### In-game window mapping
`get_open_windows` reads `Find.WindowStack` and returns each open window's C#
type, id, layer, and on-screen rect — structural UI mapping through the game
itself instead of screenshot-and-guess. (Also the prerequisite for the Workshop
image pipeline below.)

### Content helpers — game-API semantic search (local RAG)
`dump_game_api` (in-game reflection dump of ~9k Assembly-CSharp types) →
`enrich_api_corpus` (a frontier model writes a one-line concept description per
type; key entered via `set_anthropic_key`'s paste window) → `build_api_index`
(local MiniLM embeddings) → `search_game_api` (hybrid semantic + keyword). Lets
the agent find the right C# API by concept, not just identifier. `build_api_graph`
+ `query_api_graph` add a structural layer over the same corpus — inheritance
chains, subclasses, and "what returns/exposes type X" — for relationship
navigation text search can't do. `build_def_corpus` + `search_defs` add the
**content** half: an offline catalog of every game + DLC def (parsed from the
`Data/` folders, no launch), so the agent knows the whole content database before
launching. `validate_mod_defs` lints a mod's Def XML (well-formedness + C# class
refs) pre-launch. A generic **corpus registry** (`register_corpus`, `index_corpus`,
`search_corpus`, `graph_corpus`, `query_corpus_graph`, `list_corpora`) generalizes
this machinery so the agent can turn any structured records into a searchable +
graphable corpus (local embeddings, no key) — mod defs, curated notes, dumps.

### Performance-regression harness
Built-in profiler + benchmark + baseline gate (no Dubs Performance Analyzer
dependency): `perf_tick_stats`, `perf_watch`/`report`/`clear`,
`perf_benchmark_start`/`status`, `perf_scenario_build` (reproducible
{biome}×{early|late} scenarios), and host-side `perf_baseline_save`/`list` +
`perf_impact`. Wired into the playtest procedure as a mandatory gate — every
playtest reports the mod's tick impact vs. a reused baseline.

---

## Open

### Steam Workshop: window → screenshot → JPEG for description embedding  ← building now
[#1](https://github.com/archdukejim/rimworld-claude-dev-tools/issues/1) · `enhancement`

Capture RimWorld content as Steam-Workshop-ready JPEGs so an author can embed
"pages" of visual content and **beat the ~8,000-character description cap**. The
window-mapping prerequisite (`get_open_windows`) now exists; this adds the
capture → scale → JPEG pipeline on top of `pcControl` + `sharp`.

### Steam Workshop: image scaling + embedding polish — **shipped**
[#2](https://github.com/archdukejim/rimworld-claude-dev-tools/issues/2) · `enhancement`

`compose_workshop_bbcode` builds the `[img]` description body from Steam-hosted
image URLs (intro + captions + existing text); the `/rimagentic:workshop-images`
command documents the end-to-end workflow. The upload itself is a Claude-in-Chrome
`file_upload` action (browsers block scripted file inputs; Steam only renders
`[img]` from Steam-hosted URLs), then `swh_update_description` sets the body.

### Orchestrator agent (standalone Claude Agent SDK app)
`enhancement` · **decision pending** · Plan: `docs/plans/orchestrator-agent.md`

An autonomous agent in `agent/` that drives the dev→test→merge loop headlessly.
Largely superseded in practice by the plugin + MCP + docs approach (Claude Code
is the agent today); revisit only if unattended/scheduled runs are wanted.

### Bridge isolation — per-profile "connect to MCP bridge" toggle — **shipped**
`fix`

The extension popup now has a "Serve the MCP bridge from this profile" toggle
(per-profile `swhBridgeEnabled`): off in the everyday browser, on in the
dedicated profile, so exactly one extension polls the loopback bridge (8766) and
they no longer race for commands.

### Auto-orchestrate the performance matrix (follow-on to the perf harness)
`enhancement` · minor

Turn the two-launch perf sequence (mod-off baseline → mod-on test → `perf_impact`)
into a single async job through the broker, instead of the agent driving both
launches by hand.
