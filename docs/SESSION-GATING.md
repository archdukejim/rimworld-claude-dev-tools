# Session gating — stopping concurrent sessions from stomping the game

Multiple Claude sessions (and forks, and — soon — multiple PCs) drive this MCP
concurrently. On one machine there is exactly **one** RimWorld process, **one**
Steam `Mods/` deploy folder, and **one** `ModsConfig.xml`. Two sessions using
them at once corrupt each other: interleaved ModsConfig read-modify-write, one
session relaunching while another is mid-test, two deploys racing the same DLLs,
the id-less file-drop IPC channel handing a response to the wrong caller.

This is **Layer 1** of the multi-PC testing plan: a single-PC gate. Layer 2 (a
broker PC that distributes test jobs to a pool of self-provisioning runner PCs)
builds on this — each runner still serializes locally exactly as below.

## Two complementary locks

### 1. The FIFO game lease (`server/src/gameLease.ts`) — coarse, fair, session-level

A cross-process, **arrival-ordered** lease over "the game resource". The lifecycle
and stateful tools run inside it, one session at a time, served in the order they
asked:

    deploy_rimworld_mods, configure_active_mods, launch_rimworld, launch_quicktest,
    run_rimworld_tests, restart_game, execute_game_tool, save_rimworld_game,
    list_game_tools

Mechanics (filesystem-based, because each session is its own MCP process):

- Each waiting/holding process drops one **ticket** file in the shared lease dir
  (`%LOCALAPPDATA%\RimAgentic\lease`, override `RIMAGENTIC_LEASE_DIR`):
  `ticket-<enqueuedAt>-<pid>.json`. Order is `(enqueuedAt, pid)`; the lowest-ordered
  **live** ticket is the holder, everyone else waits — that is the FIFO fairness.
- **Liveness / no deadlock on a corpse:** a ticket is reaped by any waiter when its
  pid is dead OR it hasn't heartbeat within `STALE_MS`. A legitimately long hold (a
  multi-minute test run) keeps heartbeating and is never reaped; a crashed session's
  ticket is cleared automatically.
