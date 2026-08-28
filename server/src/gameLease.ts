import * as fs from "fs";
import * as path from "path";

/*
 * Single-PC FIFO lease over "the game resource".
 * ----------------------------------------------
 * A dev box has exactly ONE RimWorld process, ONE Steam Mods/ deploy folder, and
 * ONE ModsConfig.xml. Every Claude session runs its own MCP server process, and
 * they were stepping on each other: two sessions deploying different mods, one
 * relaunching while another was mid-test, interleaved ModsConfig read-modify-write
 * corrupting the active list. There is no way to run two in-game tests at once on
 * one machine, so the right model is a MUTUALLY-EXCLUSIVE lease granted in FIFO
 * (arrival) order: whoever asks first gets the machine, the rest queue.
 *
 * This is the coarse, session-level layer. It wraps the lifecycle/stateful tools
 * (deploy_rimworld_mods, configure_active_mods, launch_*, run_rimworld_tests,
 * restart_game, execute_game_tool, save_rimworld_game, list_game_tools). The raw
 * IPC channel is protected separately, per round-trip, by ipcLock.ts so cheap
 * read-only peeks (capture_*) stay responsive instead of blocking on a whole lease.
 *
 * Cross-process coordination is filesystem-based (each session is its own
 * process), the same trick ipcLock uses: a shared lease directory holding one
 * "ticket" file per waiting/holding process.
 *
 *   ticket-<enqueuedAt>-<pid>.json  =>  { pid, label, enqueuedAt, heartbeat, releasedAt }
 *
 * Order is (enqueuedAt asc, pid asc). The lowest-ordered LIVE ticket is the
 * holder; everyone else waits. Liveness = the owning pid is alive AND the ticket
 * has been heartbeated within STALE_MS (a wedged holder that stops heartbeating,
 * or a crashed one whose pid is gone, is reaped by any waiter so the queue never
 * deadlocks on a corpse). A legitimately long hold (a multi-minute test run) keeps
 * heartbeating and is never reaped.
 *
 * FIFO fairness needs a session's consecutive game calls to stay together — a
 * deploy -> configure -> launch -> execute sequence must not release between calls
 * and let another session wedge in. So the lease is REENTRANT within a process and
 * lingers for a short GRACE window after each release: the same process reusing it
 * within the grace keeps head-of-line for free, while the ticket staying on disk
 * holds the queue back; if the grace lapses with no reuse, the ticket is removed
 * and the next session in line proceeds.
 */

function num(name: string, def: number): number {
  const v = Number(process.env[name]);
  return v > 0 ? v : def;
}

// Emit a heartbeat this often while queued or holding.
const HEARTBEAT_MS = num("RIMAGENTIC_LEASE_HEARTBEAT_MS", 4_000);
// A ticket not heartbeated within this window is considered wedged and reapable
// (must be a comfortable multiple of HEARTBEAT_MS to tolerate GC / AV pauses).
const STALE_MS = num("RIMAGENTIC_LEASE_STALE_MS", 20_000);
// How long a released ticket lingers so the SAME session's next game call keeps
// head-of-line without re-queueing (sequence stickiness).
const GRACE_MS = num("RIMAGENTIC_LEASE_GRACE_MS", 6_000);
// Longest a cold caller waits in the queue before failing fast. Generous: it must
// clear a full legitimate test run ahead of it. Overridable for tests.
const WAIT_BUDGET_MS = num("RIMAGENTIC_LEASE_WAIT_MS", 20 * 60_000);
const POLL_MS = num("RIMAGENTIC_LEASE_POLL_MS", 150);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function leaseDir(): string {
  const env = process.env.RIMAGENTIC_LEASE_DIR;
  const dir = env
    ? env
    : path.join(
        process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local"),
        "RimAgentic",
        "lease"
      );
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
  return dir;
}

interface Ticket {
  pid: number;
  label: string;
  enqueuedAt: number;
  heartbeat: number;
  releasedAt: number | null;
  file: string;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err && err.code === "EPERM"; // EPERM = alive but not ours; ESRCH = gone
  }
}

