/*
 * End-to-end exercise of the imgur tool family against a stub API.
 *
 *   cd server && npm run build && npm run test:imgur
 *
 * Runs the real handlers from build/tools/imgur.js, but points IMGUR_API_BASE at a local stub so
 * nothing touches imgur or burns upload quota, and redirects LOCALAPPDATA to a temp dir so the real
 * keyring / upload ledger / showcase gallery are never read or written. Covers: account vs anonymous
 * auth headers, album find-or-create, content-hash dedup (and its force override), showcase-by-mod
 * uploads with captions carried into bbcodeImages, ledger filtering, and delete-by-link.
 *
 * NOT covered (needs real imgur credentials): the OAuth login round-trip and token refresh.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { randomBytes } = require("crypto");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "imgur-e2e-"));
process.env.LOCALAPPDATA = scratch;

let uploadCount = 0;
const deleted = [];
const authSeen = [];
const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
        const auth = req.headers.authorization || "";
        const send = (code, obj) => {
            res.writeHead(code, { "Content-Type": "application/json", "x-ratelimit-clientremaining": "12400" });
            res.end(JSON.stringify(obj));
        };
        if (req.url === "/3/upload" && req.method === "POST") {
            const p = new URLSearchParams(body);
            if (!p.get("image") || p.get("type") !== "base64") return send(400, { success: false, data: { error: "bad payload" } });
            const decoded = Buffer.from(p.get("image"), "base64");
            uploadCount++;
            authSeen.push(auth);
            const id = "IMG" + uploadCount;
            return send(200, {
                success: true, status: 200,
                data: {
                    id, deletehash: "DEL" + uploadCount, link: `https://i.imgur.com/${id}.png`,
                    width: 800, height: 600, size: decoded.length,
                    _echo: { name: p.get("name"), description: p.get("description"), album: p.get("album"), title: p.get("title"), auth }
                }
            });
        }
        if (req.url === "/3/album" && req.method === "POST") {
            const p = new URLSearchParams(body);
            return send(200, { success: true, data: { id: "ALB1", deletehash: "ALBDEL1", title: p.get("title") } });
        }
        if (req.url === "/3/credits") return send(200, { success: true, data: { ClientRemaining: 12400, UserRemaining: 480, UserReset: 1786000000 } });
        if (req.url.startsWith("/3/image/") && req.method === "DELETE") {
            deleted.push(decodeURIComponent(req.url.split("/").pop()));
            return send(200, { success: true, data: true });
        }
        send(404, { success: false, data: { error: "no stub for " + req.method + " " + req.url } });
    });
});

const results = [];
function check(label, cond, detail) {
    results.push({ label, pass: !!cond, detail });
    console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "  <- " + detail}`);
}

stub.listen(0, "127.0.0.1", async () => {
    process.env.IMGUR_API_BASE = `http://127.0.0.1:${stub.address().port}`;
    const { handleImgurTool } = require(path.resolve(__dirname, "..", "build", "tools", "imgur.js"));
    // Handlers return JSON on success and a plain-text message on failure (house convention).
    const call = async (n, a) => {
        const txt = (await handleImgurTool(n, a)).content[0].text;
        try { return JSON.parse(txt); } catch { return txt; }
    };

    // Seed an "account mode" credential into the scratch keystore.
    const keysDir = path.join(scratch, "RimAgentic");
    fs.mkdirSync(keysDir, { recursive: true });
    fs.writeFileSync(path.join(keysDir, "keys.json"), JSON.stringify({
        imgur: [{
            label: "testacct", active: true, addedAt: new Date().toISOString(),
            value: JSON.stringify({
                clientId: "CLIENTID123", clientSecret: "SECRET", accessToken: "ATOKEN",
                refreshToken: "RTOKEN", expiresAt: new Date(Date.now() + 864e5).toISOString(),
                accountUsername: "archdukejim", accountId: 42
            })
        }]
    }));

    // Two distinct images + one byte-identical duplicate of the first.
    const imgDir = path.join(scratch, "imgs");
    fs.mkdirSync(imgDir, { recursive: true });
    const a = path.join(imgDir, "a.png"), b = path.join(imgDir, "b.png"), aCopy = path.join(imgDir, "a-copy.png");
    const bytesA = randomBytes(2048);
    fs.writeFileSync(a, bytesA); fs.writeFileSync(aCopy, bytesA); fs.writeFileSync(b, randomBytes(4096));

    // 1. status in account mode, live against the stub
    const st = await call("imgur_status", {});
    check("status reports account mode", st.mode === "account" && st.account === "archdukejim", JSON.stringify(st));
    check("status reports live quota", st.live === true && st.quota.userRemaining === 480, JSON.stringify(st.quota));

    // 2. upload two files into a named (auto-created) album
    const up = await call("imgur_upload", { paths: [a, b], album: "RimSynapse Core", title: "T" });
    check("uploaded 2, reused 0", up.uploaded === 2 && up.reused === 0, JSON.stringify(up.results));
    check("album auto-created", up.album && up.album.id === "ALB1" && up.album.created === true, JSON.stringify(up.album));
    check("links returned", up.results.every(r => /^https:\/\/i\.imgur\.com\/IMG\d\.png$/.test(r.link)), JSON.stringify(up.results));
    check("bbcodeImages shape", Array.isArray(up.bbcodeImages) && up.bbcodeImages.length === 2 && up.bbcodeImages[0].url, JSON.stringify(up.bbcodeImages));
    check("account mode sends Bearer token", authSeen.every(h => h === "Bearer ATOKEN"), JSON.stringify(authSeen));
    check("quota surfaced", up.quotaRemaining && up.quotaRemaining.clientRemaining === "12400", JSON.stringify(up.quotaRemaining));

    // 3. dedup: same bytes under a different filename must NOT re-upload
    const before = uploadCount;
    const dup = await call("imgur_upload", { path: aCopy });
    check("content-hash dedup (no new upload)", uploadCount === before && dup.reused === 1 && dup.uploaded === 0, `uploadCount ${before}->${uploadCount} ${JSON.stringify(dup.results)}`);
    check("dedup returns original link", dup.results[0].link === "https://i.imgur.com/IMG1.png", JSON.stringify(dup.results[0]));

    // 3b. force:true overrides dedup
    const forced = await call("imgur_upload", { path: aCopy, force: true });
    check("force:true re-uploads", forced.uploaded === 1 && uploadCount === before + 1, JSON.stringify(forced.results[0]));

    // 4. showcase integration -> captions carried into bbcodeImages
    const showDir = path.join(scratch, "RimAgentic", "showcase");
    fs.mkdirSync(showDir, { recursive: true });
    const s1 = path.join(showDir, "s1.jpg");
    fs.writeFileSync(s1, randomBytes(1024));
    fs.writeFileSync(path.join(showDir, "showcase.json"), JSON.stringify([
        { id: "abc123", caption: "Skylight toggles glass at night", element: "gizmo", mod: "Skylights", path: s1 }
    ]));
    const sc = await call("imgur_upload", { mod: "Skylights" });
    check("showcase upload by mod", sc.uploaded === 1, JSON.stringify(sc.results));
    check("caption carried to bbcodeImages", sc.bbcodeImages[0].caption === "Skylight toggles glass at night", JSON.stringify(sc.bbcodeImages));

    const scMiss = await call("imgur_upload", { mod: "NoSuchMod" });
    check("unknown mod is an error, not a silent no-op", typeof scMiss === "string" || scMiss.error || scMiss.failed !== 0, JSON.stringify(scMiss).slice(0, 120));

    // 5. ledger + filtering
    const led = await call("imgur_list_uploads", {});
    check("ledger records every upload", led.total === 4, `total=${led.total}` /* a+b+forced+showcase; the deduped one correctly adds no row */);
    const byMod = await call("imgur_list_uploads", { mod: "Skylights" });
    check("ledger filters by mod", byMod.count === 1 && byMod.uploads[0].mod === "Skylights", JSON.stringify(byMod.uploads));
    const byAlbum = await call("imgur_list_uploads", { album: "RimSynapse Core" });
    check("ledger filters by album title", byAlbum.count === 2, JSON.stringify(byAlbum.count));

    // 6. delete by link, then by deletehash
    const del = await call("imgur_delete", { ref: "https://i.imgur.com/IMG1.png" });
    check("delete by link resolves deletehash", del.ok && deleted.includes("DEL1"), JSON.stringify({ del, deleted }));
    const after = await call("imgur_list_uploads", {});
    check("delete drops the ledger row", after.total === 3, `total=${after.total}`);
    const delMissing = await call("imgur_delete", { ref: "https://i.imgur.com/NOPE.png" });
    check("delete of unknown link errors cleanly", typeof delMissing === "string" || !delMissing.ok, JSON.stringify(delMissing).slice(0, 140));

    // 7. anonymous mode forces Client-ID auth
    const anon = await call("imgur_upload", { path: b, anonymous: true, force: true });
    check("anonymous mode reported", anon.mode === "anonymous" && anon.account === null, JSON.stringify({ mode: anon.mode, account: anon.account }));
    check("anonymous mode sends Client-ID", authSeen[authSeen.length - 1] === "Client-ID CLIENTID123", authSeen[authSeen.length - 1]);

    stub.close();
    const failed = results.filter(r => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    fs.rmSync(scratch, { recursive: true, force: true });
    process.exit(failed.length ? 1 : 0);
});
