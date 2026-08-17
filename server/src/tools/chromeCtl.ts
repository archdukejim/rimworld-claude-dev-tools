import * as fs from "fs";
import * as path from "path";
import { spawn, execFileSync } from "child_process";
import { Bridge } from "../bridge";

/*
 * Chrome launcher + tab hygiene.
 * ------------------------------
 * The browser-driven tool families (swh_*, imgur_page_*) need a Chrome that is (a) running,
 * (b) has the RimAgentic extension loaded, and (c) is logged into the sites they drive. Until now
 * that was the user's job: open Chrome yourself, keep the extension installed, hope the right tab is
 * focused. This family removes that step.
 *
 * It drives a DEDICATED profile at %LOCALAPPDATA%\RimAgentic\chrome-profile, not the user's normal
 * one. That buys three things worth the one-time cost of signing in there once:
 *   - a stable remote-debugging port (Chrome refuses to add one to an already-running instance, so
 *     sharing the default profile means the launcher can only work when Chrome happens to be closed),
 *   - an extension set we control, so a random other extension can't intercept or break automation,
 *   - a tab list that is entirely ours — which is what makes the aggressive tidying below safe. We
 *     are never closing the user's real browsing.
 *
 * Everything here talks to Chrome over the DevTools HTTP endpoint on 127.0.0.1. Tab *groups* are not
 * a DevTools concept — they only exist in the chrome.tabGroups extension API — so those calls are
 * routed through the loopback bridge to the extension's service worker instead.
 */

const DEFAULT_CDP_PORT = 9222;
const LAUNCH_TIMEOUT_MS = 25_000;

function localAppData(): string {
    return process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local");
}
const profileDir = () => path.join(localAppData(), "RimAgentic", "chrome-profile");

/** The unpacked extension shipped in this repo. __dirname is build/tools/, so up three to the root. */
function extensionDir(): string {
    return path.resolve(__dirname, "..", "..", "..", "extension");
}

const CHROME_CANDIDATES = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(localAppData(), "Google", "Chrome", "Application", "chrome.exe")
];

function findChrome(explicit?: string): string | null {
    const candidates = explicit ? [explicit, ...CHROME_CANDIDATES] : CHROME_CANDIDATES;
    for (const c of candidates) { try { if (fs.statSync(c).isFile()) return c; } catch { /* next */ } }
    return null;
}

// ---------------------------------------------------------------------------- DevTools HTTP

interface Target { id: string; type: string; url: string; title: string; }

async function cdp(port: number, pathname: string, method: "GET" | "PUT" = "GET", timeoutMs = 2500): Promise<any> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { method, signal: ac.signal });
        const txt = await res.text();
        if (!res.ok) throw new Error(`DevTools ${pathname} -> HTTP ${res.status}: ${txt.slice(0, 200)}`);
        try { return JSON.parse(txt); } catch { return txt; }
    } finally { clearTimeout(t); }
}

/** Is a debuggable Chrome answering on this port? */
async function probe(port: number): Promise<{ up: boolean; browser?: string }> {
    try {
        const v = await cdp(port, "/json/version");
        return { up: true, browser: v?.Browser };
    } catch { return { up: false }; }
}

async function targets(port: number): Promise<Target[]> {
    const list = await cdp(port, "/json/list");
    return Array.isArray(list) ? list : [];
}

/**
 * Is OUR extension's service worker among the targets?
 *
 * Match the background script PATH, not just the chrome-extension: scheme — Chrome runs its own
 * component extensions (omnibox, etc.) whose service workers otherwise look identical, and matching
 * loosely reports "loaded" when ours is absent. Note this is a *liveness* check, not an
 * installed check: MV3 service workers spin down when idle, so a false here doesn't mean the
 * extension is missing. loadUnpacked's returned id and the bridge connection are the real signals.
 */