function readTicket(dir: string, file: string): Ticket | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    if (parsed && typeof parsed.pid === "number" && typeof parsed.enqueuedAt === "number") {
      return { releasedAt: null, label: "", heartbeat: parsed.enqueuedAt, ...parsed, file };
    }
  } catch {
    /* vanished or mid-write */
  }
  return null;
}

/** All live tickets in queue order (enqueuedAt, then pid). Reaps dead/wedged ones as a side effect. */
function liveTicketsSorted(dir: string): Ticket[] {
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return []; }

  const live: Ticket[] = [];
  for (const file of names) {
    if (!file.startsWith("ticket-") || !file.endsWith(".json")) continue;
    const t = readTicket(dir, file);
    if (!t) continue;
    const wedged = !pidAlive(t.pid) || Date.now() - t.heartbeat > STALE_MS;
    if (wedged) {
      // Reap: rename-then-unlink so two waiters can't both act on it.
      const full = path.join(dir, file);
      const tomb = `${full}.reap-${process.pid}-${Date.now().toString(36)}`;
      try { fs.renameSync(full, tomb); fs.unlinkSync(tomb); } catch { /* someone else reaped it */ }
      continue;
    }
    live.push(t);
  }
  live.sort((a, b) => a.enqueuedAt - b.enqueuedAt || a.pid - b.pid);
  return live;
}

// ---- Per-process lease state -----------------------------------------------
// The MCP process handles tool calls serially, so this single-slot state is
// enough. `depth` supports nested acquires (a gated tool that internally calls
// another gated path) without self-deadlock.
let ticketFile: string | null = null; // our ticket on disk (held or in grace), null when we own nothing
let enqueuedAt = 0;
let depth = 0; // >0 while actively running inside the lease
let inGrace = false;
let heartbeatTimer: NodeJS.Timeout | null = null;
let graceTimer: NodeJS.Timeout | null = null;

function writeOwnTicket(label: string, releasedAt: number | null): void {
  if (!ticketFile) return;
  const payload = { pid: process.pid, label, enqueuedAt, heartbeat: Date.now(), releasedAt };
  try {
    fs.writeFileSync(path.join(leaseDir(), ticketFile), JSON.stringify(payload), "utf8");
  } catch { /* heartbeat is best-effort; a miss within STALE_MS is harmless */ }
}

function startHeartbeat(label: string): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => writeOwnTicket(label, inGrace ? Date.now() : null), HEARTBEAT_MS);
  heartbeatTimer.unref?.(); // must never keep the process alive on its own
}

