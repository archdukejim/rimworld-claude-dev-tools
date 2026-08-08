"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.rimworldDevTools = void 0;
exports.workspaceRoot = workspaceRoot;
exports.getModsMap = getModsMap;
exports.classifyLog = classifyLog;
exports.buildStage = buildStage;
exports.runStage = runStage;
exports.runTestCycle = runTestCycle;
exports.handleRimworldDevTool = handleRimworldDevTool;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const config_1 = require("../config");
const testing_1 = require("./testing");
const gameWatchdog_1 = require("../gameWatchdog");
const gameIpc_1 = require("./gameIpc");
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
/** Cheap liveness check for a launched game PID (signal 0 doesn't kill — it just probes). */
function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
/** Is the Steam client running? An isolated launch bypasses Steam (steam_appid.txt), so SteamAPI.Init
 *  fails and RimWorld enumerates only Data/ and local Mods/ — every Workshop-only mod is silently
 *  dropped. Workshop mods therefore load into an isolated launch ONLY when Steam is signed in. */
function isSteamRunning() {
    try {
        const out = (0, child_process_1.execSync)("powershell -NoProfile -Command \"(Get-Process -Name steam -ErrorAction SilentlyContinue | Measure-Object).Count\"", { encoding: "utf8" });
        return (parseInt(String(out).trim(), 10) || 0) > 0;
    }
    catch {
        return false;
    }
}
// Junctions this tool mirrors into the local Mods folder are named with this prefix and recorded in
// the manifest below, so they can be told apart from real mods and cleaned up. The trailing name is
// the sanitized packageId (identity comes from the target's About.xml, so the folder name is cosmetic).
const MANAGED_LINK_PREFIX = "_RimAgentic_ws_";
const MANAGED_LINK_MANIFEST = ".rimagentic-managed-links.json";
/** True only when p exists AND resolves to a different real path — i.e. it is a junction/symlink, never
 *  a real directory. Removal is gated on this so a real mod folder can never be deleted by mistake. */
function isReparsePoint(p) {
    try {
        const real = fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p);
        return path.resolve(real) !== path.resolve(p);
    }
    catch {
        return false;
    }
}
/** Remove a managed junction (link only, never its target), but only if it really is a reparse point. */
function removeManagedLink(modsDir, name) {
    const p = path.join(modsDir, name);
    if (!fs.existsSync(p) || !isReparsePoint(p))
        return false;
    try {
        (0, child_process_1.execSync)(`cmd /c rmdir "${p}"`, { stdio: "ignore" });
        return true;
    }
    catch {
        return false;
    }
}
/** Create a directory junction (no admin needed) at linkPath -> target; verify the mod is visible. */
function makeJunction(linkPath, target) {
    try {
        if (fs.existsSync(linkPath))
            removeManagedLink(path.dirname(linkPath), path.basename(linkPath));
        (0, child_process_1.execSync)(`cmd /c mklink /J "${linkPath}" "${target}"`, { stdio: "ignore" });
        return fs.existsSync(path.join(linkPath, "About", "About.xml"));
    }
    catch {
        return false;
    }
}
/**
 * Make every active Workshop mod loadable by an isolated (Steam-bypassed) launch, and clean up after
 * itself.
 *
 * An isolated launch fails SteamAPI.Init, so RimWorld enumerates only Data/ and local Mods/ — every
 * Workshop-only mod is silently dropped, and anything depending on it (Harmony above all) then dies
 * with a cryptic "Could not resolve type 'HarmonyLib.Harmony'". Using the corrected resolver:
 *   - Steam signed in  -> Workshop loads natively; tear down any junctions we previously created so no
 *                         duplicate packageId is ever presented to RimWorld.
 *   - Steam signed out -> mirror each active Workshop mod into local Mods/ as a junction so the local
 *                         scan finds it, and drop managed junctions that are no longer needed.
 * Every junction we create is tracked in a manifest and reconciled on the next launch, so the Mods
 * folder never accumulates stale links.
 */
