# Agent handoff — session 74d9dd03 (2026-08-17)

Branch: `agent/74d9dd03` → PR into `development`.

## What was done

Fixed the "bridge keeps locking up when multiple chats/agents run" problem by adding
cross-process queueing to BOTH bridges. Root cause (verified empirically: five
`node server/build/index.js` processes were running concurrently, one per Claude
session, stdio transport):

1. **Game IPC channel** (`gameIpc.ts`): all sessions shared
   `%LOCALAPPDATA%\RimAgentic\ipc\tool_input.json` / `tool_output.json` — fixed
   filenames, no correlation IDs (the game-side protocol in
   `game-mod/Source/SynapseGameComponent.cs` echoes nothing), no locking. Sessions
   clobbered each other's requests and consumed each other's responses → spurious
   timeouts, cross-matched results.
2. **SWH loopback bridge** (`bridge.ts`, port 8766): only the first process to bind
   the port got a bridge; every other session had `swh_*` / `chrome_tabs` /
   `chrome_tidy` permanently dead ("bridge not started").

## The fix

- **`server/src/ipcLock.ts` (new)** — cross-process mutex in the IPC dir
  (`bridge.lock`, atomic `wx` create; rename-based stale-breaking when the holder
  pid is dead or the lock outlives its 90s TTL; unlink retries for AV holds; wait
  budget 180s). NOT reentrant — never call `callInGameTool` from inside a locked fn.
- **`gameIpc.ts`** — every `callInGameTool` round-trip now runs inside an in-process
  FIFO + the cross-process lock. On timeout: an unconsumed request is withdrawn
  (no ghost execution); a consumed-but-unanswered one arms a `late_output_expected`
  marker so the NEXT caller drains the game's late response instead of consuming it
  as its own. Stale-break arms the same drain (12s grace) since the dead session's
  request may still be executing.
- **`bridge.ts`** — rewritten for multi-session:
  - one command in flight at a time; queued commands get a queue-grace timer
    (60s), and the real exec timeout only starts at dispatch (fixes ghost
    execution of timed-out queued commands);
  - `POST /call` relay endpoint + `connectBridge()`: the first process to bind is
    the OWNER, every later process gets a PROXY that relays through it, so all
    sessions share one queue. Owner dies → the next proxy call promotes itself.
    `/call` is locked against browsers (Origin-reject, no CORS headers, shared
    secret at `%LOCALAPPDATA%\RimAgentic\bridge-call-secret.txt`);
  - replay policy: extension reconnect mid-command replays only REPLAY_SAFE
    (read/converging) methods; `postComment` etc. fail fast with an honest
    "MAY have executed — verify before retrying" (the MV3 worker can die after the
    page-context Steam call fired, so blind replay double-posts). Same rule on
    proxy failover: auto re-send only on ECONNREFUSED or replay-safe methods;
  - `Bridge.status()` is now async (proxy needs a network hop) — both call sites
    in `chromeCtl.ts` updated.

## Verification

- `npm run build` clean.
- `npm run test:ipc` — 4 processes × 8 calls against a fake game responder: zero
  cross-talk, fake game never saw overlapping requests, dead-pid stale lock broken,
  timed-out request withdrawn, lock released.
- `npm run test:bridge` — owner + proxy + fake extension: serialization across
  sessions, idempotent replay after lost delivery, `postComment` fail-fast without
  re-delivery, proxy self-promotion after owner exit.

## ROLLOUT — important

The fix is only real once **every running server is the new build**: an old-build
process ignores `bridge.lock`, and if it owns port 8766 the new proxies refuse it
(`/health` has no `relay: true` marker) with a "stale build" error. After merging:
rebuild in the main checkout and **kill all old `node server/build/index.js`
processes** before trusting the bridge again.

## Explicitly NOT fixed here (separate work, surfaced by the concurrency audit)

- Kill-by-image-name: `taskkill /f /im RimWorldWin64.exe` in the watchdog backstop /
  `launch_rimworld killExisting` / quicktest kills OTHER sessions' games; the idle
  watchdog's activity clock is per-process so it can close a game another session
  is driving.
- Unlocked read-modify-write JSON stores: `keys.json` (keyring can be wiped by a
  torn read), imgur `uploads.json` (ledger records / anonymous deletehashes lost),
  `showcase.json`.
- Shared default savedatafolder → ModsConfig/Prefs TOCTOU between sessions
  (one session's test can silently run against another's modlist).
