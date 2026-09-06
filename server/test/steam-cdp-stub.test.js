/*
 * Steam Workshop publish path against a STUB DevTools endpoint.
 *
 *   cd server && npm run build && npm run test:steam
 *
 * Runs the real handlers from build/ (workshop.js, workshopImages.js, bridge.js, steamLogic.js), but
 * points RIMAGENTIC_CDP_BASE at a local stub that speaks just enough of the DevTools protocol
 * (/json/new, /json/close, a websocket doing Page.enable / Runtime.enable / Page.navigate /
 * Runtime.evaluate). The stub cannot run JavaScript, so it answers Runtime.evaluate by the
 * `swh:<probe>` marker every expression in steamCdp.ts carries, with canned page state. Nothing
 * touches steamcommunity.com, the RimAgentic Chrome, or the real bridge port.
 *
 * Covers: route selection (bridge vs DevTools fallback, bridge-call failure, nothing available),
 * the 8,000-character cap refusal, moderation-state parsing (all four notices), changelog-block
 * extraction, the find-or-create Changelog thread plan (dry run), a full description update +
 * public-page verification, a confirmed changelog post (create + reply + pin), the compose
 * guardrails, and the bridge's owner / proxy / unavailable modes.
 */
const http = require("http");
const net = require("net");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");

const build = (f) => require(path.resolve(__dirname, "..", "build", f));

const results = [];
function check(label, cond, detail) {
    results.push({ label, pass: !!cond });
    console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "  <- " + (typeof detail === "string" ? detail : JSON.stringify(detail))}`);
}

// ---------------------------------------------------------------------------- page state

const FILE_ID = "3784666060";
const FORUM_ID = `PublishedFile_25160263_${FILE_ID}`;
const DESC = [
    "[h1]Regions and Societies[/h1]",
    "[b]Version:[/b] v0.3.2 (Target: RimWorld 1.6)",
    "",
    "[h2]Changelog (v0.3.2) - Compatibility patch[/h2]",
    "[list]",
    "[*] [b]Fixed:[/b] one thing.",
    "[/list]",
    "",
    "[h2]Changelog (v0.3.1) - Worldgen hotfix[/h2]",
    "[list]",
    "[*] [b]Fixed:[/b] another thing.",
    "[/list]",
    "",
    "[b]Full version history:[/b] [url=https://github.com/Regions-and-societies/Core-MMF/wiki/Changelog]github.com/Regions-and-societies/Core-MMF/wiki[/url]",
].join("\n");

const state = {
    loggedIn: true, owner: true,
    description: DESC, pendingDescription: null, saveError: "",
    moderationText: "",
    threads: [], posts: [], pinOnClick: true,
    log: [],
};
const bbToText = (s) => s.replace(/\[\/?[a-z0-9*=\/:.\-_ ]+\]/gi, "").replace(/\[url=[^\]]+\]/gi, "");

// Pull the JSON string literal assigned to `<var>.value = "..."` out of an expression.
function assigned(expr, varName) {
    const m = expr.match(new RegExp(varName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\.value = (\"(?:[^\"\\\\]|\\\\.)*\")"));
    return m ? JSON.parse(m[1]) : null;
}

let topicSeq = 100;
function threadUrl(id) { return `https://steamcommunity.com/workshop/filedetails/discussion/${FILE_ID}/${id}/`; }