function ensureActiveWorkshopModsLoadable(modsDir, savedata) {
    if (!modsDir || !fs.existsSync(modsDir))
        return "";
    const manifestPath = path.join(modsDir, MANAGED_LINK_MANIFEST);
    const readManifest = () => {
        try {
            return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        }
        catch {
            return {};
        }
    };
    const writeManifest = (m) => {
        try {
            if (Object.keys(m).length)
                fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));
            else if (fs.existsSync(manifestPath))
                fs.unlinkSync(manifestPath);
        }
        catch { /* manifest is a convenience, not correctness-critical */ }
    };
    const manifest = readManifest();
    // Which active mods live only in the Workshop?
    let active = [];
    try {
        const xml = fs.readFileSync(path.join(savedata, "Config", "ModsConfig.xml"), "utf8");
        const block = /<activeMods>([\s\S]*?)<\/activeMods>/i.exec(xml)?.[1] ?? "";
        active = Array.from(block.matchAll(/<li>([^<]+)<\/li>/gi)).map(m => m[1].trim().toLowerCase());
    }
    catch {
        return "";
    }
    let byId = new Map();
    try {
        byId = new Map((0, testing_1.resolveInstalledMods)({ rimworldModsDir: modsDir }).map(m => [m.packageId, m]));
    }
    catch {
        return "";
    }
    const workshopActive = active
        .map(id => ({ id, m: byId.get(id) }))
        .filter((x) => !!x.m && x.m.source === "workshop");
    // Steam signed in: native Workshop load — remove any managed junctions we made and we're done.
    if (isSteamRunning()) {
        let removed = 0;
        for (const name of Object.keys(manifest))
            if (removeManagedLink(modsDir, name))
                removed++;
        writeManifest({});
        let log = "";
        if (removed)
            log += `Steam is running — removed ${removed} managed Workshop junction(s); those mods load natively now.\n`;
        if (workshopActive.length)
            log += `Steam signed in: ${workshopActive.length} active Workshop mod(s) will load natively.\n`;
        return log;
    }
    // Steam signed out: mirror each active Workshop mod into local Mods/ so the isolated launch sees it.
    const needed = {};
    const mirrored = [];
    for (const { id, m } of workshopActive) {
        const name = MANAGED_LINK_PREFIX + id.replace(/[^a-z0-9._-]/gi, "_");
        needed[name] = m.folder;
        const linkPath = path.join(modsDir, name);
        if (fs.existsSync(path.join(linkPath, "About", "About.xml")) || makeJunction(linkPath, m.folder)) {
            mirrored.push(id);
        }
    }
    // Drop managed junctions that are no longer for an active Workshop mod.
    let removed = 0;
    for (const name of Object.keys(manifest))
        if (!needed[name] && removeManagedLink(modsDir, name))
            removed++;
    writeManifest(needed);
    let log = "";
    if (workshopActive.length) {
        log += `WARNING: Steam is not running/signed in — ${workshopActive.length} active mod(s) live only in the Steam Workshop `;
        log += `(${workshopActive.map(x => x.id).join(", ")}). Mirrored ${mirrored.length} into local Mods as junctions so they load; `;
        log += `sign into Steam to load the Workshop natively instead.\n`;
    }
    if (removed)
        log += `Cleaned up ${removed} stale managed Workshop junction(s).\n`;
    return log;
}
/** Enumerate the .rws saves under a savedatafolder's Saves/ dir, newest first. */
function listSaves(savedata) {
    const savesDir = path.join(savedata, "Saves");
    let entries = [];
    try {
        entries = fs.readdirSync(savesDir);
    }
    catch {
        return [];
    }
    return entries
        .filter(f => f.toLowerCase().endsWith(".rws"))
        .map(f => {
        const st = fs.statSync(path.join(savesDir, f));
        return {
            name: path.basename(f, path.extname(f)),
            sizeBytes: st.size,
            modified: st.mtime.toISOString(),
            modifiedMs: st.mtimeMs
        };
    })
        .sort((a, b) => b.modifiedMs - a.modifiedMs);
}
exports.rimworldDevTools = [
    {
        name: "deploy_rimworld_mods",
        description: "Compiles C# assemblies and packages clean mod files into the target RimWorld Mods directory.",
        inputSchema: {
            type: "object",
            properties: {
                mods: {
                    type: "array",
                    items: { type: "string" },
                    description: "List of mod directory names to build and deploy (e.g. ['Core', 'Psychology']). If omitted, all 9 mods are built and deployed."
                },
                buildType: {
                    type: "string",
                    enum: ["Release", "Debug"],
                    description: "The build configuration to use (default: Release)."
                },
                targetModsDir: {
                    type: "string",
                    description: "Optional custom path to the RimWorld Mods folder. Overrides the configured path."
                }
            }
        }
    },
    {
        name: "launch_rimworld",
        description: "Closes existing RimWorld instances and launches a new one with developer, quicktest, or custom save data folder parameters. When launching into a map (quicktest or loadSave) it blocks until the map is live before returning, so a following bridge tool call won't race the load.",
        inputSchema: {
            type: "object",
            properties: {
                savedatafolder: {
                    type: "string",
                    description: "Optional custom path for -savedatafolder. Overrides the configured path."
                },
                quicktest: {
                    type: "boolean",
                    description: "Whether to launch with -quicktest to jump straight into a generated map (default: false)."
                },
                developer: {
                    type: "boolean",
                    description: "Whether to force developer mode enabled (default: true)."
                },
                killExisting: {
                    type: "boolean",
                    description: "Whether to close currently running RimWorld processes (default: true)."
                },
                verbose: {
                    type: "boolean",
                    description: "Whether to output verbose log files (default: false)."
                },
                nosound: {
                    type: "boolean",
                    description: "Whether to mute the game audio by launching with -nosound (default: true)."
                },
                idleTimeoutMin: {
                    type: "number",
                    description: "Minutes with no MCP tool call before the idle watchdog closes the game, so it never runs unattended overnight. 0 disables it. Default: RIMAGENTIC_GAME_IDLE_TIMEOUT_MIN (30)."
                },
                loadSave: {
                    description: "Resume a save straight from launch (the automated 'Continue' button) instead of the menu/quicktest. Pass a save slot name, or true to load the most recent save in the save folder. Needs the RimAgentic mod active. Omit for a normal launch.",
                    oneOf: [{ type: "string" }, { type: "boolean" }]
                },
                waitForReady: {
                    type: "boolean",
                    description: "When launching into a live map (quicktest or loadSave), block until the map is actually live (the bridge is polling and Find.CurrentMap exists) before returning, so the next bridge tool call won't race the load. Default true. Ignored for a plain menu launch (no map is expected)."
                },
                readyTimeoutSec: {
                    type: "number",
                    description: "Max seconds to wait for the map to become live when waitForReady is on (default 120)."
                }
            }
        }
    },
    {
        name: "list_rimworld_saves",
        description: "Lists the saved games (.rws) in the dev save folder, newest first, with size and last-modified time. Use it to pick a slot for launch_rimworld's loadSave.",
        inputSchema: {
            type: "object",
            properties: {
                savedatafolder: {
                    type: "string",
                    description: "Optional custom savedatafolder to read Saves/ from. Defaults to the configured dev save folder."
                }
            }
        }
    },
    {
        name: "run_rimworld_tests",
        description: "Full automated test cycle: build the mods in dependency order, launch RimWorld with the in-game " +
            "TestRunner (-synapse-test), then classify the log. Stops early if the build fails. Returns the build " +
            "summary plus [SYNAPSE-TEST] PASS/FAIL results and any errors. Requires the RimSynapse.TestRunner mod " +
            "to be active and loaded last.",
        inputSchema: {
            type: "object",
            properties: {
                repo: {
                    type: "string",
                    description: "Build only this repo and its dependencies (e.g. 'Factions'). Omit to build everything."
                },
                timeoutSec: {
                    type: "number",
                    description: "Max seconds to wait for the TestRunner to report results (default: 420)."
                },
                savedatafolder: {
                    type: "string",
                    description: "Which RimWorld config the run reads, and therefore which modlist it tests. " +
                        "Defaults to the same folder configure_active_mods writes, so configuring a " +
                        "modlist and then running the tests validates that modlist."
                }
            }
        }
    },
    {
        name: "read_rimworld_log",
        description: "Reads and triages RimWorld's Player.log. By default returns a classified summary — exceptions, " +
            "Harmony patch failures, XML/def errors, missing dependencies, version and metadata warnings, plus any " +
            "[SYNAPSE-TEST] PASS/FAIL results from the TestRunner mod. Pass raw:true for an unfiltered tail instead.",
        inputSchema: {
            type: "object",
            properties: {
                savedatafolder: {
                    type: "string",
                    description: "Optional path to the custom savedatafolder if checking a dev instance."
                },
                raw: {
                    type: "boolean",
                    description: "Return the unfiltered tail of the log instead of the classified summary (default: false)."
                },
                lines: {
                    type: "number",
                    description: "With raw:true, number of lines from the end of the log to return (default: 100)."
                },
                maxPerCategory: {
                    type: "number",
                    description: "Max lines returned per classified category (default: 25)."
                }
            }
        }
    }
];
/**
 * Root of the RimSynapse mod workspace — the folder holding Core/, Factions/ and friends.
 * Resolved from RIMSYNAPSE_ROOT so the tools follow the checkout; these paths used to be
 * hardcoded to a d:\ drive, which silently broke every mod operation elsewhere.
 */
