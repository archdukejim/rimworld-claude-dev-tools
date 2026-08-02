# Build Plan — Orchestrator Agent (Claude Agent SDK app)

An autonomous agent that drives the RimSynapse dev→test→merge loop, leveraging
the MCP server as its toolset. **Priority shift:** we build the agent first; the
async job broker (issue #3) becomes the agent's *parallel execution backend*,
added once the agent needs concurrency.

Related: [async-job-broker.md](async-job-broker.md) · roadmap `docs/PLANNED-FEATURES.md`.

---

## 1. Division of responsibility (the core principle)

Split by **determinism**, not by "actions vs data":

| Concern | Owner | Why |
|---|---|---|
| Mod config pinning, launch, deploy/build | **Deterministic MCP tools / broker** | Must be exact, verified, repeatable. Write `ModsConfig.xml` > click menus. |
| **Load-order resolution** | **Hybrid** — MCP resolver + agent | Declared order is deterministic; gaps need judgment (see §3). |
| Pulling live game state | **MCP `gameIpc`** | Data, not pixels. |
| Deciding *what* to build/test/merge; sequencing | **Agent** | Judgment. |
| UI navigation | **Agent `pcControl`**, fallback only | Reserved for in-game dialogs/screenshots with no data/config path. |

The agent *decides* "load mods A,B,C in this order," then calls a deterministic
tool to apply it. It does **not** hand-drive the in-game mod menu — that would
reintroduce the non-determinism bugs #18/#19 that the broker plan exists to kill.

## 2. Runtime — Claude Agent SDK app

A standalone app in this repo (TypeScript, to match the server) that connects to
the `rimworld-claude-dev-tools` MCP server as its tool provider and runs the loop
autonomously (can run unattended). Scaffold via the `agent-sdk-dev:new-sdk-app`
skill; verify with `agent-sdk-verifier-ts`.

Proposed location: `agent/` (sibling to `server/`, `harness/`, `extension/`).

## 3. Mod load-order resolution (hybrid)

**Most of this already exists** in `server/src/tools/testing.ts` and is used by
`configure_active_mods` on write:
- `modFolderIndex` — scans `Mods/` + Workshop + `Data/` for `About.xml` → `packageId→folder`.
- `declaredOrdering` — parses `loadAfter` / `loadBefore` / `modDependencies`.
- `orderByDeclaredDependencies` — stable topo-sort; **reports cycles**; preserves
  caller order where declarations are silent.
- `configure_active_mods` puts the official block first (`brrainz.harmony`,
  `ludeon.rimworld`, DLCs) then topo-sorts the tail, and surfaces cycles/uninstalled
  as `notes`.

So the work is **expose it read-only**, not build it. New **read-only MCP connector**
`resolve_mod_load_order`:

- **Input:** a set of packageIds (or, omitted, the current active list from `ModsConfig.xml`).
- **Reuses the exact same ordering code path** `configure_active_mods` writes with —
  critical invariant: *what the agent resolves is what actually loads*. This means
  extracting that ordering block into one shared function both call (a safe,
  no-behaviour-change refactor of `configure_active_mods`).
- **Returns** structured data, not a decision:
  ```jsonc
  {
    "resolved":    ["brrainz.harmony", "ludeon.rimworld", "...topo-sorted tail..."],
    "ambiguous":   [ { "packageId": "new.mod" } ],   // installed, zero ordering metadata → needs judgment
    "cycles":      ["a.mod", "b.mod"],                // from orderByDeclaredDependencies
    "uninstalled": ["missing.mod"]                    // packageId not found in any mod folder
  }
  ```
- **New vs. today:** the `ambiguous` set is surfaced explicitly. Today no-metadata
  mods float silently in caller order; the agent needs to *know* which those are.
- `forceLoadBefore`/`forceLoadAfter` are **not** read by the current path; leaving
  them out of v1 keeps resolver output identical to what gets written. (Future:
  extend `declaredOrdering` to include them — improves the write path too.)
- The **agent** reads this, resolves `ambiguous`/`cycles` with judgment (live data
  or the wiki where useful), then applies via `configure_active_mods` and the run
  is verified at launch (broker Phase 2 verify gate).

## 4. The agent loop (first cut)

```
1. Determine target mod set + branch(es) under test.
2. resolve_mod_load_order → resolve gaps (judgment) → final order.
3. configure_active_mods(order)  [deterministic write]
4. deploy_rimworld_mods(...) / build                     [deterministic]
5. run_rimworld_tests(...)  (later: submit_test_job → poll)  [serial game run]
6. read_rimworld_log + gameIpc data pulls → interpret results.
7. Decide: pass ⇒ propose merge to `development`; fail ⇒ diagnose / iterate.
8. Repeat / fan out (broker enables parallel build+submit later).
```

Steps 3–6 are existing deterministic MCP tools. Steps 1–2, 6–7 are agent judgment.
UI navigation (`pcControl`) only enters if a step has no data/config path.

## 5. New MCP connectors this needs (build as the agent hits gaps)

- `resolve_mod_load_order` (read-only) — §3. **First connector to build.**
- (candidate) richer `gameIpc` reads the agent asks for while interpreting runs.
- (candidate) a deterministic `apply_mod_load_order` if `configure_active_mods`
  can't express an arbitrary explicit order cleanly (verify first).

"Agent-first" = build the agent's loop against existing tools, and add a connector
the moment the agent needs data/action it can't get. Don't pre-build connectors.

## 6. Phasing

- **A0 — Load-order resolver connector** (`resolve_mod_load_order`): read-only,
  unit-testable against real `About.xml` files. Independent of the SDK app.
- **A1 — Scaffold the Agent SDK app** (`agent/`, TS) via `new-sdk-app`; connect it
  to the MCP server; smallest loop that configures + runs one repo's tests.
- **A2 — Load-order judgment**: agent consumes `resolve_mod_load_order`, resolves
  gaps, applies + verifies.
- **A3 — Result interpretation + merge decision** (dev→development gate).
- **A4 — Parallelism**: switch the run step to the broker's `submit_test_job` +
  poll once the broker lands (ties back to async-job-broker.md).

## 7. Open questions

1. **Merge authority** — does the agent *propose* merges for human approval, or
   merge to `development` autonomously? (Default: propose; require approval.)
2. **Autonomy trigger** — on-demand, on a schedule, or on branch push?
3. ~~Does `configure_active_mods` accept an arbitrary explicit order?~~ **Answered:**
   no — it re-sorts by declared dependencies (official block first, then topo-sort),
   preserving caller order only where declarations are silent. No new apply tool
   needed; the agent resolves gaps and lets the deterministic sorter place the rest.