/** Canned answer for a probe on a target. May return { value, emitLoad, navigateTo }. */
function answer(target, probe, expr) {
    const url = target.url;
    switch (probe) {
        case "auth": return { value: { loggedIn: state.loggedIn, steamId: state.loggedIn ? "76561198000000000" : null, accountId: "1", accountName: state.loggedIn ? "archdukejim" : null } };
        case "openItem": return { value: { title: "Steam Workshop::Regions and Societies", url, loggedIn: state.loggedIn } };
        case "editProbe": return { value: { url, title: "Edit", loggedIn: state.loggedIn, hasTextarea: state.loggedIn && state.owner, description: state.description, itemTitle: "Regions and Societies", visibility: "0", error: "" } };
        case "setDescription": state.pendingDescription = assigned(expr, "ta"); return { value: state.pendingDescription.length };
        case "clickSave":
            state.log.push({ save: state.pendingDescription });
            if (!state.saveError) state.description = state.pendingDescription;
            return { value: "clicked:btn_green_white_innerfade", emitLoad: true, navigateTo: "https://steamcommunity.com/sharedfiles/itemedittext/" };
        case "afterSave": return { value: { url, error: state.saveError } };
        case "publicRead": {
            const descriptionText = bbToText(state.description);
            return { value: { url, title: "Steam Workshop::Regions and Societies", descriptionText, bodyText: `STORE\nCOMMUNITY\n${state.moderationText}\n${descriptionText}\nUpdated\n5 Sep @ 1:00pm`, updated: "5 Sep @ 1:00pm" } };
        }
        case "threads": return { value: { url, loggedIn: state.loggedIn, forumId: FORUM_ID, canStart: state.loggedIn, threads: state.threads.map(t => ({ ...t })) } };
        case "openNewTopic": return { value: "ok" };
        case "fillNewTopic": state.pendingTopic = { title: assigned(expr, "title"), body: assigned(expr, "ta") }; return { value: "ok" };
        case "submitNewTopic": {
            const id = String(++topicSeq);
            const t = { name: state.pendingTopic.title, href: threadUrl(id), pinned: false, replies: "0", id };
            state.threads.push(t);
            state.posts.push({ thread: id, id: `comment_op_${id}`, body: state.pendingTopic.body });
            state.log.push({ createThread: t.name, firstPost: state.pendingTopic.body });
            return { value: "ok", emitLoad: true, navigateTo: t.href };
        }
        case "afterNewTopic": return { value: { url, error: "" } };
        case "postsBefore": return { value: postsOn(url).map(p => p.id) };
        case "fillReply": {
            const id = (url.match(/discussion\/\d+\/(\d+)/) || [])[1];
            const body = assigned(expr, "ta");
            const pid = `comment_${id}_${state.posts.length + 1}`;
            state.posts.push({ thread: id, id: pid, body });
            state.log.push({ reply: body, thread: id });
            return { value: "ok" };
        }
        case "postsAfter": return { value: { ids: postsOn(url).map(p => p.id), error: "" } };
        case "threadUrl": return { value: url };
        case "openAdminMenu": return { value: state.owner ? "ok" : "no-admin-menu" };
        case "clickPin": {
            const id = (url.match(/discussion\/\d+\/(\d+)/) || [])[1];
            const t = state.threads.find(x => x.id === id);
            if (t && state.pinOnClick) t.pinned = true;
            state.log.push({ pin: id });
            return { value: "clicked:Pin" };
        }
        default: throw new Error(`stub has no answer for probe '${probe}'`);
    }
}
function postsOn(url) {
    const id = (url.match(/discussion\/\d+\/(\d+)/) || [])[1];
    return state.posts.filter(p => p.thread === id && p.id.startsWith("comment_") && !p.id.startsWith("comment_op_"));
}

// ---------------------------------------------------------------------------- stub DevTools endpoint

const targets = new Map();
let targetSeq = 0;
const stub = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (u.pathname === "/json/version") return json(200, { Browser: "stub/1", webSocketDebuggerUrl: `ws://127.0.0.1:${stub.address().port}/devtools/browser/x` });
    if (u.pathname === "/json/new" && req.method === "PUT") {
        const id = `T${++targetSeq}`;
        const url = decodeURIComponent(u.search.replace(/^\?/, ""));
        targets.set(id, { id, url, open: true });
        return json(200, { id, type: "page", url, webSocketDebuggerUrl: `ws://127.0.0.1:${stub.address().port}/devtools/page/${id}` });
    }
    if (u.pathname.startsWith("/json/close/")) {
        const t = targets.get(u.pathname.split("/").pop());
        if (t) t.open = false;
        res.writeHead(200); return res.end("Target is closing");
    }
    json(404, { error: "no stub for " + req.url });
});