- **Reentrant** within a process (a gated tool that internally calls another gated
  path won't self-deadlock).
- **Sticky grace:** after a tool releases, the ticket lingers for `GRACE_MS` (~6s) so
  the SAME session's *next* game call keeps head-of-line instead of re-queuing behind
  someone else — this keeps a `deploy → configure → launch → execute …` sequence
  together without any explicit acquire/release. If the grace lapses unused, the next
  session in line proceeds.

Enforced centrally in **both** transports in `server/src/index.ts` (a single
`dispatch` closure wrapped by `withGameLease` for the `GAME_LEASE_TOOLS` set), so
stdio and SSE can't drift.

Observe it with the **`game_lease_status`** tool: holder pid, the queue in order,
and this session's position.

### 2. The IPC channel mutex (`server/src/ipcLock.ts`) — fine, per-round-trip

The lease deliberately does **not** gate cheap read-only peeks (`capture_*` window /
gizmo / colonist-bar reads, readiness probes) so a screenshot doesn't block on a
whole test run. Those still hit the fixed-filename bridge channel, so every raw
round-trip in `callInGameTool` (`server/src/tools/gameIpc.ts`) is wrapped in a short
cross-process mutex (`bridge.lock` in the IPC dir). A non-holder's peek can therefore
never clobber the holder's in-flight request; it just waits for the current
round-trip. Mutual exclusion, not fairness — fairness is the lease's job.

## Hazards this closes

- **ModsConfig.xml TOCTOU** — `configure_active_mods` now holds the lease, so no two
  sessions interleave its read-modify-write. Fixed as a consequence of gating.
- **kill-by-image-name** — the idle watchdog (`server/src/gameWatchdog.ts`) used to
  back its pid-kill with `taskkill /im RimWorldWin64.exe`, which nukes *every*
  RimWorld on the box — including another session's game. It is now **pid-scoped
  only**: it closes exactly the process it launched, never by image name. (The
  launch tools' own "clean slate" image-kill is fine because it only runs while
  holding the lease, i.e. no other active session's game exists.)

## Layer 1.5 — session-stateful, modlist-aware game

Layer 1 answers *who* may touch the game. Layer 1.5 makes "use the game" **declarative**: a session
says which modlist it wants, and the game is brought up with exactly that, rebuilt clean every time.

### Session identity (`server/src/sessionContext.ts`)

Claude Code exposes **no** session id to MCP servers (only `CLAUDECODE=1` and a shared
`CLAUDE_PROJECT_DIR`), so a hook-written `session_id.txt` would race across concurrent sessions.
The stable key we use instead is the **git worktree short-id** (`d2029542`): the agent hands it to
us implicitly on path-bearing calls (deploy sources from `…\worktrees\<repo>\<id>\…`, branch
`agent/<id>`). We **infer** it from tool-arg paths and **pin** it to the process; `use_session`
pins it explicitly. The cache is stored on disk keyed by that id, so it survives the MCP server
being killed and respawned (the rebuild gotcha) — the next path-bearing call re-attaches. Two
sessions = two processes each inferring their own id; no shared file, no race.

### Per-session modlist cache + clean-template rebuild (`server/src/tools/session.ts`)

- `set_session_modlist { mods, dlcs }` / `get_session_modlist` — **ungated** cache ops. You pass
  only your content mods + DLC; the **mandatory clean base** (`brrainz.harmony`, `ludeon.rimworld`,
  `archdukejim.rimagentic`) is always added.
- The active list is **regenerated from the clean template every time** — mandatory base ∪ session
  mods → `resolveModLoadOrder` (official-first, `forceLoad*`-aware, toolkit forced last). Never an
  incremental mutation of the current `ModsConfig`, which is the whole drift-bug class.
- `ensure_game` — **gated** (FIFO). Resolves the session, builds the clean modlist, and:
  - live game already has this session's modlist (fingerprint match) and is healthy → **reuse, no
    relaunch** (the fast path that avoids restart thrash);
  - otherwise → **close the running game → scrub + rewrite `ModsConfig` from the clean build →
    relaunch** (the takeover). It reuses `configure_active_mods` (overwrite = scrub+rebuild) and
    `launch_rimworld` (killExisting = kill+relaunch), and records a shared `live-session.json`
    marker of which session's modlist is live. `dryRun` returns the plan without touching the game.

One PC = one game, so switching to a *different* session's modlist is a full relaunch; the
same-modlist fast path and Layer 1's sticky grace keep that from thrashing. Different modlists *at
once* is what Layer 2 (multiple PCs) is for.

## Tuning (env overrides)

| var | default | meaning |
|---|---|---|
| `RIMAGENTIC_LEASE_DIR` | `%LOCALAPPDATA%\RimAgentic\lease` | ticket directory |
| `RIMAGENTIC_LEASE_HEARTBEAT_MS` | 4000 | heartbeat cadence |
| `RIMAGENTIC_LEASE_STALE_MS` | 20000 | ticket reaped if unheartbeated this long |
| `RIMAGENTIC_LEASE_GRACE_MS` | 6000 | same-session sticky window after release |
| `RIMAGENTIC_LEASE_WAIT_MS` | 1200000 | cold-caller queue budget before fail-fast |
| `RIMAGENTIC_IPC_LOCK_TTL_MS` | 60000 | IPC mutex self-break age |
| `RIMAGENTIC_IPC_LOCK_WAIT_MS` | 120000 | IPC mutex queue budget |

## Tests

- `cd server && npm run test:lease` — spawns real worker processes that contend for the lease and
  asserts FIFO order, mutual exclusion, single acquisition per session, and reentrancy.
- `npm run test:session` — session identity (infer/pin/resolve), the modlist cache round-trip, and
  the clean-template builder (base injected, DLC/content included, toolkit forced last, ordering).

Both touch only temp dirs.

## Rollout gotcha

Every session spawns its own MCP server process. Old builds don't take the lease, so
until every running `node server/build/index.js` is on this build, an old session can
still stomp. After merging: rebuild in the main checkout and kill every stale node
server (same rule as any bridge change).
