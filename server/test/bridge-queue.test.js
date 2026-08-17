/*
 * Multi-session test for the Steam loopback bridge: owner + proxy + fake extension.
 *
 *   cd server && npm run build && npm run test:bridge
 *
 * Simulates the real deployment on a test port: one process binds the port
 * (owner), a second Bridge is created via connectBridge and must come back as
 * a PROXY that relays through the owner. A fake extension long-polls like the
 * real service worker. Asserts:
 *   1. calls from owner and proxy all resolve with their own results, and the
 *      extension never receives a second command while one is unanswered;
 *   2. an extension reconnect mid-command REPLAYS an idempotent method;
 *   3. ...but FAILS FAST a non-idempotent one (postComment) with a
 *      "may have executed" error, never re-delivering it;
 *   4. when the owner closes, the proxy promotes itself and keeps serving.
 *
 * No real browser, no Steam — everything on 127.0.0.1.
 */
const path = require("path");
const { startBridge, connectBridge } = require(path.resolve(__dirname, "..", "build", "bridge.js"));

const PORT = 8899;
const config = {
    defaultProjectId: "", organization: "",
    bridgeHost: "127.0.0.1", bridgePort: PORT,
    pollTimeoutMs: 1000, callTimeoutMs: 4000,
};
const base = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fail = msg => { console.log(`FAIL: ${msg}`); process.exit(1); };

/* Fake extension: poll -> execute -> respond, one command at a time (like the
 * real MV3 worker). Configurable to "die" mid-command to trigger replay. */
function makeExtension() {
    const ext = { running: true, concurrent: 0, maxConcurrent: 0, executed: [], dropNext: 0 };
    (async () => {
        while (ext.running) {
            let resp;
            try { resp = await fetch(`${base}/poll`); } catch { await sleep(100); continue; }
            if (resp.status !== 200) continue;
            let cmd;
            try { cmd = (await resp.json()).command; } catch { continue; }
            if (!cmd) continue;
            ext.concurrent++;
            ext.maxConcurrent = Math.max(ext.maxConcurrent, ext.concurrent);
            await sleep(50); // "execute"
            ext.executed.push(cmd.method);
            ext.concurrent--;
            if (ext.dropNext > 0) { ext.dropNext--; continue; } // die: no /result, re-poll
            try {
                await fetch(`${base}/result`, {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ id: cmd.id, ok: true, result: { ran: cmd.method, echo: cmd.args && cmd.args.n } }),
                });
            } catch { /* owner gone; next poll reconnects */ }
        }
    })();
    return ext;
}

(async () => {
    // --- setup: owner binds, second connect must become a proxy -------------
    const owner = await startBridge(config);
    const proxy = await connectBridge(config);
    const proxySt = await proxy.status();
    if (proxySt.mode !== "proxy") fail(`second connectBridge should be a proxy, got mode=${proxySt.mode}`);

    const ext = makeExtension();
    await sleep(200); // let the first poll land

    // --- 1) interleaved owner + proxy calls all serialize and match ---------
    const calls = [];
    for (let i = 0; i < 5; i++) {
        calls.push(owner.call("getContext", { n: `o${i}` }).then(r => ({ from: "owner", sent: `o${i}`, got: r.echo })));
        calls.push(proxy.call("getContext", { n: `p${i}` }).then(r => ({ from: "proxy", sent: `p${i}`, got: r.echo })));
    }
    const results = await Promise.all(calls);
    for (const r of results) if (r.got !== r.sent) fail(`${r.from} sent ${r.sent} but got ${r.got}`);
    if (ext.maxConcurrent > 1) fail(`extension saw ${ext.maxConcurrent} concurrent commands — queue did not serialize`);
    console.log(`PASS: ${results.length} interleaved owner+proxy calls serialized, every result matched its call`);

    // --- 2) reconnect mid-command replays an idempotent method --------------
    ext.dropNext = 1; // execute but "die" before posting the result
    const replayed = await proxy.call("listComments", { n: "replay-me" });
    if (replayed.echo !== "replay-me") fail(`replay returned wrong result: ${JSON.stringify(replayed)}`);
    const deliveries = ext.executed.filter(m => m === "listComments").length;
    if (deliveries !== 2) fail(`idempotent command should be delivered twice (lost + replay), saw ${deliveries}`);
    console.log("PASS: idempotent command replayed transparently after a lost delivery");

    // --- 3) non-idempotent commands fail fast, never re-deliver -------------
    ext.dropNext = 1;
    let rejected = null;
    try { await owner.call("postComment", { n: "danger" }); } catch (e) { rejected = e; }
    if (!rejected || !/MAY have executed/.test(rejected.message)) {
        fail(`postComment after lost delivery should fail with 'MAY have executed', got: ${rejected && rejected.message}`);
    }
    await sleep(300); // give a (wrong) replay time to happen
    const posts = ext.executed.filter(m => m === "postComment").length;
    if (posts !== 1) fail(`postComment must never be re-delivered; extension executed it ${posts} times`);
    console.log("PASS: non-idempotent command failed fast with an honest 'may have executed' error");

    // --- 4) owner dies -> proxy promotes itself and keeps serving -----------
    await owner.close();
    const afterPromo = await proxy.call("getContext", { n: "promoted" });
    if (afterPromo.echo !== "promoted") fail(`post-promotion call returned ${JSON.stringify(afterPromo)}`);
    const promoSt = await proxy.status();
    if (promoSt.mode !== "owner") fail(`proxy should report mode=owner after promotion, got ${promoSt.mode}`);
    console.log("PASS: proxy promoted itself to owner after the previous owner exited");

    ext.running = false;
    await proxy.close();
    console.log("PASS: all bridge multi-session scenarios");
    process.exit(0);
})().catch(err => { console.log(`FAIL: ${err.stack || err}`); process.exit(1); });