// Minimal RFC 6455 server: handshake, masked client frames (any length), unmasked text replies.
stub.on("upgrade", (req, socket) => {
    const id = req.url.split("/").pop();
    const target = targets.get(id);
    if (!target) { socket.destroy(); return; }
    const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
    const send = (obj) => {
        const payload = Buffer.from(JSON.stringify(obj));
        let header;
        if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
        else if (payload.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2); }
        else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
        socket.write(Buffer.concat([header, payload]));
    };
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
            if (buf.length < 2) return;
            const opcode = buf[0] & 0x0f;
            const masked = (buf[1] & 0x80) !== 0;
            let len = buf[1] & 0x7f, off = 2;
            if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
            else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
            const maskLen = masked ? 4 : 0;
            if (buf.length < off + maskLen + len) return;
            const mask = masked ? buf.subarray(off, off + 4) : null;
            const payload = Buffer.from(buf.subarray(off + maskLen, off + maskLen + len));
            if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
            buf = buf.subarray(off + maskLen + len);
            if (opcode === 8) { socket.end(); return; }
            if (opcode !== 1) continue;
            let msg; try { msg = JSON.parse(payload.toString("utf8")); } catch { continue; }
            handle(msg);
        }
    });
    socket.on("error", () => {});
    function handle(msg) {
        const { id, method, params } = msg;
        if (method === "Page.enable") { send({ id, result: {} }); setTimeout(() => send({ method: "Page.loadEventFired", params: { timestamp: 1 } }), 20); return; }
        if (method === "Runtime.enable") { send({ id, result: {} }); return; }
        if (method === "Page.navigate") { target.url = params.url; send({ id, result: { frameId: "f" } }); setTimeout(() => send({ method: "Page.loadEventFired", params: { timestamp: 2 } }), 20); return; }
        if (method === "Runtime.evaluate") {
            const m = String(params.expression).match(/^\/\* swh:([a-zA-Z]+) \*\//);
            if (!m) { send({ id, error: { message: "expression has no swh:<probe> marker" } }); return; }
            let a;
            try { a = answer(target, m[1], params.expression); }
            catch (e) { send({ id, result: { result: { type: "undefined" }, exceptionDetails: { text: e.message } } }); return; }
            send({ id, result: { result: { type: typeof a.value === "object" ? "object" : typeof a.value, value: a.value } } });
            if (a.navigateTo) target.url = a.navigateTo;
            if (a.emitLoad) setTimeout(() => send({ method: "Page.loadEventFired", params: { timestamp: 3 } }), 20);
            return;
        }
        send({ id, error: { message: "stub: unknown method " + method } });
    }
});

// ---------------------------------------------------------------------------- tests

const fakeBridge = (opts) => ({
    mode: "owner",
    status: () => ({ mode: "owner", connected: opts.connected, queued: 0, pending: 0, lastPollAt: 0, endpoint: "http://127.0.0.1:0", note: "fake" }),
    refresh: async function () { return this.status(); },
    call: opts.call || (async () => { throw new Error("fake bridge has no call"); }),
    close: async () => {},
});

