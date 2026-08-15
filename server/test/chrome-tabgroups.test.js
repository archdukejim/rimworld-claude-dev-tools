/*
 * Exercise the extension's tab/group hygiene against a LIVE RimAgentic Chrome.
 *
 *   cd server && npm run build && npm run test:chrome
 *
 * Launches the browser if it isn't already up. Unlike the imgur stub test this needs a real browser —
 * chrome.tabGroups has no mock. It drives the extension's service worker directly over CDP
 * (Runtime.evaluate on self.RIMAGENTIC_TABS), which is the same code the loopback bridge calls for
 * chrome_tabs / chrome_tidy.
 *
 * It opens and closes tabs in the dedicated RimAgentic profile ONLY — never your normal browsing.
 */
const PORT = Number(process.env.RIMAGENTIC_CDP_PORT) || 9222;

async function targets() { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

function connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const ready = new Promise(r => (ws.onopen = r));
    const send = (method, params) => {
        const myId = ++id;
        return new Promise((res, rej) => {
            const h = e => {
                const m = JSON.parse(e.data);
                if (m.id !== myId) return;
                ws.removeEventListener("message", h);
                m.error ? rej(new Error(m.error.message)) : res(m.result);
            };
            ws.addEventListener("message", h);
            ws.send(JSON.stringify({ id: myId, method, params }));
        });
    };
    return { ws, ready, send };
}

(async () => {
    // Make sure the browser + extension are up; the launcher is idempotent when they already are.
    const { handleChromeCtlTool } = require(require("path").resolve(__dirname, "..", "build", "tools", "chromeCtl.js"));
    const launch = JSON.parse((await handleChromeCtlTool("launch_chrome", { port: PORT }, null)).content[0].text);
    if (!launch.running) { console.log("FAIL: couldn't launch Chrome\n" + JSON.stringify(launch, null, 2)); process.exit(1); }
    await sleep(1500);

    // Open a working set: a duplicate pair, two same-site tabs, and a lone one.
    const urls = [
        "https://imgur.com/", "https://imgur.com/",
        "https://github.com/", "https://github.com/archdukejim",
        "https://steamcommunity.com/"
    ];
    for (const u of urls) {
        await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(u)}`, { method: "PUT" });
        await sleep(250);
    }
    await sleep(2500);

    const sw = (await targets()).find(t => /^chrome-extension:\/\/[a-p]{32}\/src\/background\.js$/.test(t.url));
    if (!sw) { console.log("FAIL: our extension service worker is not running"); process.exit(1); }
    console.log("service worker:", sw.url);

    const { ws, ready, send } = connect(sw.webSocketDebuggerUrl);
    await ready;
    const evalIn = async expr => {
        const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + JSON.stringify(r.exceptionDetails.exception?.description || ""));
        return r.result.value;
    };

    const results = [];
    const check = (label, cond, detail) => {
        results.push(cond);
        console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "  <- " + detail}`);
    };

    check("RIMAGENTIC_TABS registered in the worker", await evalIn("!!self.RIMAGENTIC_TABS"), "importScripts failed");

    const before = await evalIn("self.RIMAGENTIC_TABS.tabsInventory()");
    console.log("before:", JSON.stringify({ tabs: before.tabCount, groups: before.groups.length, dups: before.duplicates.length }));
    check("inventory sees the tabs", before.tabCount >= 5, JSON.stringify(before.tabCount));
    check("inventory detects the duplicate", before.duplicates.length >= 1, JSON.stringify(before.duplicates));

    const plan = await evalIn("self.RIMAGENTIC_TABS.tabsTidy({dryRun:true, maxAgeMinutes:0})");
    check("dryRun changes nothing", plan.dryRun === true, JSON.stringify(plan).slice(0, 120));
    const afterDry = await evalIn("self.RIMAGENTIC_TABS.tabsInventory()");
    check("dryRun really left tabs alone", afterDry.tabCount === before.tabCount, `${before.tabCount} -> ${afterDry.tabCount}`);
    check("plan groups github", plan.groups.some(g => g.name === "github" && g.tabs === 2), JSON.stringify(plan.groups));
    check("plan closes the duplicate", plan.closing.some(c => /duplicate/.test(c.reason)), JSON.stringify(plan.closing));

    const applied = await evalIn("self.RIMAGENTIC_TABS.tabsTidy({maxAgeMinutes:0})");
    console.log("applied:", JSON.stringify({ closed: applied.closed, groups: applied.groups }));
    check("closed the duplicate", applied.closed >= 1, JSON.stringify(applied.closed));
    check("created a github group", applied.groups.some(g => g.name === "github" && g.groupId !== undefined), JSON.stringify(applied.groups));

    const after = await evalIn("self.RIMAGENTIC_TABS.tabsInventory()");
    const gh = after.groups.find(g => g.title === "github");
    check("github group exists with 2 tabs", !!gh && gh.tabs.length === 2, JSON.stringify(after.groups.map(g => [g.title, g.tabs.length])));
    check("no singleton groups survive", after.singletonGroups.length === 0, JSON.stringify(after.singletonGroups));
    check("no empty groups survive", after.emptyGroups.length === 0, JSON.stringify(after.emptyGroups));

    // Idempotence: a second tidy on a clean window must not thrash.
    const second = await evalIn("self.RIMAGENTIC_TABS.tabsTidy({maxAgeMinutes:0})");
    check("second tidy closes nothing", second.closed === 0, JSON.stringify(second.closedDetail));
    const after2 = await evalIn("self.RIMAGENTIC_TABS.tabsInventory()");
    check("group survives re-tidy (reused, not recreated)", (after2.groups.find(g => g.title === "github") || {}).id === gh.id,
        JSON.stringify({ was: gh.id, now: (after2.groups.find(g => g.title === "github") || {}).id }));

    // Age-based closing.
    const aged = await evalIn("self.RIMAGENTIC_TABS.tabsTidy({maxAgeMinutes:0.0001, keep:['github.com/archdukejim']})");
    const after3 = await evalIn("self.RIMAGENTIC_TABS.tabsInventory()");
    check("age sweep closed stale tabs", aged.closed >= 1, JSON.stringify(aged.closedDetail));
    check("keep-list protected its tab", after3.groups.concat([{ tabs: after3.ungrouped }]).some(g => g.tabs.some(t => t.url.includes("archdukejim"))),
        JSON.stringify(after3.ungrouped.map(t => t.url)));
    check("never closed the last tab", after3.tabCount >= 1, String(after3.tabCount));

    ws.close();
    const failed = results.filter(r => !r).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.log("ERR", e.message); process.exit(1); });