function workspaceRoot() {
    const fromEnv = process.env.RIMAGENTIC_ROOT || process.env.RIMSYNAPSE_ROOT;
    if (fromEnv && fs.existsSync(path.join(fromEnv, "Core", "About", "About.xml")))
        return fromEnv;
    // Fall back to walking up from this file: <root>/Repo-MCP/server/build/tools -> <root>
    let dir = __dirname;
    for (let i = 0; i < 5; i++) {
        if (fs.existsSync(path.join(dir, "Core", "About", "About.xml")))
            return dir;
        dir = path.dirname(dir);
    }
    return "C:\\github\\rimsynapse";
}
function hasCsharpProject(modDir) {
    const sourceDir = path.join(modDir, "Source");
    if (!fs.existsSync(sourceDir))
        return false;
    try {
        return fs.readdirSync(sourceDir).some(f => f.toLowerCase().endsWith(".csproj"));
    }
    catch {
        return false;
    }
}
function isModFolder(dir) {
    return fs.existsSync(path.join(dir, "About", "About.xml"));
}
function discoverMods(root) {
    const asMod = (dir) => {
        const dirName = path.basename(dir);
        return { name: dirName, dirName, hasCsharp: hasCsharpProject(dir), src: dir };
    };
    // Single-repo layout: the root itself is a mod (what CI for one repo gets).
    if (isModFolder(root))
        return [asMod(root)];
    // Workspace layout: each immediate child folder with About/About.xml is a mod.
    let entries = [];
    try {
        entries = fs.readdirSync(root);
    }
    catch {
        return [];
    }
    return entries
        .map(e => path.join(root, e))
        .filter(p => { try {
        return fs.statSync(p).isDirectory() && isModFolder(p);
    }
    catch {
        return false;
    } })
        .map(asMod)
        .sort((a, b) => a.dirName.localeCompare(b.dirName));
}
// Kept as a getter so the workspace root is honoured at call time rather than import time.
// Exported so the agent/broker can enumerate the developer's mods without hardcoding them.
function getModsMap() {
    return discoverMods(workspaceRoot());
}
const foldersWhitelist = [
    "About",
    "Assemblies",
    "Defs",
    "Textures",
    "Patches",
    "Languages",
    "Sounds",
    "Strings",
    // Learning/ is RimSynapse's own convention, not a RimWorld one: Core reads Learning/*.md
    // at startup and injects them into the in-game Learning Helper, and sync-wiki.ps1 publishes
    // the same folder to each repo's GitHub wiki. It was missing from this list, so every
    // deployed and published copy shipped without its in-game wiki — 27 concepts against the
    // repo's 30. Every mod description advertises "Official Wiki and Documentation".
    "Learning",
    "Common",
    "1.0",
    "1.1",
    "1.2",
    "1.3",
    "1.4",
    "1.5",
    "1.6"
];
/**
 * Top-level entries that are deliberately not shipped, so they can be reported as skipped
 * rather than counted as omissions worth looking at.
 *
 * The whitelist stays a whitelist rather than becoming a blocklist: these repo roots carry
 * _to_delete, game_state.json, dev logs, Design/, docs/ and CLAUDE.md, and defaulting to
 * "ship everything not named" would push all of it to the Workshop. What was actually wrong
 * was that omissions were silent — so the deploy now names anything it passed over that is
 * not on this list.
 */
