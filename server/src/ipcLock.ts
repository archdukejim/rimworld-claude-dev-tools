import * as fs from "fs";
import * as path from "path";

/*
 * Cross-process mutex for the game's file-drop IPC channel.
 * ---------------------------------------------------------
 * Every Claude session spawns its own MCP server process (stdio transport), and
 * all of them share one IPC directory with FIXED filenames (tool_input.json /
 * tool_output.json). Without mutual exclusion, concurrent sessions clobber each
 * other's requests, steal each other's responses, and delete responses the
 * other side hasn't read yet — which presents as spurious timeouts and
 * mismatched results ("the bridge locked up").
 *
 * The lock is a file created atomically with the O_EXCL ('wx') flag in the same
 * IPC directory both ends already share, so it needs zero extra configuration.
 * The holder records { pid, label, acquiredAt }; waiters poll with jitter and
 * break the lock only when the holder's pid is dead or the lock has outlived
 * LOCK_TTL_MS (which exceeds the longest legitimate round-trip — 15s for the
 * watchdog's in-game save — by a wide margin). Breaking is done by atomic
 * rename so two waiters can never both "win" the break.
 */

// TTL must exceed the WORST legitimate hold, which is NOT one round-trip: a
// locked call may first drain a predecessor's late output (up to the 30s
// marker window in gameIpc.ts drainLateOutput) and then run its own round-trip
// (up to 15s — the watchdog's requestInGameSave). 30s + 15s + poll/AV slop
// ≈ 50s worst case, so 90s. If you raise either of those two numbers, raise
// this one. Env overrides exist for the test suite; production uses defaults.
const LOCK_TTL_MS = Number(process.env.RIMAGENTIC_IPC_LOCK_TTL_MS) > 0
  ? Number(process.env.RIMAGENTIC_IPC_LOCK_TTL_MS)
  : 90_000;
// How long a caller queues behind other sessions before giving up. Must
// exceed LOCK_TTL_MS (a wedged-but-alive holder stalls the queue for a full
// TTL) plus a few normal holds. Under a cascade (half-dead game, every call
// draining + timing out) deep-queued callers can still hit this budget and
// get the queue-timeout error below — that is intended fail-fast behavior.
const WAIT_BUDGET_MS = Number(process.env.RIMAGENTIC_IPC_LOCK_WAIT_MS) > 0
  ? Number(process.env.RIMAGENTIC_IPC_LOCK_WAIT_MS)
  : 180_000;
const POLL_MS = 150;

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
 * NOT REENTRANT: `fn` must never call withIpcLock (or anything that does,
 * i.e. callInGameTool) — a nested acquire sees its own live pid as a valid
 * holder and spins the full wait budget before erroring. gameIpc's follow-up
 * window read (maybeAttachWindow) is deliberately a second, separate
 * acquisition for this reason.
 *
 * `onStaleBreak` fires after this caller breaks another holder's stale lock.
 * The dead/wedged holder may have left a request the game is still executing,
 * so gameIpc uses this to arm its late-output drain — without it, the corpse's
 * late response could be consumed as the next caller's answer.
 */
export async function withIpcLock<T>(
  dir: string,
  label: string,
  fn: () => Promise<T>,
  onStaleBreak?: () => void
): Promise<T> {
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
    // Release only if the lock is still OURS. (A read-then-unlink TOCTOU
    // exists in theory, but only after we overstayed the TTL — which the TTL
    // sizing above rules out for legitimate holds.) Retry the unlink a few
    // times: an on-access virus scanner briefly holding the file would
    // otherwise cost every other session a full TTL wait.
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
