/*
 * Child worker for game-lease.test.js. Each worker is a SEPARATE process — the real
 * shape of the problem (every Claude session is its own MCP process) — that acquires
 * the cross-process FIFO game lease, records when it got in and out, holds briefly,
 * and releases. The parent asserts the recorded order is FIFO and non-overlapping.
 *
 *   node game-lease-worker.js <id> <resultsFile> <holdMs>
 */
const fs = require("fs");
const path = require("path");
const { withGameLease } = require(path.join(__dirname, "..", "build", "gameLease.js"));

const id = Number(process.argv[2]);
const resultsFile = process.argv[3];
const holdMs = Number(process.argv[4] || "400");

function record(ev) {
  fs.appendFileSync(resultsFile, JSON.stringify({ id, ev, pid: process.pid, t: Date.now() }) + "\n");
}

(async () => {
  await withGameLease(`worker-${id}`, async () => {
    record("acq");
    await new Promise((r) => setTimeout(r, holdMs));
    record("rel");
  });
  process.exit(0);
})().catch((e) => {
  record("err:" + (e && e.message));
  process.exit(1);
});
