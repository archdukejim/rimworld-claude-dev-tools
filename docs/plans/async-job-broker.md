# Build Plan — Async Job Broker (issue #3)

Turns the RimWorld test harness from a single-caller synchronous tool into an
**async job broker**: many chats/chips/worktrees submit test jobs in parallel;
game runs execute **serially** against the one RimWorld instance, each with its
own **pinned, verified config**.

Live issue: [#3](https://github.com/archdukejim/rimworld-claude-dev-tools/issues/3).
This doc is the implementation plan; update it as we build.

> **STATUS — MVP shipped (`server/src/tools/jobs.ts`).** After the pivot to a single-modder
> product, the "standalone daemon" architecture below was **simplified to an in-process broker
> embedded in the MCP server** (one client → no cross-client shared queue needed). Delivered:
> async `submit_test_job` (returns job_id immediately), a single serial worker draining the
> game-run lane, per-job pinned savedatafolder, disk-persisted job.json, and `get_job` /
> `list_jobs` / `cancel_job`. **Two lanes now live:** builds run concurrently (a pool of
> `MAX_BUILDS = min(4, cpus-1)`) via `buildStage`, then each built job hands off to the single
> serial game-run worker (`runStage`) — builds parallelize, games serialize. Cancel works while
> pending/queued. **Not yet done:** launch-time config verification (assert the pinned
> ModsConfig/savedatafolder before spawning), git-worktree isolation for the build lane, and
> cancel-mid-run. The daemon design below stays the reference if multi-session sharing is needed.

---

## 1. Problem recap (why this, why now)

The current path (`run_rimworld_tests` in `server/src/tools/rimworldDev.ts`):

- **Synchronous.** One caller blocks for the whole build (≤10 min) + launch
  (≤~10 min). A second caller either blocks or collides.
- **Shared mutable globals, last-writer-wins.** One `savedatafolder`, one
  `ModsConfig.xml`, one `Player.log`, one `dev_instance_pid.txt`. `configure_active_mods`
  writes the modlist; `run_rimworld_tests` launches against it. Two flows
  interleaving corrupt each other's config and logs.
- This is the root cause of the two logged bugs:
  - **Repo-MCP#18** — `run_rimworld_tests` silently changed which `ModsConfig` it launched mid-session.
  - **Repo-MCP#19** — an unquoted `savedatafolder` launched vanilla and the run reported clean.

Both are "shared global, no isolation, no verification" bugs. A queue with
**per-job pinned config + launch verification** fixes them structurally.

## 2. Architecture decision — a standalone broker daemon

Multiple submitters are separate MCP clients (mostly **stdio**, one process per
chat). Job state and the serial worker therefore **cannot** live inside a single
client's MCP process. Options considered:

| Option | Verdict |
|--------|---------|
| In-memory state in each stdio MCP process | ✗ Not shared across clients; dies with the session. |
| Embed in the SSE server (`manager.ts` spawns it) | ✗ Only works when clients use SSE; stdio clients see nothing. Couples broker lifetime to that one server. |
| **Standalone broker daemon + durable on-disk queue; MCP tools are thin HTTP clients** | ✓ Transport-agnostic, survives client restarts, single source of truth for the serial lane. **Chosen.** |

**Design:** a small long-lived Node process (`broker`) listening on
`127.0.0.1:<brokerPort>` with a JSON HTTP API and a durable queue on disk. The
new MCP tools (`submit_test_job`, `get_job`, `list_jobs`, `cancel_job`) are thin
clients that POST/GET to it. The broker owns the single game-run worker.

Auto-start: the MCP server pings the broker on first job tool call; if absent it
spawns it detached (same best-effort pattern as `startBridge` in `index.ts`).
The broker is idempotent to double-start (port-in-use ⇒ assume already running).

## 3. Two lanes (separate by the actual scarce resource)

- **Build lane → parallel pool.** Builds are cheap and worktree-isolated. N jobs
  can build concurrently, each `dotnet build` in its own worktree. Bounded pool
  (e.g. `min(cpu-2, N)`).
- **Game-run lane → one serial worker.** The scarce resource: only one RimWorld
  can own the GPU/VRAM. Worker drains a FIFO queue, one run at a time.
- **Third shared resource — local LLM (LM Studio @ 192.168.4.106).** If tests hit
  it, concurrent runs contend. Serializing the game-run lane already serializes
  LLM access; note it and revisit if a parallel-LLM setup appears.

Flow: `submit_test_job` → build (parallel) → enqueue game-run (serial, pinned
config) → classify log → result keyed by `job_id` → callers poll `get_job`.

## 4. Per-job config contract (the correctness core)

Each job pins its own isolated config **at submit** and **verifies at launch**.
Job-scoped, never touching the shared default folder:

```
<jobsRoot>/<job_id>/
  savedatafolder/Config/ModsConfig.xml   # pinned active mods (+ knownExpansions)
  savedatafolder/Config/Prefs.xml        # devMode, muted, runInBackground
  savedatafolder/Logs/Player.log         # this run's log only
  job.json                               # the pinned contract + status + result
  build.log
```

- **Pin at submit:** resolve `mods` → a concrete `ModsConfig.xml` written into the
  job's own `savedatafolder`. Store the exact active-mod list in `job.json`.
- **Verify at launch:** before spawning, re-read the job's `ModsConfig.xml` and
  assert it still equals the pinned list (guards #18). Assert the
  `-savedatafolder=` path is quoted and exists and is the job's folder (guards #19).
  Refuse to launch on mismatch; fail the job with a clear reason rather than
  running vanilla and reporting clean.
- **Kill isolation:** track the job's PID in `job.json`; the "kill dev instances"
  scan must target only that PID, not every `*savedatafolder*` process (today's
  broad taskkill would kill a sibling job's game — but serial execution means at
  most one game runs, so this is naturally safe; still key on PID).

## 5. Job state machine

```
pending → building → (build fail ⇒ failed:build)
                   → queued → running → (launch/verify fail ⇒ failed:launch)
                                      → classifying → done{pass|fail} 
cancel at any pre-terminal state ⇒ cancelled
```

`job.json` schema (draft):

```jsonc
{
  "id": "job_<ts>_<rand>",
  "status": "pending|building|queued|running|classifying|done|failed|cancelled",
  "substage": "build|launch|classify|null",
  "submittedAt": 0, "startedAt": 0, "finishedAt": 0,
  "request": { "repo": "Factions", "mods": ["Core","Factions",...],
               "timeoutSec": 420, "worktree": "<path>?" },
  "pinned": { "savedatafolder": "<path>", "activeMods": ["..."],
              "modsConfigHash": "sha256:..." },
  "pid": null,
  "result": { "ok": true, "build": {...}, "launch": {...}, "log": {...} },
  "error": null
}
```

Durability: write `job.json` atomically (temp + rename) on every transition. On
broker restart, reload all `job.json`, re-queue anything left `queued`, and mark
anything left `running`/`building` as `failed:interrupted` (a game run can't be
resumed).

## 6. Tool surface (new `jobs` family — `server/src/tools/jobBroker.ts`)

Follows the repo pattern (`<family>Tools` + `handleJobBrokerTool`), wired into
`index.ts` (import, `ALL_TOOLS`, dispatch) and added to `manifest.json`.

- `submit_test_job({ repo?, mods?, savedatafolder?, timeoutSec?, worktree? }) -> { job_id, status: "pending" }`
  Returns immediately. `savedatafolder` optional — broker allocates a job-scoped
  one by default (recommended); an explicit value opts into a fixed folder.
- `get_job({ job_id }) -> { status, substage, result?, error? }`
- `list_jobs({ status? }) -> [{ job_id, status, repo, submittedAt }]`
- `cancel_job({ job_id }) -> { job_id, status }`

Existing `run_rimworld_tests` stays as a **synchronous convenience wrapper**:
internally `submit_test_job` then poll `get_job` until terminal (preserves the
current blocking UX and callers). Not removed.

## 7. Phasing

**Phase 0 — Extract harness core (no behaviour change).**
Refactor the build/launch/classify logic in `rimworldDev.ts` so it accepts an
explicit `{ savedatafolder, mods, timeoutSec }` and never reads shared globals
implicitly. Pure refactor; `run_rimworld_tests` still works. Establishes the
"config is a parameter, not a global" invariant the broker depends on.

**Phase 1 — Broker daemon skeleton.**
`server/src/broker/index.ts`: HTTP server on `127.0.0.1:<port>`, in-memory queue,
job dir layout, `job.json` persistence, endpoints `POST /jobs`, `GET /jobs/:id`,
`GET /jobs`, `POST /jobs/:id/cancel`. No game launch yet — worker just echoes.
Unit-testable without RimWorld.

**Phase 2 — Wire the lanes.**
Build lane (parallel pool) + game-run lane (serial worker) calling the Phase-0
harness core. Implement pin-at-submit + verify-at-launch. Real runs.

**Phase 3 — MCP tools.**
`jobBroker.ts` thin HTTP client + auto-start of the broker. Wire into `index.ts`
and `manifest.json`. Re-point `run_rimworld_tests` at submit+poll.

**Phase 4 — Worktree isolation for the build lane.**
Each job builds in its own git worktree so concurrent builds can't fight over
`bin/obj`. (May lean on the same worktree machinery `EnterWorktree` uses.)

**Phase 5 — Hardening.**
Crash recovery on broker restart, `cancel_job` mid-run (kill pinned PID), stale
job GC, and a `list_jobs` dashboard line in the manager UI.

## 8. Decisions & open questions

**Decided:**
- **`jobsRoot`** → `%LOCALAPPDATA%\RimSynapse\jobs\` (out of the repo, survives
  git cleans, mirrors where RimWorld keeps savedata).
- **Broker port** → config-driven, **default 4002** (near the manager's 4001),
  overridable in `config.json`.

**Still open (revisit during the relevant phase):**
- **Result retention** — keep every job dir, or GC done/failed after N or age?
  (Phase 5.)
- **Worktree source of truth** — reuse the harness `build.ps1` worktree logic, or
  the SDK's `EnterWorktree`? (Phase 4.)
- **Does the test suite hit the LLM at 192.168.4.106 today?** If yes, the serial
  lane is doing double duty; if a parallel-LLM box appears, revisit lane #2's
  assumptions.

## 9. Definition of done

- Two chats can `submit_test_job` seconds apart; both get `job_id`s immediately;
  the games run one-after-another; each result reflects **its own** pinned modlist.
- A deliberately-mismatched `ModsConfig` (repro of #18) fails the job at the verify
  gate instead of running the wrong list.
- An unquoted/invalid `savedatafolder` (repro of #19) fails at the verify gate
  instead of launching vanilla and reporting clean.
- `run_rimworld_tests` behaves exactly as before for existing callers.
