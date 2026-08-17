/*
 * Multi-process contention test for the game IPC channel.
 *
 *   cd server && npm run build && npm run test:ipc
 *
 * Reproduces the real deployment: several MCP server processes (one per Claude
 * session) sharing ONE IPC directory with fixed filenames. A fake "game"
 * responder in the parent answers each tool_input.json by echoing the request's
 * query marker back in tool_output.json after a random delay. Each child fires
 * a burst of calls and asserts every response carries ITS OWN marker — before
 * the cross-process lock, concurrent children clobbered each other's requests
 * and stole each other's responses.
 *
 * Touches only a temp directory (RIMAGENTIC_IPC_DIR); no game, no real bridge.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { fork } = require("child_process");

const CHILDREN = 4;
const CALLS_PER_CHILD = 8;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- child mode
if (process.argv[2] === "--child") {
    const childId = process.argv[3];
    (async () => {
        const { handleGameIpcTool } = require(path.resolve(__dirname, "..", "build", "tools", "gameIpc.js"));
        for (let i = 0; i < CALLS_PER_CHILD; i++) {
            const marker = `marker-${childId}-${i}`;
            const res = await handleGameIpcTool("list_game_tools", { query: marker });
            const parsed = JSON.parse(res.content[0].text);
            if (parsed.echo !== marker) {
                console.error(`CHILD ${childId} MISMATCH: sent ${marker}, got ${JSON.stringify(parsed)}`);
                process.exit(1);
            }
        }
        process.exit(0);
    })().catch(err => { console.error(`CHILD ${childId} ERROR: ${err.message}`); process.exit(1); });
    return;
}

// --------------------------------------------------------------- parent mode
(async () => {
    const ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), "rimagentic-ipc-test-"));
    process.env.RIMAGENTIC_IPC_DIR = ipcDir;
    const inputFile = path.join(ipcDir, "tool_input.json");
    const outputFile = path.join(ipcDir, "tool_output.json");
    const lockFile = path.join(ipcDir, "bridge.lock");

    let fail = (msg) => { console.log(`FAIL: ${msg}`); process.exit(1); };

    // Fake game: consume tool_input.json, respond after a jittered delay with
    // the request's query echoed back. Also flag any input overwrite it can
    // detect (a second input arriving while it is still "executing").
    let busy = false;
    let overlapped = false;
    const responder = setInterval(async () => {
        if (!fs.existsSync(inputFile)) return;
        if (busy) { overlapped = true; return; }
        busy = true;
        try {
            const req = JSON.parse(fs.readFileSync(inputFile, "utf8"));
            fs.unlinkSync(inputFile);
            await sleep(30 + Math.random() * 120); // the game "executes"
            const echo = req.arguments && req.arguments.query;
            fs.writeFileSync(outputFile, JSON.stringify({ echo }), "utf8");
        } catch { /* partial write — next tick */ }
        busy = false;
    }, 15);

    // 1) Stale-lock breaking: a lock left by a dead pid must not wedge the channel.
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, label: "dead session", acquiredAt: Date.now() - 5000 }), "utf8");

    // 2) The contention run itself.
    const t0 = Date.now();
    const children = [];
    for (let c = 0; c < CHILDREN; c++) {
        children.push(new Promise(resolve => {
            const child = fork(__filename, ["--child", String(c)], { env: process.env, stdio: "inherit" });
            child.on("exit", code => resolve(code));
        }));
    }
    const codes = await Promise.all(children);
    clearInterval(responder);

    if (codes.some(c => c !== 0)) fail(`a child saw a mismatched or failed call (exit codes: ${codes.join(",")})`);
    if (overlapped) fail("the fake game saw a second request arrive while one was executing — lock did not serialize");
    if (fs.existsSync(lockFile)) fail("bridge.lock was left behind after all calls completed");
    console.log(`PASS: ${CHILDREN * CALLS_PER_CHILD} calls from ${CHILDREN} processes, every response matched its request (${Date.now() - t0}ms)`);

    // 3) Ghost-command withdrawal: with no responder, an unconsumed request
    //    must be withdrawn from the IPC dir once the call times out.
    const { requestBridgeStatus } = require(path.resolve(__dirname, "..", "build", "tools", "gameIpc.js"));
    const st = await requestBridgeStatus(600); // no game -> null, swallowed error
    if (st !== null) fail("requestBridgeStatus returned a value with no game running");
    if (fs.existsSync(inputFile)) fail("timed-out request was left in the IPC dir (ghost-execution hazard)");
    console.log("PASS: timed-out request withdrawn from the IPC dir");

    fs.rmSync(ipcDir, { recursive: true, force: true });
    process.exit(0);
})().catch(err => { console.log(`FAIL: ${err.stack || err}`); process.exit(1); });
