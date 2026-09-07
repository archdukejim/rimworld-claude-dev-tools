import * as fs from "fs";
import * as path from "path";

/*
 * Cross-process mutex for the game's file-drop IPC channel.
 * ---------------------------------------------------------
 * Every Claude session spawns its own MCP server process (stdio transport), and
 * all of them share ONE IPC directory with FIXED filenames (tool_input.json /
 * tool_output.json — see tools/gameIpc.ts). Without mutual exclusion, concurrent
 * sessions clobber each other's requests, steal each other's responses, and
 * delete a response the other side has not read yet — which surfaces as spurious
 * timeouts and mismatched results ("the bridge locked up").
 *
 * The session-level FIFO lease (gameLease.ts) already keeps lifecycle/stateful
 * tools (deploy, configure, launch, run_tests, execute_game_tool) to one session
 * at a time. This lock is the SECOND, finer layer: it guards the raw channel for
 * the tools that are NOT lease-gated because they are cheap read-only peeks — the
 * capture_* window/gizmo reads and readiness probes that also go through the
 * bridge. So even a non-holder's screenshot can't corrupt the holder's in-flight
 * round-trip. It is a short per-round-trip mutex, not a fair queue; fairness is
 * the lease's job.
 *
 * Mechanics: a file created atomically with O_EXCL ('wx') in the shared IPC dir,
 * so it needs zero configuration. The holder records { pid, label, acquiredAt };
 * waiters poll with jitter and break the lock only when the holder's pid is dead
 * or the lock outlived LOCK_TTL_MS. Breaking is an atomic rename so two waiters
 * can never both "win" the break.
 */

// TTL must exceed the worst LEGITIMATE single round-trip. The longest is the
// watchdog's in-game save (15s) plus poll/AV slop, so 60s is comfortable. A held
// lock older than this is treated as a wedged/dead holder and broken.
const LOCK_TTL_MS = Number(process.env.RIMAGENTIC_IPC_LOCK_TTL_MS) > 0
  ? Number(process.env.RIMAGENTIC_IPC_LOCK_TTL_MS)
  : 60_000;
// How long a caller queues behind other sessions on the raw channel before
// giving up. Must exceed LOCK_TTL_MS (a wedged-but-alive holder stalls a full
// TTL) plus a few normal holds.
const WAIT_BUDGET_MS = Number(process.env.RIMAGENTIC_IPC_LOCK_WAIT_MS) > 0
  ? Number(process.env.RIMAGENTIC_IPC_LOCK_WAIT_MS)
  : 120_000;
const POLL_MS = 100;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface LockInfo {
  pid: number;
  label: string;
  acquiredAt: number;
}

function lockPathFor(dir: string): string {
  return path.join(dir, "bridge.lock");
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM = exists but not ours to signal; anything else (ESRCH) = gone.
    return err && err.code === "EPERM";
  }
}

function readLockInfo(lockPath: string): LockInfo | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (parsed && typeof parsed.pid === "number") return parsed as LockInfo;
  } catch {
    /* vanished or mid-write */
  }
  return null;
}

/** Age via mtime, for a lock file whose JSON can't be read. */
function lockAgeMs(lockPath: string): number {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs;
  } catch {
    return 0;
  }
}

/** Atomically remove a stale lock. Rename-first so concurrent breakers can't
 *  both proceed: only one rename succeeds, the loser just retries the loop. */
function breakLock(lockPath: string): void {
  const tomb = `${lockPath}.stale-${process.pid}-${Date.now().toString(36)}`;
  try {
    fs.renameSync(lockPath, tomb);
    fs.unlinkSync(tomb);
  } catch {
    /* another waiter broke it first — fine */
  }
}

/**
 * Run `fn` while holding the cross-process IPC lock in `dir`.
 * `label` names the operation (shown to other sessions stuck in the queue).
 *
 * NOT REENTRANT: `fn` must never call withIpcLock (or anything that does, i.e.
 * callInGameTool) — a nested acquire sees its own live pid as a valid holder and
 * spins the full wait budget before erroring. gameIpc's follow-up window read
 * (maybeAttachWindow) is deliberately a second, separate acquisition.
 *
 * `onStaleBreak` fires after this caller breaks another holder's stale lock: the
 * dead/wedged holder may have left a half-finished request/response in the shared
 * files, so the caller can scrub them before starting its own round-trip.
 */
export async function withIpcLock<T>(
  dir: string,
  label: string,
  fn: () => Promise<T>,
  onStaleBreak?: () => void
): Promise<T> {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
  const lockPath = lockPathFor(dir);
  const deadline = Date.now() + WAIT_BUDGET_MS;

  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, label, acquiredAt: Date.now() }));
      } finally {
        fs.closeSync(fd);
      }
      break; // acquired
    } catch (err: any) {
      if (err?.code !== "EEXIST") {
        // Transient EPERM/EBUSY (antivirus poking the fresh file) — treat like contention.
        if (err?.code !== "EPERM" && err?.code !== "EBUSY") throw err;
      }
      const holder = readLockInfo(lockPath);
      const age = holder ? Date.now() - holder.acquiredAt : lockAgeMs(lockPath);
      const stale = holder ? !pidAlive(holder.pid) || age > LOCK_TTL_MS : age > LOCK_TTL_MS;
      if (stale) {
        breakLock(lockPath);
        try {
          onStaleBreak?.();
        } catch {
          /* advisory only */
        }
        continue;
      }
      if (Date.now() > deadline) {
        const who = holder
          ? `pid ${holder.pid} (${holder.label || "unknown op"}, held ${Math.round(age / 1000)}s)`
          : "an unidentified process";
        throw new Error(
          `Timed out after ${Math.round(WAIT_BUDGET_MS / 1000)}s queued for the game IPC bridge — ` +
            `it is held by ${who}. Other agent sessions share this bridge and calls run one at a ` +
            `time; if the holder is wedged the lock self-breaks after ${LOCK_TTL_MS / 1000}s.`
        );
      }
      await sleep(POLL_MS + Math.random() * 100);
    }
  }

  try {
    return await fn();
  } finally {
    // Release only if the lock is still OURS.
    const cur = readLockInfo(lockPath);
    if (cur && cur.pid === process.pid) {
      for (let i = 0; i < 4; i++) {
        try {
          fs.unlinkSync(lockPath);
          break;
        } catch (err: any) {
          if (err?.code === "ENOENT") break;
          await sleep(100);
        }
      }
    }
  }
}
