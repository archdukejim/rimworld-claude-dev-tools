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

`cd server && npm run test:lease` — spawns real worker processes that contend for
the lease and asserts FIFO order, mutual exclusion, single acquisition per session,
and reentrancy. Touches only a temp lease dir.

## Rollout gotcha

Every session spawns its own MCP server process. Old builds don't take the lease, so
until every running `node server/build/index.js` is on this build, an old session can
still stomp. After merging: rebuild in the main checkout and kill every stale node
server (same rule as any bridge change).