function removeOwnTicket(): void {
  if (ticketFile) {
    try { fs.unlinkSync(path.join(leaseDir(), ticketFile)); } catch { /* already gone */ }
  }
  ticketFile = null;
  enqueuedAt = 0;
  inGrace = false;
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

function clearGraceTimer(): void {
  if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
}

/** After the outermost lease body finishes, linger for GRACE_MS so the next game
 *  call from THIS session reuses the lease; if none comes, release to the queue. */
function enterGrace(label: string): void {
  inGrace = true;
  writeOwnTicket(label, Date.now());
  clearGraceTimer();
  graceTimer = setTimeout(() => { graceTimer = null; if (inGrace && depth === 0) removeOwnTicket(); }, GRACE_MS);
  graceTimer.unref?.();
}

/**
 * Run `fn` while holding the FIFO game lease. `label` names the operation and is
 * shown to other sessions waiting behind it. Reentrant within this process and
 * sticky across a short grace window (see file header).
 */
export async function withGameLease<T>(label: string, fn: () => Promise<T>): Promise<T> {
  // Fast path: we already own the lease (nested call, or reuse within the grace window).
  if (ticketFile && (depth > 0 || inGrace)) {
    clearGraceTimer();
    inGrace = false;
    writeOwnTicket(label, null);
    depth++;
    try {
      return await fn();
    } finally {
      depth--;
      if (depth === 0) enterGrace(label);
    }
  }

  // Cold acquire: enqueue a ticket and wait until we are head-of-line.
  const dir = leaseDir();
  enqueuedAt = Date.now();
  ticketFile = `ticket-${enqueuedAt}-${process.pid}.json`;
  writeOwnTicket(label, null);
  startHeartbeat(label);

  const deadline = Date.now() + WAIT_BUDGET_MS;
  for (;;) {
    const live = liveTicketsSorted(dir);
    const head = live[0];
    if (head && head.pid === process.pid) break; // our turn

    if (Date.now() > deadline) {
      removeOwnTicket();
      const who = head
        ? `pid ${head.pid} (${head.label || "unknown op"}, held ${Math.round((Date.now() - head.enqueuedAt) / 1000)}s)`
        : "another session";
      throw new Error(
        `Timed out after ${Math.round(WAIT_BUDGET_MS / 60000)} min queued for the RimWorld game lease — ` +
          `it is held by ${who}. Only one session drives the game at a time; sessions are served in ` +
          `arrival order. If the holder is wedged its ticket self-expires after ${STALE_MS / 1000}s.`
      );
    }
    await sleep(POLL_MS + Math.random() * 100);
  }

  depth = 1;
  try {
    return await fn();
  } finally {
    depth--;
    if (depth === 0) enterGrace(label);
  }
}

export interface LeaseStatus {
  dir: string;
  self: number; // this process's pid
  holder: { pid: number; label: string; heldForMs: number; releasing: boolean } | null;
  queue: Array<{ pid: number; label: string; enqueuedAt: number; waitingMs: number; isSelf: boolean }>;
  selfPosition: number | null; // 0 = holder, 1 = next, ... ; null = not queued
}

/** Snapshot the lease for observability (the game_lease_status tool). Read-only,
 *  but it does reap dead tickets as a side effect (same as any waiter would). */
export function leaseStatus(): LeaseStatus {
  const dir = leaseDir();
  const live = liveTicketsSorted(dir);
  const now = Date.now();
  const head = live[0] || null;
  const selfPosition = live.findIndex((t) => t.pid === process.pid);
  return {
    dir,
    self: process.pid,
    holder: head
      ? { pid: head.pid, label: head.label, heldForMs: now - head.enqueuedAt, releasing: head.releasedAt != null }
      : null,
    queue: live.map((t) => ({
      pid: t.pid,
      label: t.label,
      enqueuedAt: t.enqueuedAt,
      waitingMs: now - t.enqueuedAt,
      isSelf: t.pid === process.pid,
    })),
    selfPosition: selfPosition === -1 ? null : selfPosition,
  };
}

// ---- MCP tool: game_lease_status -------------------------------------------
export const gameLeaseTools = [
  {
    name: "game_lease_status",
    description:
      "Read-only. Reports the single-PC FIFO game lease: which agent session (by pid) currently " +
      "holds the RimWorld game resource (deploy/configure/launch/test/in-game IPC are serialized " +
      "under it), who is queued behind it and in what order, and where this session sits. Use it " +
      "to see why a game call is blocked or how long a test run has held the machine. Writes nothing.",
    inputSchema: { type: "object", properties: {} },
  },
];

export async function handleGameLeaseTool(name: string, _args: any) {
  if (name === "game_lease_status") {
    return { content: [{ type: "text", text: JSON.stringify(leaseStatus(), null, 2) }] };
  }
  throw new Error(`Unknown game-lease tool: ${name}`);
}

/** The tools whose bodies run inside withGameLease. Kept here so both transports
 *  (stdio + SSE) in index.ts gate the exact same set. */
export const GAME_LEASE_TOOLS = new Set<string>([
  "deploy_rimworld_mods",
  "configure_active_mods",
  "launch_rimworld",
  "launch_quicktest",
  "run_rimworld_tests",
  "restart_game",
  "execute_game_tool",
  "save_rimworld_game",
  "list_game_tools",
]);