stub.listen(0, "127.0.0.1", async () => {
    process.env.RIMAGENTIC_CDP_BASE = `http://127.0.0.1:${stub.address().port}`;
    process.env.RIMAGENTIC_CDP_SETTLE_MS = "10";
    process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "steam-e2e-"));

    const { handleSwhTool, chooseRoute } = build("tools/workshop.js");
    const { handleWorkshopImageTool } = build("tools/workshopImages.js");
    const logic = build("steamLogic.js");
    const { startBridge } = build("bridge.js");
    const call = async (n, a, bridge = null) => {
        const txt = (await handleSwhTool(n, a, bridge)).content[0].text;
        try { return JSON.parse(txt); } catch { return txt; }
    };
    const failing = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message || e); } };

    try {
        // 1. route selection --------------------------------------------------------------
        const r1 = await chooseRoute(null, undefined);
        check("no bridge + Chrome up -> devtools", r1.route === "devtools", r1);
        const r2 = await chooseRoute(fakeBridge({ connected: true }), undefined);
        check("connected bridge -> bridge", r2.route === "bridge", r2);
        const r3 = await chooseRoute(fakeBridge({ connected: false }), undefined);
        check("disconnected bridge + Chrome up -> devtools", r3.route === "devtools", r3);
        const authViaBridge = await call("swh_get_auth", {}, fakeBridge({ connected: true, call: async (m) => ({ loggedIn: true, steamId: "1", accountName: "viaBridge", m }) }));
        check("swh_get_auth uses the bridge when connected", authViaBridge.route === "bridge" && authViaBridge.accountName === "viaBridge", authViaBridge);
        const authFallback = await call("swh_get_auth", {}, fakeBridge({ connected: true, call: async () => { throw new Error("extension timed out"); } }));
        check("bridge call failure falls back to devtools and reports bridgeError", authFallback.route === "devtools" && authFallback.loggedIn === true && /timed out/.test(authFallback.bridgeError), authFallback);
        const authCdp = await call("swh_get_auth", {});
        check("swh_get_auth via devtools -> loggedIn true, accountName", authCdp.route === "devtools" && authCdp.loggedIn === true && authCdp.accountName === "archdukejim", authCdp);
        const saved = process.env.RIMAGENTIC_CDP_BASE;
        process.env.RIMAGENTIC_CDP_BASE = "http://127.0.0.1:1";
        const none = await failing(() => call("swh_get_auth", {}, fakeBridge({ connected: false })));
        check("no bridge, no Chrome -> error names launch_chrome", /launch_chrome/.test(none || ""), none);
        process.env.RIMAGENTIC_CDP_BASE = saved;
        const bridgeOnly = await failing(() => call("swh_list_comments", { fileId: FILE_ID }, fakeBridge({ connected: false })));
        check("bridge-only tool explains how the bridge starts", /8766\/poll/.test(bridgeOnly || ""), bridgeOnly);

        // 2. swh_get_item -------------------------------------------------------------------
        const item = await call("swh_get_item", { fileId: FILE_ID });
        check("swh_get_item returns the current description + chars", item.description === DESC && item.chars === DESC.length && item.route === "devtools", { chars: item.chars, route: item.route });
        state.owner = false;
        const notOwner = await failing(() => call("swh_get_item", { fileId: FILE_ID }));
        check("swh_get_item without the edit form says owner-only", /owner/.test(notOwner || ""), notOwner);
        state.owner = true;

        // 3. cap refusal ------------------------------------------------------------------
        state.log = [];
        const big = DESC + "\n" + "x".repeat(logic.DESCRIPTION_CAP - DESC.length + 41);
        const refused = await call("swh_update_description", { fileId: FILE_ID, description: big });
        check("over-cap description is refused, names the overage and the trim rule",
            refused.ok === false && refused.refused === true && refused.over === big.length - logic.DESCRIPTION_CAP && new RegExp(refused.over + " over").test(refused.error) && /oldest/.test(refused.error) && /Full version history/.test(refused.error), refused);
        check("cap refusal happened before any save", state.log.length === 0 && state.description === DESC, state.log);
        const capLogic = logic.checkDescriptionCap("y".repeat(8000));
        check("exactly 8000 chars passes the cap", capLogic.ok === true && capLogic.over === 0, capLogic);

        // 4. moderation parsing ---------------------------------------------------------
        const M = logic.parseModeration;
        check("moderation: awaiting analysis", M("blah\nThis item is currently awaiting analysis by our automated content check system.\nmore").state === "awaiting_analysis");
        check("moderation: removed", M("This item has been removed from the community because it violates Steam Community & Content Guidelines. It is only visible to you.").state === "removed");
        check("moderation: hidden", M("Error\nThe item is either marked as hidden or you do not have permission to view it.").state === "hidden");
        check("moderation: incompatible", M("This item is incompatible with RimWorld. Please see the instructions page for reasons why this item might not work within RimWorld.").state === "incompatible");
        check("moderation: visible when no notice", M("STORE\nCOMMUNITY\nRegions and Societies\nVersion: v0.3.2").state === "visible");
        check("moderation notice text is the matched line", /awaiting analysis/.test(M("x\nThis item is currently awaiting analysis by our automated content check system.\ny").notice));
        state.moderationText = "This item is currently awaiting analysis by our automated content check system.";
        const mod = await call("swh_get_moderation_state", { fileId: FILE_ID });
        check("swh_get_moderation_state reads the owner-visible notice + version line", mod.state === "awaiting_analysis" && /awaiting analysis/.test(mod.notice) && mod.versionLine === "v0.3.2 (Target: RimWorld 1.6)", mod);
        state.moderationText = "";

        // 5. changelog block extraction ------------------------------------------------------
        const descPath = path.join(process.env.LOCALAPPDATA, "steam_description.txt");
        fs.writeFileSync(descPath, "﻿" + DESC.replace(/\n/g, "\r\n"));
        const block = await call("extract_changelog_block", { steamDescriptionPath: descPath, version: "v0.3.2" });
        const expectedBlock = "[h2]Changelog (v0.3.2) - Compatibility patch[/h2]\n[list]\n[*] [b]Fixed:[/b] one thing.\n[/list]";
        check("extract_changelog_block is byte-identical to the description block (BOM/CRLF normalised)", block.block === expectedBlock && block.chars === expectedBlock.length, block);
        check("extract_changelog_block finds the wiki link", block.wikiUrl === "https://github.com/Regions-and-societies/Core-MMF/wiki/Changelog", block.wikiUrl);
        const missing = await failing(() => call("extract_changelog_block", { steamDescriptionPath: descPath, version: "9.9.9" }));
        check("missing version lists the versions present", /versions present: 0\.3\.2, 0\.3\.1/.test(missing || ""), missing);
        check("logic: extracts the OLDER block too", logic.extractChangelogBlock(DESC, "0.3.1").block.startsWith("[h2]Changelog (v0.3.1)"));

        // 6. find-or-create plan (pure) -----------------------------------------------------
        const P = logic.planChangelogThread;
        check("plan: no threads -> create", P([], "b").action === "create");
        check("plan: 'changelog' (lower-case) thread -> reply", P([{ name: "changelog", href: "u" }], "b").action === "reply");
        check("plan: 'PINNED: Changelog' row -> reply", P([{ name: "PINNED: Changelog", href: "u", pinned: true }], "b").action === "reply");
        const two = P([{ name: "Changelog", href: "old" }, { name: "Changelog", href: "pinned", pinned: true }], "b");
        check("plan: prefers the pinned thread over an earlier unpinned one", two.thread.href === "pinned", two);
        check("plan: unrelated threads -> create", P([{ name: "Bug reports", href: "u" }], "b").action === "create");
        check("plan: first post links the wiki", /\[url=https:\/\/x\/wiki\/Changelog\]/.test(P([], "b", { wikiUrl: "https://x/wiki/Changelog" }).firstPost));

        // 7. dry-run through the stub -------------------------------------------------------
        state.threads = []; state.log = [];
        const dry = await call("swh_post_changelog", { fileId: FILE_ID, steamDescriptionPath: descPath, version: "0.3.2" });
        check("dry run (default) creates nothing", dry.dryRun === true && state.log.length === 0 && state.threads.length === 0, dry);
        check("dry run says it would create the Changelog thread and shows the block", dry.action === "create" && /create thread "Changelog"/.test(dry.would) && dry.reply === expectedBlock && dry.forumId === FORUM_ID, dry);
        check("dry run first post links the wiki Changelog page", /Core-MMF\/wiki\/Changelog/.test(dry.firstPost), dry.firstPost);
        const noConsent = await failing(() => call("swh_post_changelog", { fileId: FILE_ID, bbcode: "x", dryRun: false }));
        check("dryRun:false without confirm is refused", /confirm:true/.test(noConsent || ""), noConsent);
        state.threads = [{ name: "changelog", href: threadUrl("55"), pinned: false, replies: "2", id: "55" }];
        const dry2 = await call("swh_post_changelog", { fileId: FILE_ID, bbcode: "[b]v9[/b]" });
        check("dry run with an existing thread plans a reply on it", dry2.action === "reply" && dry2.thread.href === threadUrl("55") && /reply on existing thread/.test(dry2.would), dry2);

        // 8. confirmed post: create + reply + pin -----------------------------------------
        state.threads = []; state.posts = []; state.log = [];
        const posted = await call("swh_post_changelog", { fileId: FILE_ID, steamDescriptionPath: descPath, version: "0.3.2", confirm: true });
        check("confirmed post creates the thread, replies with the block, pins it",
            posted.ok === true && posted.created === true && state.log.some(l => l.createThread === "Changelog") && state.log.some(l => l.reply === expectedBlock) && posted.pinned === true && /#c/.test(posted.postUrl) && posted.threadUrl === state.threads[0].href, { posted, log: state.log });
        state.log = [];
        const posted2 = await call("swh_post_changelog", { fileId: FILE_ID, bbcode: "[b]v0.3.3[/b]", confirm: true });
        check("second post replies on the now-pinned thread without creating another", posted2.created === false && state.threads.length === 1 && state.log.some(l => l.reply === "[b]v0.3.3[/b]") && posted2.pinned === true && posted2.pinNote === "already pinned", { posted2, log: state.log });

        // 9. full description update + verification ------------------------------------------
        state.log = [];
        const newDesc = DESC.replace("v0.3.2 (Target", "v0.3.3 (Target");
        const upd = await call("swh_update_description", { fileId: FILE_ID, description: newDesc });
        check("swh_update_description saves via devtools and verifies the version line on the public page",
            upd.ok === true && upd.verified === true && upd.route === "devtools" && upd.versionLine === "v0.3.3 (Target: RimWorld 1.6)" && upd.moderation.state === "visible" && upd.previousChars === DESC.length && state.description === newDesc, upd);
        state.saveError = "Access Denied";
        const denied = await failing(() => call("swh_update_description", { fileId: FILE_ID, description: DESC }));
        check("Access Denied on save is surfaced with the moderation hint", /Access Denied/.test(denied || "") && /moderation/.test(denied || ""), denied);
        state.saveError = "";
        const viaBridgeUpd = await call("swh_update_description", { fileId: FILE_ID, description: DESC }, fakeBridge({ connected: true, call: async (m, a) => { if (m === "getItem") return { description: "old" }; if (m === "updateDescription") { state.description = a.description; return { ok: true, verified: true }; } throw new Error("unexpected " + m); } }));
        check("swh_update_description via the bridge still verifies on the public page through devtools", viaBridgeUpd.route === "bridge" && viaBridgeUpd.verified === true && viaBridgeUpd.previousChars === 3, viaBridgeUpd);
        const unknownDomain = await call("swh_update_description", { fileId: FILE_ID, description: DESC + "\n[url=https://polyformproject.org/licenses/x]licence[/url]" });
        check("unfamiliar link domain produces a warning (not a refusal)", unknownDomain.ok === true && unknownDomain.warnings.length === 1 && /recognise: https:\/\/polyformproject\.org\/licenses\/x\. Steam/.test(unknownDomain.warnings[0]) && /re-scans/.test(unknownDomain.warnings[0]), unknownDomain.warnings);

        // 10. compose guardrails --------------------------------------------------------------
        const composeCall = async (a) => JSON.parse((await handleWorkshopImageTool("compose_workshop_bbcode", a)).content[0].text);
        const c1 = await composeCall({ images: [{ url: "https://i.imgur.com/abc.png", caption: "x" }], existing: "y".repeat(7990) });
        check("compose refuses over the cap with the overage", c1.ok === false && c1.over > 0 && /over Steam/.test(c1.error), c1);
        const c2 = await composeCall({ images: [{ url: "https://i.imgur.com/abc.png" }], intro: "see https://polyformproject.org/x and https://github.com/a/b" });
        check("compose warns on unknown domains and lists links", c2.ok === true && c2.warnings.length === 1 && /recognise: https:\/\/polyformproject\.org\/x\. Steam/.test(c2.warnings[0]) && c2.links.length === 3, c2);
        const c3 = await composeCall({ images: [{ url: "https://i.imgur.com/abc.png" }], intro: "https://ko-fi.com/archdukejim https://steamcommunity.com/x https://discord.gg/y" });
        check("compose is clean for well-known domains", c3.ok === true && c3.warnings.length === 0, c3);

        // 11. bridge modes ---------------------------------------------------------------------
        const holder = net.createServer(); await new Promise(r => holder.listen(0, "127.0.0.1", r));
        const cfg = (port) => ({ bridgeHost: "127.0.0.1", bridgePort: port, pollTimeoutMs: 200, callTimeoutMs: 300 });
        const busyPort = holder.address().port;
        const b0 = await startBridge(cfg(busyPort));
        check("port held by a non-bridge -> mode unavailable with a note", b0.mode === "unavailable" && b0.status().connected === false && /not a RimAgentic bridge/.test(b0.status().note), b0.status());
        holder.close();
        const free = net.createServer(); await new Promise(r => free.listen(0, "127.0.0.1", r)); const freePort = free.address().port; await new Promise(r => free.close(r));
        const owner = await startBridge(cfg(freePort));
        check("first server on the port -> owner", owner.mode === "owner" && owner.status().connected === false, owner.status());
        const proxy = await startBridge(cfg(freePort));
        check("second server on the port -> proxy, mirrors owner health", proxy.mode === "proxy" && /proxying to the MCP server \(pid \d+\)/.test((await proxy.refresh()).note), proxy.status());
        const proxied = await failing(() => proxy.call("getAuth", {}));
        check("proxy call reaches the owner and gets its 'extension not connected' answer", /not connected to the local bridge/.test(proxied || ""), proxied);
        const health = await (await fetch(`http://127.0.0.1:${freePort}/health`)).json();
        check("owner /health reports mode + pid", health.mode === "owner" && health.pid === process.pid, health);
        await owner.close();
        check("after the owner closes, the proxy refresh says so", /stopped answering/.test((await proxy.refresh()).note), proxy.status());
    } catch (e) {
        check("no unexpected exception", false, e.stack || String(e));
    }

    const failed = results.filter(r => !r.pass).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    stub.close();
    // Node/undici can assert on exit while a websocket is mid-close on Windows; give it a tick.
    setTimeout(() => process.exit(failed ? 1 : 0), 100);
});