const knownNotShipped = new Set([
    "Source", "Tests", "obj", "bin", ".git", ".github", ".vs", ".agents",
    "node_modules", "Design", "Development", "docs", "_to_delete",
    "CLAUDE.md", "CHANGELOG.md", "FutureFeatures.md", ".gitignore", ".gitattributes"
]);
const filesWhitelist = [
    "LICENSE",
    "README.md",
    "LoadFolders.xml",
    "steam_description.txt"
];
/**
 * Triage Player.log into the categories that matter when checking whether a run was healthy,
 * plus any [SYNAPSE-TEST] results emitted by the TestRunner mod.
 *
 * A bare "at Foo.Bar ()" line is only evidence of a problem when it belongs to a real
 * exception. Mods also log System.Diagnostics.StackTrace deliberately for tracing, which
 * produces identical-looking frames, so frames are only attributed while an exception
 * headline is still open. Without that, deliberate tracing reads as a crash.
 */
function classifyLog(lines, maxPerCategory) {
    const patterns = [
        ["synapseTest", /\[SYNAPSE-TEST\]/],
        ["metadataWarning", /needs to have <downloadUrl>/i],
        ["harmonyPatchFailure", /(harmony[^\n]*(exception|fail|error|conflict))|(failed to (apply )?patch)|(patch[^\n]*(threw|failed))/i],
        ["missingDependency", /requires the mod|which is not loaded|you are missing|is not loaded/i],
        ["versionWarning", /made for a different version|different version of RimWorld|not compatible with the current/i],
        ["xmlError", /XML error|Could not (load|find|resolve)[^\n]*(Def|type)|Def named .* not found|Config error/i],
        ["exception", /exception|stacktrace/i],
        ["error", /^\s*(\[[^\]]*\])?\s*error\b|^Verse\.Log/i]
    ];
    const categories = {};
    for (const [key] of patterns)
        categories[key] = [];
    const frameRegex = /^\s+at\s+\S+/;
    let inException = false;
    for (const line of lines) {
        if (!line || !line.trim()) {
            inException = false;
            continue;
        }
        if (frameRegex.test(line)) {
            if (inException)
                categories.exception.push(line.trim());
            continue; // orphan frame => deliberate trace logging, not an error
        }
        let matched = false;
        for (const [key, re] of patterns) {
            if (re.test(line)) {
                categories[key].push(line.trim());
                inException = key === "exception";
                matched = true;
                break;
            }
        }
        if (!matched)
            inException = false;
    }
    // [SYNAPSE-TEST] PASS|FAIL <case> | <detail>
    const cases = [];
    let passed = 0, failed = 0;
    for (const line of categories.synapseTest) {
        const m = line.match(/\[SYNAPSE-TEST\]\s+(PASS|FAIL)\s+(\S+)\s*(?:\|\s*(.*))?/);
        if (!m)
            continue;
        cases.push({ result: m[1], name: m[2], detail: m[3] });
        if (m[1] === "PASS")
            passed++;
        else
            failed++;
    }
    const counts = {};
    const trimmed = {};
    for (const [key] of patterns) {
        counts[key] = categories[key].length;
        trimmed[key] = categories[key].slice(0, maxPerCategory);
    }
    // Warnings (metadata/version/missing dependency) are surfaced but not treated as blocking.
    const blocking = counts.harmonyPatchFailure + counts.xmlError + counts.exception + counts.error + failed;
    return {
        ok: blocking === 0,
        blockingCount: blocking,
        counts,
        categories: trimmed,
        tests: { passed, failed, cases }
    };
}
/**
 * Locate a harness script. This module compiles to <server>/build/tools in the repo and
 * <server>/tools in a packaged bundle, so walk up to whichever root holds harness/.
 */