function extensionAlive(ts: Target[]): { alive: boolean; id: string | null } {
    const sw = ts.find(t => /^chrome-extension:\/\/[a-p]{32}\/src\/background\.js$/.test(t.url));
    return { alive: !!sw, id: sw ? (sw.url.match(/^chrome-extension:\/\/([a-p]{32})\//)?.[1] ?? null) : null };
}

/**
 * Install the repo's unpacked extension into the running instance over CDP.
 *
 * Chrome 137+ ignores the --load-extension command-line switch (an anti-malware hardening measure),
 * so the only way to get an unpacked extension in without the user clicking through
 * chrome://extensions is the DevTools Extensions domain, which needs
 * --enable-unsafe-extension-debugging at launch. The path MUST use forward slashes — a Windows
 * backslash path comes back as "File path cannot be resolved".
 */
async function loadUnpacked(port: number, dir: string): Promise<{ ok: boolean; id?: string; error?: string }> {
    let wsUrl: string;
    try { wsUrl = (await cdp(port, "/json/version"))?.webSocketDebuggerUrl; }
    catch (e: any) { return { ok: false, error: `couldn't read the DevTools endpoint: ${e?.message || e}` }; }
    if (!wsUrl) return { ok: false, error: "DevTools reported no browser websocket URL." };

    return await new Promise(resolve => {
        let settled = false;
        const done = (v: { ok: boolean; id?: string; error?: string }) => {
            if (settled) return;
            settled = true;
            try { ws.close(); } catch { /* already closing */ }
            resolve(v);
        };
        const ws = new WebSocket(wsUrl);
        const timer = setTimeout(() => done({ ok: false, error: "timed out talking to the DevTools browser endpoint" }), 10_000);
        ws.addEventListener("open", () => {
            ws.send(JSON.stringify({ id: 1, method: "Extensions.loadUnpacked", params: { path: dir.replace(/\\/g, "/") } }));
        });
        ws.addEventListener("message", (ev: any) => {
            let msg: any;
            try { msg = JSON.parse(String(ev.data)); } catch { return; }
            if (msg.id !== 1) return;
            clearTimeout(timer);
            if (msg.error) done({ ok: false, error: msg.error.message || JSON.stringify(msg.error) });
            else done({ ok: true, id: msg.result?.id });
        });
        ws.addEventListener("error", () => { clearTimeout(timer); done({ ok: false, error: "websocket error talking to DevTools" }); });
    });
}

/** Chrome processes running against OUR profile — never the user's normal windows. */
function ourChromePids(): number[] {
    try {
        // Inside a PowerShell single-quoted string a backslash is literal, so the path goes in RAW —
        // escaping them (as one would for a regex) makes -like never match and silently reports
        // "no Chrome running" while a window is plainly open. Only ' needs doubling.
        const needle = profileDir().replace(/'/g, "''");
        // Anchor on --user-data-dir=<path> ending at a quote/space/end rather than a bare substring:
        // a plain 'contains' also matches sibling profiles like <path>-scratch and would kill them.
        const ps =
            `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ` +
            `Where-Object { $_.CommandLine -match ('--user-data-dir=' + [regex]::Escape('${needle}') + '(\\s|"|$)') } | ` +
            `Select-Object -ExpandProperty ProcessId`;
        const out = execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], { encoding: "utf8", timeout: 15_000 });
        return String(out).split(/\r?\n/).map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n));
    } catch { return []; }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------- tool definitions

export const chromeCtlTools = [
    {
        name: "launch_chrome",
        description:
            "Launch (or reuse) the RimAgentic Chrome instance so browser-driven tools can run without you opening a " +
            "browser first. Uses a DEDICATED profile at %LOCALAPPDATA%\\RimAgentic\\chrome-profile with the repo's " +
            "extension loaded and remote debugging enabled — it never touches your normal Chrome windows or profile. " +
            "Sessions persist in that profile, so you sign into Steam/imgur there ONCE and every later launch is " +
            "already logged in. If it's already running this just reuses it (and opens `url` if given). Returns the " +
            "port, pid, whether the extension registered, and whether the loopback bridge is connected. NOTE: this " +
            "never enters credentials — if a site's session has genuinely expired, sign in yourself in that window once.",
        inputSchema: {
            type: "object",
            properties: {
                url: { type: "string", description: "Optional URL to open once Chrome is up (e.g. https://imgur.com/upload)." },
                port: { type: "number", description: `Remote-debugging port (default ${DEFAULT_CDP_PORT}).` },
                chromePath: { type: "string", description: "Explicit path to chrome.exe if it isn't in a standard install location." },
                headless: { type: "boolean", description: "Run without a visible window. Off by default — sites you must stay signed into behave better with a real window, and you can watch what's happening." },
                restart: { type: "boolean", description: "Kill an existing RimAgentic Chrome and start fresh (use when it's wedged). Default false." }
            }
        }
    },
    {
        name: "chrome_status",
        description:
            "Report the RimAgentic Chrome instance: whether it's running, its debugging port and pids, whether the " +
            "extension's service worker registered, whether the loopback bridge is connected (which is what swh_* " +
            "needs), and the current tab list. Read-only — call this before assuming a browser tool will work.",
        inputSchema: {
            type: "object",
            properties: { port: { type: "number", description: `Remote-debugging port to query (default ${DEFAULT_CDP_PORT}).` } }
        }
    },
    {
        name: "close_chrome",
        description:
            "Close the RimAgentic Chrome instance (only processes running against its dedicated profile — your normal " +
            "Chrome windows are never touched). Use when a run is finished or the instance is wedged.",
        inputSchema: {
            type: "object",
            properties: { port: { type: "number", description: `Remote-debugging port (default ${DEFAULT_CDP_PORT}).` } }
        }
    },
    {
        name: "chrome_tabs",
        description:
            "List the RimAgentic Chrome instance's tabs and tab GROUPS — group title, colour, collapsed state, and " +
            "which tabs belong to each, plus ungrouped tabs and duplicates. Read-only; the inventory to look at " +
            "before chrome_tidy. Tab groups come from the extension (they aren't a DevTools concept), so the extension " +
            "must be loaded and the bridge connected.",
        inputSchema: { type: "object", properties: {} }
    },
    {
        name: "chrome_tidy",
        description:
            "Aggressively clean up the RimAgentic Chrome instance's tabs and groups: close duplicate URLs, close tabs " +
            "idle longer than `maxAgeMinutes`, dissolve empty or stale groups, re-group what's left by site into " +
            "stably-named groups, and collapse everything that isn't active. This is the fix for tab groups going " +
            "stale — run it at the end of any browser task, or any time the window is a mess. Only ever touches the " +
            "dedicated RimAgentic profile, never your normal browsing. Pass dryRun:true to preview the plan first.",
        inputSchema: {
            type: "object",
            properties: {
                maxAgeMinutes: { type: "number", description: "Close tabs not accessed in this many minutes (default 60). 0 disables age-based closing." },
                keep: { type: "array", items: { type: "string" }, description: "URL substrings to protect from closing (e.g. ['imgur.com/upload'])." },
                regroup: { type: "boolean", description: "Re-group surviving tabs by site into named groups (default true)." },
                collapse: { type: "boolean", description: "Collapse every group except the active tab's (default true)." },
                dryRun: { type: "boolean", description: "Report what would happen without changing anything (default false)." }
            }
        }
    }
];

// ---------------------------------------------------------------------------- dispatch

export async function handleChromeCtlTool(name: string, args: any, bridge: Bridge | null) {
    const a = args || {};
    if (name === "launch_chrome") return await launchChrome(a, bridge);
    if (name === "chrome_status") return await chromeStatus(a, bridge);
    if (name === "close_chrome") return await closeChrome(a);
    if (name === "chrome_tabs") return await viaBridge(bridge, "tabsInventory", {});
    if (name === "chrome_tidy") return await viaBridge(bridge, "tabsTidy", {
        maxAgeMinutes: a.maxAgeMinutes === undefined ? 60 : Number(a.maxAgeMinutes),
        keep: Array.isArray(a.keep) ? a.keep.map(String) : [],
        regroup: a.regroup !== false,
        collapse: a.collapse !== false,
        dryRun: !!a.dryRun
    });
    throw new Error(`Unknown chrome tool: ${name}`);
}

/**
 * Open a URL in the RimAgentic Chrome, starting it first if needed — the shared entry point for any
 * family that needs a browser (imgur_login's consent page today). Falls back to the user's default
 * browser rather than failing outright, and always says which route it took.
 */
export async function openUrl(url: string, port = DEFAULT_CDP_PORT): Promise<{ ok: boolean; via: string; error?: string }> {
    try {
        const live = await probe(port);
        if (!live.up) {
            const res = await launchChrome({ port, url }, null);
            const txt = String((res.content[0] as any).text);
            let parsed: any = null;
            try { parsed = JSON.parse(txt); } catch { /* an error string, not a status payload */ }
            if (parsed?.running) return { ok: true, via: "rimagentic-chrome (launched)" };
            return defaultBrowser(url, `launcher said: ${txt.slice(0, 200)}`);
        }
        await cdp(port, `/json/new?${encodeURIComponent(url)}`, "PUT", 8000);
        return { ok: true, via: "rimagentic-chrome (reused)" };
    } catch (e: any) {
        return defaultBrowser(url, e?.message || String(e));
    }
}

function defaultBrowser(url: string, why: string): { ok: boolean; via: string; error?: string } {
    try {
        // `start` treats a bare quoted first arg as a window title, hence the empty "" placeholder.
        spawn("cmd", ["/c", "start", "", url.replace(/&/g, "^&")], { detached: true, stdio: "ignore", windowsHide: true }).unref();
        return { ok: true, via: "default browser", error: why };
    } catch (e: any) {
        return { ok: false, via: "none", error: `${why}; default browser also failed: ${e?.message || e}` };
    }
}

/** Tab-group work lives in the extension; surface a useful error when the bridge isn't up. */
async function viaBridge(bridge: Bridge | null, method: string, args: any) {
    if (!bridge) return errText("The loopback bridge isn't available in this session (port conflict at startup?), so the extension can't be reached. Restart this session's MCP server.");
    const st = await bridge.status();
    if (!st.connected) {
        return errText(
            "The extension isn't connected to the loopback bridge, so tab/group calls can't run.\n" +
            "Run launch_chrome (it reports whether the extension registered), and if it says the extension didn't load, " +
            "follow the load-unpacked steps it prints."
        );
    }
    try { return okText(await bridge.call(method, args)); }
    catch (e: any) { return errText(`Extension call '${method}' failed: ${e?.message || e}`); }
}

// ---------------------------------------------------------------------------- launch_chrome

async function launchChrome(args: any, bridge: Bridge | null) {
    const port = Number(args.port) > 0 ? Math.round(Number(args.port)) : DEFAULT_CDP_PORT;
    const url = args.url ? String(args.url) : null;

    if (args.restart) { await killOurChrome(); await sleep(800); }

    // Already up? Reuse it — relaunching against a live profile just opens a window in the old instance.
    let live = await probe(port);
    if (live.up && !args.restart) {
        if (url) { try { await cdp(port, `/json/new?${encodeURIComponent(url)}`, "PUT", 8000); } catch { /* reported via tabs below */ } }
        return okText(await describe(port, bridge, { reused: true, browser: live.browser, opened: url }));
    }

    const chrome = findChrome(args.chromePath);
    if (!chrome) {
        return errText(
            `Couldn't find chrome.exe. Looked in:\n${CHROME_CANDIDATES.map(c => "  " + c).join("\n")}\n` +
            `Pass chromePath:"C:\\\\path\\\\to\\\\chrome.exe".`
        );
    }

    const profile = profileDir();
    const ext = extensionDir();
    const extExists = fs.existsSync(path.join(ext, "manifest.json"));
    fs.mkdirSync(profile, { recursive: true });

    const flags = [
        `--user-data-dir=${profile}`,
        `--remote-debugging-port=${port}`,
        // Loopback-only debugging; without this Chrome 111+ can reject non-browser DevTools clients.
        "--remote-allow-origins=http://127.0.0.1",
        // Required for the Extensions CDP domain (see loadUnpacked). Scoped to this dedicated
        // automation profile only — it has no effect on the user's normal Chrome.
        "--enable-unsafe-extension-debugging",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-session-crashed-bubble",
        "--restore-last-session=false"
    ];
    if (args.headless) flags.push("--headless=new");
    flags.push(url || "about:blank");

    const child = spawn(chrome, flags, { detached: true, stdio: "ignore", windowsHide: false });
    child.unref();

    // Wait for the DevTools endpoint rather than guessing at a sleep.
    const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
    while (Date.now() < deadline) {
        live = await probe(port);
        if (live.up) break;
        await sleep(400);
    }
    if (!live.up) {
        return errText(
            `Chrome was started but no DevTools endpoint answered on 127.0.0.1:${port} within ${LAUNCH_TIMEOUT_MS / 1000}s.\n` +
            `If a Chrome is already running on this profile it will have ignored the debugging port — pass restart:true.`
        );
    }

    // Install the extension over CDP. An unpacked extension loaded this way lives for the browser
    // session, so this runs on every launch — which also means the running code is always current.
    let installed: { ok: boolean; id?: string; error?: string } =
        { ok: false, error: `no extension at ${ext}` };
    if (extExists) installed = await loadUnpacked(port, ext);

    // Let the service worker spin up and reach the bridge before judging it.
    let info = await describe(port, bridge, { reused: false, browser: live.browser, opened: url });
    for (let i = 0; i < 10 && !(info.extension.alive || info.bridge.connected); i++) {
        await sleep(500);
        info = await describe(port, bridge, { reused: false, browser: live.browser, opened: url });
    }
    info.extension = { ...info.extension, installed: installed.ok, id: installed.id ?? info.extension.id, ...(installed.error ? { installError: installed.error } : {}) };

    if (!installed.ok) {
        info.extensionHelp = extExists
            ? [
                `Couldn't install the extension over CDP (${installed.error}). Load it by hand — the profile is`,
                "persistent, so this is a one-time step:",
                "  1. In the window that just opened, go to chrome://extensions",
                "  2. Turn on 'Developer mode' (top right)",
                `  3. 'Load unpacked' -> ${ext}`,
                "swh_* and the tab-group tools stay unavailable until this succeeds."
            ].join("\n")
            : `No extension found at ${ext} — expected the repo's extension/ folder with a manifest.json.`;
    }
    return okText(info);
}

/** Assemble the status payload shared by launch_chrome and chrome_status. */
async function describe(port: number, bridge: Bridge | null, extra: Record<string, unknown>): Promise<any> {
    let ts: Target[] = [];
    try { ts = await targets(port); } catch { /* endpoint raced; report what we have */ }
    const pages = ts.filter(t => t.type === "page");
    const bs = bridge ? await bridge.status() : null;
    return {
        running: true,
        port,
        profile: profileDir(),
        extensionPath: extensionDir(),
        pids: ourChromePids(),
        extension: extensionAlive(ts) as Record<string, unknown>,
        bridge: bs ? { connected: bs.connected, queued: bs.queued, pending: bs.pending, mode: bs.mode } : { connected: false, note: "bridge not started" },
        tabs: pages.map(p => ({ id: p.id, title: p.title, url: p.url })),
        ...extra
    };
}

async function chromeStatus(args: any, bridge: Bridge | null) {
    const port = Number(args.port) > 0 ? Math.round(Number(args.port)) : DEFAULT_CDP_PORT;
    const live = await probe(port);
    if (!live.up) {
        const stray = ourChromePids();
        return okText({
            running: false, port, profile: profileDir(),
            ...(stray.length ? { note: `Chrome processes exist on this profile (pids ${stray.join(", ")}) but nothing answers on the debugging port — they were started without it. Use launch_chrome { restart: true }.`, pids: stray } : { note: "Not running. Use launch_chrome." })
        });
    }
    return okText(await describe(port, bridge, { browser: live.browser }));
}

async function closeChrome(args: any) {
    const port = Number(args.port) > 0 ? Math.round(Number(args.port)) : DEFAULT_CDP_PORT;
    const before = ourChromePids();
    if (!before.length) return okText({ ok: true, closed: 0, note: "No RimAgentic Chrome processes were running." });
    await killOurChrome();
    await sleep(600);
    const after = ourChromePids();
    return okText({
        ok: after.length === 0, closedPids: before, remaining: after, port,
        note: after.length ? "Some processes survived the close — they may be mid-shutdown." : "Closed. Your normal Chrome windows were not touched."
    });
}

/** Kill only chrome.exe processes whose command line names our profile directory. */
async function killOurChrome(): Promise<void> {
    const pids = ourChromePids();
    if (!pids.length) return;
    try {
        execFileSync("taskkill", ["/F", ...pids.flatMap(p => ["/PID", String(p)])], { stdio: "ignore", timeout: 15_000 });
    } catch { /* already gone, or access denied — reported by the caller's re-check */ }
}

// ---------------------------------------------------------------------------- helpers

function okText(obj: any) { return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] }; }
function errText(msg: string) { return { content: [{ type: "text" as const, text: msg }] }; }
