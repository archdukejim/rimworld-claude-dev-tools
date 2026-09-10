/*
 * Cross-process FIFO game-lease test.
 *
 *   cd server && npm run build && npm run test:lease
 *
 * Spawns several worker PROCESSES (each stands in for a separate Claude session's MCP
 * server) that contend for the single-PC game lease, and asserts:
 *   - every worker acquires exactly once (no lost/starved sessions),
 *   - acquisition order matches arrival order (FIFO fairness),
 *   - no two holds overlap (mutual exclusion — the whole point of the lease),
 *   - a nested acquire within one process does not deadlock (reentrancy).
 *
 * Grace stickiness is disabled here (RIMAGENTIC_LEASE_GRACE_MS=1) so the test measures
 * pure FIFO handoff; the grace window is a same-session convenience, not a fairness rule.
 * Touches only a temp lease dir — never the real %LOCALAPPDATA%\RimAgentic\lease.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "gamelease-"));
const leaseDir = path.join(scratch, "lease");
fs.mkdirSync(leaseDir, { recursive: true });
const results = path.join(scratch, "results.ndjson");
fs.writeFileSync(results, "");

const tuning = {
  RIMAGENTIC_LEASE_DIR: leaseDir,
  RIMAGENTIC_LEASE_GRACE_MS: "1", // no sticky grace: measure pure FIFO handoff
  RIMAGENTIC_LEASE_HEARTBEAT_MS: "300",
  RIMAGENTIC_LEASE_STALE_MS: "5000",
  RIMAGENTIC_LEASE_POLL_MS: "25",
};
// The parent's own lease module reads these live, for the in-process reentrancy check.
Object.assign(process.env, tuning);

const childEnv = { ...process.env, ...tuning };
const workerScript = path.join(__dirname, "game-lease-worker.js");

// Stagger spawns well wider than node's startup jitter so arrival order is deterministic,
// and hold longer than the stagger so each later worker is genuinely queued behind the holder.
const STAGGER_MS = 250;
const HOLD_MS = 400;
const N = 4;

// Returns a promise that resolves when the worker process exits. The exit listener is
// attached synchronously at spawn, so a fast worker that finishes before the spawn loop
// ends is still observed (attaching 'exit' after the process already exited never fires).
function spawnWorker(id) {
  const p = spawn(process.execPath, [workerScript, String(id), results, String(HOLD_MS)], {
    env: childEnv,
    stdio: "ignore",
  });
  return new Promise((res) => {
    p.on("exit", res);
    p.on("error", res);
  });
}

let passed = 0;
function check(label, cond) {
  assert.ok(cond, label);
  passed++;
  console.log("  ok -", label);
}

(async () => {
  const done = [];
  for (let i = 0; i < N; i++) {
    done.push(spawnWorker(i));
    await new Promise((r) => setTimeout(r, STAGGER_MS));
  }
  await Promise.all(done);

  const events = fs
    .readFileSync(results, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const acqs = events.filter((e) => e.ev === "acq");
  const errs = events.filter((e) => String(e.ev).startsWith("err"));

  check("no worker errored", errs.length === 0);
  check(`every worker acquired exactly once (${acqs.length}/${N})`, acqs.length === N);

  const acqOrder = acqs.map((e) => e.id);
  check(`acquired in FIFO arrival order (${acqOrder.join(",")})`, acqOrder.every((id, i) => id === i));

  // Mutual exclusion: [acq,rel] intervals must not overlap.
  const intervals = [];
  for (const e of events) {
    if (e.ev === "acq") intervals.push({ id: e.id, start: e.t, end: null });
    else if (e.ev === "rel") {
      const iv = intervals.find((x) => x.id === e.id && x.end === null);
      if (iv) iv.end = e.t;
    }
  }
  const closed = intervals.filter((iv) => iv.end != null).sort((a, b) => a.start - b.start);
  let overlap = false;
  for (let i = 1; i < closed.length; i++) if (closed[i].start < closed[i - 1].end) overlap = true;
  check("holds are mutually exclusive (no overlap)", !overlap);

  // In-process reentrancy: a nested acquire must reuse the held lease, not deadlock.
  const { withGameLease } = require(path.join(__dirname, "..", "build", "gameLease.js"));
  const nested = await withGameLease("outer", async () => await withGameLease("inner", async () => 42));
  check("reentrant nested acquire returns without deadlock", nested === 42);

  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(`\ngame-lease: ${passed} checks passed`);
})().catch((e) => {
  console.error(e);
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