function harnessScript(scriptName) {
    const candidates = [
        process.env.RIMAGENTIC_HARNESS,
        process.env.RIMSYNAPSE_HARNESS,
        path.join(__dirname, "..", "..", "..", "harness"),
        path.join(__dirname, "..", "..", "harness"),
        path.join(__dirname, "..", "harness")
    ].filter(Boolean);
    for (const dir of candidates) {
        const p = path.join(dir, scriptName);
        if (fs.existsSync(p))
            return p;
    }
    throw new Error(`Harness script "${scriptName}" not found. Looked in: ${candidates.join(", ")}. ` +
        `Set RIMSYNAPSE_HARNESS to the folder containing the harness .ps1 scripts.`);
}
/** Run a harness script and parse the single JSON object it prints. Never rejects. */
function runHarness(scriptName, scriptArgs, timeoutMs) {
    return new Promise((resolve) => {
        let script;
        try {
            script = harnessScript(scriptName);
        }
        catch (err) {
            resolve({ ok: false, error: String(err.message) });
            return;
        }
        const child = (0, child_process_1.spawn)("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...scriptArgs], { windowsHide: true });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => child.kill(), timeoutMs);
        child.stdout.on("data", d => (stdout += d.toString()));
        child.stderr.on("data", d => (stderr += d.toString()));
        child.on("close", () => {
            clearTimeout(timer);
            // Scripts emit "[harness] ..." progress lines before the JSON payload.
            const start = stdout.indexOf("{");
            if (start === -1) {
                resolve({ ok: false, error: "no JSON in harness output", stdout: stdout.slice(-2000), stderr: stderr.slice(-1000) });
                return;
            }
            const candidate = stdout.slice(start);
            try {
                resolve(JSON.parse(candidate));
            }
            catch {
                const lastClose = candidate.lastIndexOf("}");
                try {
                    resolve(JSON.parse(candidate.slice(0, lastClose + 1)));
                }
                catch {
                    resolve({ ok: false, error: "could not parse harness output", stdout: stdout.slice(-2000) });
                }
            }
        });
        child.on("error", err => {
            clearTimeout(timer);
            resolve({ ok: false, error: String(err) });
        });
    });
}
/**
 * The build half of the cycle. Split out so the job broker can run builds concurrently
 * (they're independent) while keeping the game-run half serial. Returns the harness build
 * result ({ ok, built, failed, warnings }).
 */
async function buildStage(repo) {
    const buildArgs = ["-Repo", repo].filter(Boolean);
    return runHarness("build.ps1", repo ? buildArgs : [], 10 * 60 * 1000);
}
/**
 * The game-run half: launch RimWorld against a caller-pinned savedatafolder and classify the
 * log. MUST be serialized across jobs (one RimWorld at a time). Previously launch.ps1 was
 * called with no savedatafolder, so the game read the default config while the modlist lived
 * in the dev folder — configuring a modlist had no effect on the run.
 * NOTE (Phase 2): readlog.ps1 still reads the default log location; for full per-job isolation
 * it must accept -SaveDataFolder and read the job's own Player.log.
 */
async function runStage(savedatafolder, timeoutSec = 420) {
    const launch = await runHarness("launch.ps1", ["-Test", "-TimeoutSec", String(timeoutSec), "-SaveDataFolder", savedatafolder], (timeoutSec + 180) * 1000);
    // Read the log regardless of how the launch ended — a crash still leaves evidence.
    const log = await runHarness("readlog.ps1", [], 60 * 1000);
    return { launch, log };
}
async function runTestCycle(opts) {
    const build = await buildStage(opts.repo);
    if (!build || build.ok !== true) {
        return { ok: false, stage: "build", build };
    }
    const { launch, log } = await runStage(opts.savedatafolder, opts.timeoutSec || 420);
    // All three stages have to agree: the build produced binaries, the game got far enough to
    // finish the suite, and the log carries no blocking entries and no shortfall in case count.
    const ok = build?.ok === true && launch?.ok === true && log?.ok === true;
    return { ok, stage: "complete", build, launch, log };
}
function copyFolderRecursiveSync(source, target) {
    if (!fs.existsSync(target)) {
        fs.mkdirSync(target, { recursive: true });
    }
    const files = fs.readdirSync(source);
    for (const file of files) {
        const curSource = path.join(source, file);
        const curTarget = path.join(target, file);
        if (fs.lstatSync(curSource).isDirectory()) {
            copyFolderRecursiveSync(curSource, curTarget);
        }
        else {
            fs.copyFileSync(curSource, curTarget);
        }
    }
}
async function handleRimworldDevTool(name, args) {
    const config = (0, config_1.loadConfig)();
    if (name === "deploy_rimworld_mods") {
        const selectedMods = args.mods;
        const buildType = args.buildType || "Release";
        const targetModsDir = args.targetModsDir || config.rimworldModsDir || "C:\\Program Files (x86)\\Steam\\steamapps\\common\\RimWorld\\Mods";
        let logs = `Deploying mods to: ${targetModsDir}\nBuild configuration: ${buildType}\n`;
        const targetMods = selectedMods
            ? getModsMap().filter(m => selectedMods.includes(m.dirName))
            : getModsMap();
        for (const mod of targetMods) {
            logs += `\nProcessing ${mod.dirName}...\n`;
            // 1. Compile C# project if applicable
            if (mod.hasCsharp) {
                const sourceDir = path.join(mod.src, "Source");
                if (fs.existsSync(sourceDir)) {
                    logs += `  Compiling C# assembly...\n`;
                    try {
                        (0, child_process_1.execSync)(`dotnet build -c ${buildType}`, { cwd: sourceDir, stdio: "pipe" });
                        logs += `  Compilation successful.\n`;
                    }
                    catch (err) {
                        logs += `  Compilation FAILED: ${err.message}\n${err.stderr?.toString() || ""}\n`;
                        continue;
                    }
                }
            }
            // 2. Package mod files
            const destPath = path.join(targetModsDir, mod.name);
            logs += `  Packaging release files to ${destPath}...\n`;
            try {
                if (fs.existsSync(destPath)) {
                    const stats = fs.lstatSync(destPath);
                    if (stats.isSymbolicLink()) {
                        (0, child_process_1.execSync)(`cmd.exe /c rmdir "${destPath}"`, { stdio: "ignore" });
                    }
                    else {
                        fs.rmSync(destPath, { recursive: true, force: true });
                    }
                }
                fs.mkdirSync(destPath, { recursive: true });
                // Copy whitelist folders
                for (const folder of foldersWhitelist) {
                    const srcFolder = path.join(mod.src, folder);
                    const destFolder = path.join(destPath, folder);
                    if (fs.existsSync(srcFolder) && fs.lstatSync(srcFolder).isDirectory()) {
                        copyFolderRecursiveSync(srcFolder, destFolder);
                    }
                }
                // Copy whitelist files
                for (const file of filesWhitelist) {
                    const srcFile = path.join(mod.src, file);
                    const destFile = path.join(destPath, file);
                    if (fs.existsSync(srcFile) && fs.lstatSync(srcFile).isFile()) {
                        fs.copyFileSync(srcFile, destFile);
                    }
                }
                // Say what shipped, and name anything passed over that is not deliberately
                // excluded. A whitelist that silently drops a folder is how Learning/ went
                // unpublished for months while the mod descriptions advertised an in-game wiki;
                // the omission was only visible as a concept count three layers away.
                const shipped = [];
                const unexpected = [];
                for (const entry of fs.readdirSync(mod.src)) {
                    const isDir = fs.lstatSync(path.join(mod.src, entry)).isDirectory();
                    const listed = isDir ? foldersWhitelist.includes(entry) : filesWhitelist.includes(entry);
                    if (listed) {
                        if (fs.existsSync(path.join(destPath, entry)))
                            shipped.push(entry);
                    }
                    else if (!knownNotShipped.has(entry)) {
                        unexpected.push(entry);
                    }
                }
                const learningDir = path.join(destPath, "Learning");
                const learningCount = fs.existsSync(learningDir)
                    ? fs.readdirSync(learningDir).filter(f => f.toLowerCase().endsWith(".md")).length
                    : 0;
                logs += `  Packaged: ${shipped.join(", ") || "(nothing)"}\n`;
                if (learningCount > 0)
                    logs += `  Learning docs: ${learningCount}\n`;
                if (unexpected.length > 0) {
                    logs += `  NOT PACKAGED (not on the whitelist — intended?): ${unexpected.join(", ")}\n`;
                }
                logs += `  Deployment successful.\n`;
            }
            catch (err) {
                logs += `  Deployment FAILED: ${err.message}\n`;
            }
        }
        return { content: [{ type: "text", text: logs }] };
    }
    if (name === "launch_rimworld") {
        const savedata = args.savedatafolder || config.savedatafolder || (0, config_1.getSaveDataFolder)();
        let quicktest = args.quicktest === true;
        const developer = args.developer !== false;
        const killExisting = args.killExisting !== false;
        const verbose = args.verbose === true;
        const nosound = args.nosound !== false;
        const pidFilePath = path.join(__dirname, "..", "..", "dev_instance_pid.txt");
        let logs = `Launching RimWorld directly...\n`;
        // Resolve loadSave (string slot | true = newest save) into a concrete save name to autoload.
        // The game side reads RIMAGENTIC_AUTOLOAD_SAVE at the main menu and loads it. Resuming a save
        // and generating a quicktest map are mutually exclusive, so loadSave wins and disables quicktest.
        let autoloadSave = null;
        if (args.loadSave !== undefined && args.loadSave !== false && args.loadSave !== null) {
            const saves = listSaves(savedata);
            if (args.loadSave === true) {
                if (saves.length === 0) {
                    logs += `WARNING: loadSave=true but no saves exist in ${path.join(savedata, "Saves")} — launching without resume.\n`;
                }
                else {
                    autoloadSave = saves[0].name;
                    logs += `loadSave: resuming most recent save '${autoloadSave}' (${saves[0].modified}).\n`;
                }
            }
            else {
                const requested = String(args.loadSave).trim();
                if (saves.some(s => s.name.toLowerCase() === requested.toLowerCase())) {
                    autoloadSave = saves.find(s => s.name.toLowerCase() === requested.toLowerCase()).name;
                    logs += `loadSave: resuming save '${autoloadSave}'.\n`;
                }
                else {
                    logs += `WARNING: loadSave requested '${requested}' but no such save in ${path.join(savedata, "Saves")} `;
                    logs += `(available: ${saves.map(s => s.name).join(", ") || "none"}) — launching without resume.\n`;
                }
            }
            if (autoloadSave && quicktest) {
                quicktest = false;
                logs += "Ignoring quicktest because loadSave was given (can't do both).\n";
            }
        }
        // How many RimWorld instances are up right now — used to warn/clean up and avoid resource pileup.
        const countRimWorld = () => {
            try {
                const out = (0, child_process_1.execSync)("powershell -NoProfile -Command \"(Get-CimInstance Win32_Process -Filter \\\"Name='RimWorldWin64.exe'\\\" | Measure-Object).Count\"", { encoding: "utf8" });
                return parseInt(String(out).trim(), 10) || 0;
            }
            catch {
                return 0;
            }
        };
        if (killExisting) {
            // A dev laptop can't afford two RimWorld sessions at once, and mixing launch tools used to
            // leave orphans (this tool only closed -savedatafolder instances, so a plain quicktest one
            // survived). Guarantee a single instance: close the tracked PID, then EVERY RimWorld process.
            const before = countRimWorld();
            logs += `Ensuring no other RimWorld session is running (found ${before})...\n`;
            if (fs.existsSync(pidFilePath)) {
                try {
                    const oldPid = fs.readFileSync(pidFilePath, "utf8").trim();
                    (0, child_process_1.execSync)(`taskkill /f /pid ${oldPid}`, { stdio: "ignore" });
                }
                catch (e) { /* already dead */ }
                try {
                    fs.unlinkSync(pidFilePath);
                }
                catch (e) { /* ignore */ }
            }
            try {
                (0, child_process_1.execSync)("taskkill /f /im RimWorldWin64.exe", { stdio: "ignore" }); // kills ALL instances
            }
            catch (e) { /* taskkill exits non-zero when none are running */ }
            const after = countRimWorld();
            logs += after === 0
                ? (before > 0 ? `Closed ${before} instance(s); none remain.\n` : "No RimWorld instance was running.\n")
                : `WARNING: ${after} RimWorld instance(s) still running after cleanup — check manually.\n`;
        }
        else {
            const running = countRimWorld();
            if (running > 0)
                logs += `WARNING: ${running} RimWorld instance(s) already running and killExisting is false — launching another will strain resources.\n`;
        }
        // 1. Write the Prefs.xml file to mute audio and enable devMode under the custom savedatafolder
        const configDir = path.join(savedata, "Config");
        try {
            fs.mkdirSync(configDir, { recursive: true });
            const prefsPath = path.join(configDir, "Prefs.xml");
            const volumeVal = nosound ? "0" : "1";
            const devModeVal = developer ? "True" : "False";
            const prefsXml = `<?xml version="1.0" encoding="utf-8"?>
<PrefsData>
  <volumeMaster>${volumeVal}</volumeMaster>
  <volumeGame>${volumeVal}</volumeGame>
  <volumeMusic>0</volumeMusic>
  <volumeAmbient>${volumeVal}</volumeAmbient>
  <volumeUI>${volumeVal}</volumeUI>
  <devMode>${devModeVal}</devMode>
  <runInBackground>True</runInBackground>
</PrefsData>`;
            fs.writeFileSync(prefsPath, prefsXml, "utf8");
            logs += `Pre-configured Prefs.xml in ${configDir} (Muted: ${nosound})\n`;
        }
        catch (prefsErr) {
            logs += `Warning: Failed to pre-configure Prefs.xml: ${prefsErr.message}\n`;
        }
        // 2. Resolve RimWorld executable path
        let rimworldExe = config.rimworldPath;
        if (!rimworldExe) {
            rimworldExe = "C:\\Program Files (x86)\\Steam\\steamapps\\common\\RimWorld\\RimWorldWin64.exe";
        }
        if (!fs.existsSync(rimworldExe)) {
            throw new Error(`RimWorld executable not found at: ${rimworldExe}`);
        }
        // 3. Prevent Steam Relaunch (Write steam_appid.txt in game directory if missing)
        const gameDir = path.dirname(rimworldExe);
        const appidPath = path.join(gameDir, "steam_appid.txt");
        if (!fs.existsSync(appidPath)) {
            try {
                fs.writeFileSync(appidPath, "294100", "utf8");
                logs += `Created steam_appid.txt bypass config.\n`;
            }
            catch (e) { }
        }
        // Bug guard + fallback: when Steam is signed out, an isolated launch can't enumerate the Workshop,
        // so mirror each active Workshop mod (Harmony above all) into local Mods as a junction; when Steam
        // is signed in, tear those junctions back down. Self-cleaning via a tracked manifest.
        logs += ensureActiveWorkshopModsLoadable(config.rimworldModsDir, savedata);
        const params = [
            `-savedatafolder=${savedata}`,
            "-developer"
        ];
        if (quicktest) {
            params.push("-quicktest");
            logs += "Quicktest mode enabled.\n";
        }
        if (verbose) {
            params.push("-verbose");
            logs += "Verbose logging enabled.\n";
        }
        if (nosound) {
            params.push("-nosound");
            logs += "Sound disabled (nosound flag active).\n";
        }
        try {
            logs += `Spawning isolated game process: ${rimworldExe}\n`;
            const launchEnv = {
                ...process.env,
                SteamAppId: "294100",
                SteamAppID: "294100"
            };
            if (autoloadSave) {
                launchEnv.RIMAGENTIC_AUTOLOAD_SAVE = autoloadSave;
            }
            else {
                // Never inherit a stale autoload from this server's own environment into the game.
                delete launchEnv.RIMAGENTIC_AUTOLOAD_SAVE;
            }
            const child = (0, child_process_1.spawn)(rimworldExe, params, {
                detached: true,
                stdio: "ignore",
                env: launchEnv
            });
            child.unref();
            if (child.pid) {
                fs.writeFileSync(pidFilePath, child.pid.toString(), "utf8");
                logs += `RimWorld process successfully spawned in background. Tracked PID: ${child.pid}\n`;
            }
            else {
                logs += "RimWorld process successfully spawned in background (unable to resolve PID dynamically).\n";
            }
            // Guard against unattended overnight runs: close the game once the agent stops driving it.
            logs += (0, gameWatchdog_1.armGameWatchdog)({ pid: child.pid ?? null, idleTimeoutMin: args.idleTimeoutMin });
            // Trigger background virtual desktop mover to second desktop dynamically
            const moverScript = `
                Start-Sleep -Seconds 2
                $reg = Get-ItemProperty -Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VirtualDesktops" -ErrorAction Ignore
                if ($reg -and $reg.VirtualDesktopIDs -and $reg.VirtualDesktopIDs.Length -ge 32) {
                    $ids = $reg.VirtualDesktopIDs
                    $secondGuidBytes = New-Object byte[] 16
                    [Array]::Copy($ids, 16, $secondGuidBytes, 0, 16)
                    $secondGuid = New-Object Guid (,$secondGuidBytes)
                    
                    Add-Type -TypeDefinition @"
                    using System;
                    using System.Runtime.InteropServices;
                    [ComImport]
                    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
                    [Guid("a5cd92ff-29be-454c-8f04-d84f185f60f7")]
                    public interface IVirtualDesktopManager {
                        void MoveWindowToDesktop(IntPtr topLevelWindow, ref Guid desktopId);
                    }
                    public class DesktopManager {
                        public static void MoveWindow(IntPtr hwnd, Guid desktopId) {
                            Type t = Type.GetTypeFromCLSID(new Guid("aa509086-5ca9-4c25-8f95-589d3c07b48a"));
                            IVirtualDesktopManager m = (IVirtualDesktopManager)Activator.CreateInstance(t);
                            m.MoveWindowToDesktop(hwnd, ref desktopId);
                        }
                    }
"@
                    for ($i = 0; $i -lt 30; $i++) {
                        $proc = Get-Process -Name "RimWorldWin64" -ErrorAction Ignore
                        if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {
                            [DesktopManager]::MoveWindow($proc.MainWindowHandle, $secondGuid)
                            break
                        }
                        Start-Sleep -Milliseconds 500
                    }
                }
            `;
            const mover = (0, child_process_1.spawn)("powershell", ["-NoProfile", "-Command", moverScript], {
                detached: true,
                stdio: "ignore"
            });
            mover.unref();
            logs += "Virtual desktop migration script spawned in background.\n";
            // Block until the map is live, so the caller's first bridge tool call doesn't race the
            // load (the old failure mode: blind sleep + timeouts while the game was still loading).
            // Only meaningful when a live map is expected — a plain menu launch never becomes live.
            const expectsMap = quicktest || !!autoloadSave;
            const waitForReady = args.waitForReady !== false; // default on
            if (waitForReady && expectsMap) {
                const budgetMs = Math.max(5000, (args.readyTimeoutSec ?? 120) * 1000);
                logs += `Waiting up to ${Math.round(budgetMs / 1000)}s for the map to become live...\n`;
                const start = Date.now();
                let ready = null;
                while (Date.now() - start < budgetMs) {
                    // Bail immediately on a load-time crash instead of waiting out the whole budget.
                    if (child.pid && !isProcessAlive(child.pid)) {
                        logs += "Game process exited before a map became live — check read_rimworld_log for a startup crash.\n";
                        break;
                    }
                    const st = await (0, gameIpc_1.requestBridgeStatus)(1500);
                    if (st && st.mapLive) {
                        ready = st;
                        break;
                    }
                    await sleep(1000);
                }
                if (ready) {
                    const size = ready.mapSize ? `${ready.mapSize.x}x${ready.mapSize.z}` : "unknown size";
                    logs += `Map is live (${size}, hour ${ready.hourOfDay}, ${ready.colonistCount} colonists) after ${Math.round((Date.now() - start) / 1000)}s — bridge tools are ready.\n`;
                }
                else if (child.pid && isProcessAlive(child.pid)) {
                    logs += "Map did not report live within the budget — the game may still be loading. Retry a bridge tool (or get_bridge_status) shortly.\n";
                }
            }
            else if (waitForReady && !expectsMap) {
                logs += "Menu launch (no quicktest/loadSave) — not waiting for a map; the bridge serves tools once a game is loaded.\n";
            }
        }
        catch (err) {
            logs += `Launch failed: ${err.message}`;
            return { isError: true, content: [{ type: "text", text: logs }] };
        }
        return { content: [{ type: "text", text: logs }] };
    }
    if (name === "list_rimworld_saves") {
        const savedata = args.savedatafolder || config.savedatafolder || (0, config_1.getSaveDataFolder)();
        const saves = listSaves(savedata);
        return {
            content: [{
                    type: "text",
                    text: JSON.stringify({
                        savesDir: path.join(savedata, "Saves"),
                        count: saves.length,
                        saves
                    }, null, 2)
                }]
        };
    }
    if (name === "run_rimworld_tests") {
        // Thin wrapper over the reusable runTestCycle core. The tool resolves the shared-default
        // savedatafolder (args ▸ config ▸ platform default) and hands it in explicitly; the core
        // itself never reads a global. The async job broker calls runTestCycle directly with a
        // per-job pinned folder instead.
        const savedata = args.savedatafolder || (0, config_1.loadConfig)().savedatafolder || (0, config_1.getSaveDataFolder)();
        const result = await runTestCycle({
            repo: args.repo,
            savedatafolder: savedata,
            timeoutSec: args.timeoutSec
        });
        return {
            isError: !result.ok,
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        };
    }
    if (name === "read_rimworld_log") {
        const savedata = args.savedatafolder || config.savedatafolder || (0, config_1.getSaveDataFolder)();
        const linesToGet = args.lines || 100;
        let logPath = "";
        const candidates = [
            path.join(savedata, "Logs", "Player.log"),
            path.join(savedata, "Player.log"),
            path.join(process.env.USERPROFILE || "", "AppData", "LocalLow", "Ludeon Studios", "RimWorld by Ludeon Studios", "Player.log")
        ];
        for (const c of candidates) {
            if (fs.existsSync(c)) {
                logPath = c;
                break;
            }
        }
        if (!logPath) {
            throw new Error(`RimWorld Player.log file not found at any of the candidate paths.`);
        }
        try {
            const rawContent = fs.readFileSync(logPath, "utf8");
            const lines = rawContent.split(/\r?\n/);
            // Default to a triaged summary; raw tail is still available on request, since
            // scrolling 100 unfiltered lines rarely answers "did this run succeed".
            if (args.raw === true) {
                const sliceStart = Math.max(0, lines.length - linesToGet);
                return {
                    content: [{
                            type: "text",
                            text: `Read log file from: ${logPath}\nShowing last ${linesToGet} lines:\n\n${lines.slice(sliceStart).join("\n")}`
                        }]
                };
            }
            const report = classifyLog(lines, args.maxPerCategory || 25);
            return {
                content: [{
                        type: "text",
                        text: JSON.stringify({ logPath, ...report }, null, 2)
                    }]
            };
        }
        catch (e) {
            throw new Error(`Failed to read Player.log: ${e.message}`);
        }
    }
    throw new Error(`Unknown RimWorld Dev tool: ${name}`);
}
