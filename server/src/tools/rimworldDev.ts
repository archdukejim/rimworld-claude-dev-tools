import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { execSync, spawn } from "child_process";
import { loadConfig, getSaveDataFolder } from "../config";
import { resolveInstalledMods, checkModlistDrift, ModlistDrift } from "./testing";
import { armGameWatchdog } from "../gameWatchdog";
import { requestBridgeStatus, BridgeStatus } from "./gameIpc";

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Cheap liveness check for a launched game PID (signal 0 doesn't kill — it just probes). */
function isProcessAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Is the Steam client running? An isolated launch bypasses Steam (steam_appid.txt), so SteamAPI.Init
 *  fails and RimWorld enumerates only Data/ and local Mods/ — every Workshop-only mod is silently
 *  dropped. Workshop mods therefore load into an isolated launch ONLY when Steam is signed in. */
function isSteamRunning(): boolean {
    try {
        const out = execSync(
            "powershell -NoProfile -Command \"(Get-Process -Name steam -ErrorAction SilentlyContinue | Measure-Object).Count\"",
            { encoding: "utf8" }
        );
        return (parseInt(String(out).trim(), 10) || 0) > 0;
    } catch { return false; }
}

/** How many RimWorldWin64.exe processes are live right now. Used to tell a wrapper-returned launch
 *  from a genuinely-exited game (G3): launch.ps1 can report `exited` while the detached game is still
 *  alive, hung on a safe-mode dialog and holding a lock on Player.log. */
function rimWorldProcessCount(): number {
    try {
        const out = execSync(
            "powershell -NoProfile -Command \"(Get-Process -Name RimWorldWin64 -ErrorAction SilentlyContinue | Measure-Object).Count\"",
            { encoding: "utf8" }
        );
        return parseInt(String(out).trim(), 10) || 0;
    } catch { return 0; }
}

/** Fingerprint the compiled assemblies under <modDir>/Assemblies: a content hash over every .dll plus
 *  the newest mtime. Used by deploy (did the binary actually change?) and launch (is the deployed copy
 *  older than the repo build?) — the "harness reports success while the game runs a stale DLL" trap (G6). */
function assemblyFingerprint(modDir: string): { dllCount: number; hash: string | null; newestMtimeMs: number } {
    const asmDir = path.join(modDir, "Assemblies");
    let files: string[] = [];
    try { files = fs.readdirSync(asmDir).filter(f => f.toLowerCase().endsWith(".dll")).sort(); }
    catch { return { dllCount: 0, hash: null, newestMtimeMs: 0 }; }
    if (files.length === 0) return { dllCount: 0, hash: null, newestMtimeMs: 0 };
    const h = crypto.createHash("sha1");
    let newest = 0;
    for (const f of files) {
        const p = path.join(asmDir, f);
        try {
            h.update(fs.readFileSync(p));
            const mt = fs.statSync(p).mtimeMs;
            if (mt > newest) newest = mt;
        } catch { /* skip unreadable dll */ }
    }
    return { dllCount: files.length, hash: h.digest("hex"), newestMtimeMs: newest };
}

/** Short hash for logs. */
function shortHash(h: string | null): string { return h ? h.slice(0, 8) : "—"; }

/**
 * G6 (launch side) — warn when the mod copy the game will LOAD is older than the repo build. For each
 * discovered repo mod that has a real (non-symlink) deployed copy under the game's Mods folder, compare
 * assembly fingerprints: an older or byte-different deployed DLL means the game is running a stale
 * binary and a validated fix never loaded. Symlinked/junctioned copies are the repo itself, so skipped.
 */
function deployedStalenessWarnings(modsDir: string | undefined): string {
    if (!modsDir || !fs.existsSync(modsDir)) return "";
    let out = "";
    for (const mod of getModsMap()) {
        if (!mod.hasCsharp) continue;
        const repoFp = assemblyFingerprint(mod.src);
        if (repoFp.dllCount === 0 || !repoFp.hash) continue; // nothing built to be stale against
        const deployed = path.join(modsDir, mod.name);
        if (!fs.existsSync(deployed)) continue;
        if (isReparsePoint(deployed)) continue; // symlink/junction → live == repo, never stale
        const liveFp = assemblyFingerprint(deployed);
        if (liveFp.dllCount === 0 || !liveFp.hash) continue;
        if (liveFp.hash === repoFp.hash) continue; // identical → up to date
        const older = liveFp.newestMtimeMs < repoFp.newestMtimeMs;
        out += `  WARN Mods/${mod.name} is a real copy running a ${older ? "STALE" : "different"} binary ` +
            `(live hash ${shortHash(liveFp.hash)} vs repo ${shortHash(repoFp.hash)}` +
            (older ? `, live DLL is older` : "") + `) — redeploy ${mod.dirName} or the game runs the wrong DLL.\n`;
    }
    return out;
}

// Junctions this tool mirrors into the local Mods folder are named with this prefix and recorded in
// the manifest below, so they can be told apart from real mods and cleaned up. The trailing name is
// the sanitized packageId (identity comes from the target's About.xml, so the folder name is cosmetic).
const MANAGED_LINK_PREFIX = "_RimAgentic_ws_";
const MANAGED_LINK_MANIFEST = ".rimagentic-managed-links.json";

/** True only when p exists AND resolves to a different real path — i.e. it is a junction/symlink, never
 *  a real directory. Removal is gated on this so a real mod folder can never be deleted by mistake. */
function isReparsePoint(p: string): boolean {
    try {
        const real = (fs.realpathSync as any).native ? (fs.realpathSync as any).native(p) : fs.realpathSync(p);
        return path.resolve(real) !== path.resolve(p);
    } catch { return false; }
}

/** Remove a managed junction (link only, never its target), but only if it really is a reparse point. */
function removeManagedLink(modsDir: string, name: string): boolean {
    const p = path.join(modsDir, name);
    if (!fs.existsSync(p) || !isReparsePoint(p)) return false;
    try { execSync(`cmd /c rmdir "${p}"`, { stdio: "ignore" }); return true; } catch { return false; }
}

/** Create a directory junction (no admin needed) at linkPath -> target; verify the mod is visible. */
function makeJunction(linkPath: string, target: string): boolean {
    try {
        if (fs.existsSync(linkPath)) removeManagedLink(path.dirname(linkPath), path.basename(linkPath));
        execSync(`cmd /c mklink /J "${linkPath}" "${target}"`, { stdio: "ignore" });
        return fs.existsSync(path.join(linkPath, "About", "About.xml"));
    } catch { return false; }
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
function ensureActiveWorkshopModsLoadable(modsDir: string | undefined, savedata: string): string {
    if (!modsDir || !fs.existsSync(modsDir)) return "";
    const manifestPath = path.join(modsDir, MANAGED_LINK_MANIFEST);
    const readManifest = (): Record<string, string> => {
        try { return JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch { return {}; }
    };
    const writeManifest = (m: Record<string, string>) => {
        try {
            if (Object.keys(m).length) fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));
            else if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);
        } catch { /* manifest is a convenience, not correctness-critical */ }
    };
    const manifest = readManifest();

    // Which active mods live only in the Workshop?
    let active: string[] = [];
    try {
        const xml = fs.readFileSync(path.join(savedata, "Config", "ModsConfig.xml"), "utf8");
        const block = /<activeMods>([\s\S]*?)<\/activeMods>/i.exec(xml)?.[1] ?? "";
        active = Array.from(block.matchAll(/<li>([^<]+)<\/li>/gi)).map(m => m[1].trim().toLowerCase());
    } catch { return ""; }

    let byId = new Map<string, { source: string; folder: string }>();
    try { byId = new Map(resolveInstalledMods({ rimworldModsDir: modsDir }).map(m => [m.packageId, m])); }
    catch { return ""; }

    const workshopActive = active
        .map(id => ({ id, m: byId.get(id) }))
        .filter((x): x is { id: string; m: { source: string; folder: string } } => !!x.m && x.m.source === "workshop");

    // Steam signed in: native Workshop load — remove any managed junctions we made and we're done.
    if (isSteamRunning()) {
        let removed = 0;
        for (const name of Object.keys(manifest)) if (removeManagedLink(modsDir, name)) removed++;
        writeManifest({});
        let log = "";
        if (removed) log += `Steam is running — removed ${removed} managed Workshop junction(s); those mods load natively now.\n`;
        if (workshopActive.length) log += `Steam signed in: ${workshopActive.length} active Workshop mod(s) will load natively.\n`;
        return log;
    }

    // Steam signed out: mirror each active Workshop mod into local Mods/ so the isolated launch sees it.
    const needed: Record<string, string> = {};
    const mirrored: string[] = [];
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
    for (const name of Object.keys(manifest)) if (!needed[name] && removeManagedLink(modsDir, name)) removed++;
    writeManifest(needed);

    let log = "";
    if (workshopActive.length) {
        log += `WARNING: Steam is not running/signed in — ${workshopActive.length} active mod(s) live only in the Steam Workshop `;
        log += `(${workshopActive.map(x => x.id).join(", ")}). Mirrored ${mirrored.length} into local Mods as junctions so they load; `;
        log += `sign into Steam to load the Workshop natively instead.\n`;
    }
    if (removed) log += `Cleaned up ${removed} stale managed Workshop junction(s).\n`;
    return log;
}

/** Resolve the Player.log RimWorld writes, trying the savedatafolder's Logs/ first, then the
 *  Unity LocalLow default (RimWorld keeps the Player.log there regardless of -savedatafolder).
 *  Shared by read_rimworld_log and the launch first-pass so both read the same file. */
function resolvePlayerLogPath(savedata: string): string | null {
    const candidates = [
        path.join(savedata, "Logs", "Player.log"),
        path.join(savedata, "Player.log"),
        path.join(process.env.USERPROFILE || "", "AppData", "LocalLow", "Ludeon Studios", "RimWorld by Ludeon Studios", "Player.log")
    ];
    for (const c of candidates) if (fs.existsSync(c)) return c;
    return null;
}

/**
 * First-pass environment check, run immediately after a launch: confirm the modlist that will be
 * tested actually loaded clean. Reads the active modlist and triages the startup Player.log so a
 * broken test environment — missing dependency, Harmony failure, load-time exception — is surfaced
 * at launch time rather than after the agent has already started driving a doomed session.
 *
 * Best-effort and non-fatal: it never throws. When `ready` is false (a plain menu launch, where we
 * didn't wait for a map) it gives startup a short window to reach at least the menu — signalled by
 * the in-game bridge answering — so the log reflects the full mod-load pass before it is read.
 */
async function firstPassEnvironmentCheck(savedata: string, pid: number | null, ready: boolean): Promise<string> {
    if (!ready) {
        const budgetMs = 25000;
        const start = Date.now();
        while (Date.now() - start < budgetMs) {
            if (pid && !isProcessAlive(pid)) break; // crashed during startup — read whatever it left
            if (await requestBridgeStatus(1500)) break; // bridge answered → startup reached the menu
            await sleep(1000);
        }
    }

    let out = "\n--- First-pass environment check ---\n";

    // The active modlist this launch will load.
    let activeMods: string[] = [];
    const modsConfigPath = path.join(savedata, "Config", "ModsConfig.xml");
    try {
        const cfg = fs.readFileSync(modsConfigPath, "utf8");
        const block = /<activeMods>([\s\S]*?)<\/activeMods>/i.exec(cfg)?.[1] ?? "";
        activeMods = Array.from(block.matchAll(/<li>([^<]+)<\/li>/gi)).map(m => m[1].trim());
    } catch { /* absence is itself worth reporting below */ }
    out += activeMods.length
        ? `Active modlist: ${activeMods.length} mod(s) (last: ${activeMods[activeMods.length - 1]}).\n`
        : `Could not read an active modlist from ${modsConfigPath}.\n`;

    // G4 — the modlist read above is POST-launch, so if RimWorld reset ModsConfig to safe mode during
    // this run (e.g. after a base-game-absent crash), the list shown is the recovery list, NOT what
    // actually crashed. Say so, or a reader chases the wrong (post-recovery) mods.
    const drift = checkModlistDrift(savedata);
    if (drift.drifted) {
        out += `NOTE: this modlist was RESET during the run — it is POST-recovery, not what first loaded. ` +
            `RimWorld likely rewrote ModsConfig to safe mode after a startup crash. Re-run configure_active_mods.\n`;
    } else if (drift.baseGameMissing) {
        out += `NOTE: base game (ludeon.rimworld) is absent from the active modlist — RimWorld cannot load.\n`;
    }

    // Startup log triage.
    const logPath = resolvePlayerLogPath(savedata);
    if (!logPath) {
        out += `No Player.log found yet — cannot verify a clean startup. Re-check with read_rimworld_log shortly.\n`;
        return out;
    }

    let report: ReturnType<typeof classifyLog>;
    let logLines: string[] = [];
    try {
        logLines = fs.readFileSync(logPath, "utf8").split(/\r?\n/);
        report = classifyLog(logLines, 10);
    } catch (e: any) {
        out += `Could not read ${logPath}: ${e.message}\n`;
        return out;
    }

    // H2 — assert what actually loaded against what was intended. The game's own "Initializing new game
    // with mods:" block is authoritative; if it collapsed to official-only while non-official mods were
    // intended, RimWorld reset to safe mode and the run tested vanilla — a hard FAIL, not "clean".
    const loaded = parseLoadedModsFromLog(logLines);
    if (loaded && loaded.length) {
        const loadedNonOfficial = loaded.filter(id => !isOfficialPackageId(id));
        const intendedNonOfficial = activeMods.map(m => m.toLowerCase()).filter(id => !isOfficialPackageId(id));
        if (intendedNonOfficial.length > 0 && loadedNonOfficial.length === 0) {
            out += `FAIL: the run COLLAPSED to vanilla — the game initialized only official content ` +
                `(${loaded.join(", ")}) while ${intendedNonOfficial.length} mod(s) were intended ` +
                `(${intendedNonOfficial.slice(0, 8).join(", ")}${intendedNonOfficial.length > 8 ? ", …" : ""}). ` +
                `RimWorld reset ModsConfig to safe mode after a load-time crash; nothing you meant to test loaded. ` +
                `A "clean" result here is meaningless — fix the crash (see the diagnosis below) and re-run.\n`;
        } else {
            const missingFromRun = intendedNonOfficial.filter(id => !loaded.includes(id));
            out += `Game initialized ${loaded.length} mod(s) per the log` +
                (missingFromRun.length
                    ? `; MISSING from the run: ${missingFromRun.join(", ")} (intended but not loaded — RimWorld dropped them).\n`
                    : ` (matches the intended non-official set).\n`);
        }
    }

    const c = report.counts;
    if (report.ok && c.missingDependency === 0) {
        out += `Startup log clean: no blocking errors, missing dependencies, or Harmony failures. Environment looks ready.\n`;
    } else {
        out += `ENVIRONMENT PROBLEMS DETECTED in ${logPath}:\n`;
        if (c.missingDependency > 0) out += `  Missing dependencies (${c.missingDependency}): ${report.categories.missingDependency.join(" | ")}\n`;
        if (c.harmonyPatchFailure > 0) out += `  Harmony patch failures (${c.harmonyPatchFailure}): ${report.categories.harmonyPatchFailure.join(" | ")}\n`;
        if (c.xmlError > 0) out += `  XML/def errors (${c.xmlError}): ${report.categories.xmlError.slice(0, 5).join(" | ")}\n`;
        if (c.exception > 0) out += `  Exceptions (${c.exception}): ${report.categories.exception.slice(0, 3).join(" | ")}\n`;
        if (c.error > 0) out += `  Errors (${c.error}): ${report.categories.error.slice(0, 3).join(" | ")}\n`;
        out += `  Run read_rimworld_log for the full triage before trusting any test result.\n`;
    }
    if (c.versionWarning > 0) out += `  Note: ${c.versionWarning} version-mismatch warning(s).\n`;
    // G7 — surface any known crash-signature diagnosis right here, so the fix is one line away.
    for (const d of report.diagnosis || []) out += `  ${d}\n`;

    // H3 — explicit bridge liveness. The rimagentic bridge polls from GameComponentUpdate, so it only
    // registers once a Game exists; a safe-mode recovery (which disables the bridge mod) or an exit
    // before a live map leaves it dead, and run_debug_action/execute_game_tool then time out. Report it
    // now so an agent anticipates the timeout instead of discovering it call-by-call.
    if (ready) {
        out += `Bridge: rimagentic responding (map live) — run_debug_action/execute_game_tool are usable.\n`;
    } else {
        const bridge = await requestBridgeStatus(1500);
        out += bridge
            ? `Bridge: rimagentic responding${bridge.mapLive ? " (map live)" : " (no live map yet)"}.\n`
            : `Bridge: rimagentic NOT responding — run_debug_action/execute_game_tool will time out. ` +
              `If the log shows a safe-mode recovery above, the bridge mod was disabled by the reset; otherwise the ` +
              `game may still be loading or exited before a live map.\n`;
    }
    return out;
}

interface SaveFileInfo { name: string; sizeBytes: number; modified: string; modifiedMs: number; }

/** Enumerate the .rws saves under a savedatafolder's Saves/ dir, newest first. */
function listSaves(savedata: string): SaveFileInfo[] {
    const savesDir = path.join(savedata, "Saves");
    let entries: string[] = [];
    try { entries = fs.readdirSync(savesDir); } catch { return []; }
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

export const rimworldDevTools = [
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
        description: "Closes existing RimWorld instances and launches a new one with developer, quicktest, or custom save data folder parameters. When launching into a map (quicktest or loadSave) it blocks until the map is live before returning, so a following bridge tool call won't race the load. Always runs a first-pass environment check after launch: reports the active modlist and triages the startup Player.log (missing dependencies, Harmony failures, load-time exceptions) so a broken test environment is caught immediately.",
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
        description:
            "Full automated test cycle: build the mods in dependency order, launch RimWorld with the in-game " +
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
                    description:
                        "Which RimWorld config the run reads, and therefore which modlist it tests. " +
                        "Defaults to the same folder configure_active_mods writes, so configuring a " +
                        "modlist and then running the tests validates that modlist."
                }
            }
        }
    },
    {
        name: "read_rimworld_log",
        description:
            "Reads and triages RimWorld's Player.log. By default returns a classified summary — exceptions, " +
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
export function workspaceRoot(): string {
    const fromEnv = process.env.RIMAGENTIC_ROOT || process.env.RIMSYNAPSE_ROOT;
    if (fromEnv && fs.existsSync(path.join(fromEnv, "Core", "About", "About.xml"))) return fromEnv;

    // Fall back to walking up from this file: <root>/Repo-MCP/server/build/tools -> <root>
    let dir = __dirname;
    for (let i = 0; i < 5; i++) {
        if (fs.existsSync(path.join(dir, "Core", "About", "About.xml"))) return dir;
        dir = path.dirname(dir);
    }
    return "C:\\github\\rimsynapse";
}

// A mod is any folder carrying About/About.xml. Discovered from the workspace root
// rather than hardcoded, so the toolkit builds whatever mods a developer points it at
// instead of a baked-in RimSynapse list. Two layouts (matching the PowerShell harness):
// a workspace whose children are mods, or a single repo that is itself a mod. hasCsharp
// means there is a C# project under Source/ to compile; the deployed folder is named by
// the source folder, which matches the symlink-into-Mods dev workflow.
interface DiscoveredMod { name: string; dirName: string; hasCsharp: boolean; src: string; }

function hasCsharpProject(modDir: string): boolean {
    const sourceDir = path.join(modDir, "Source");
    if (!fs.existsSync(sourceDir)) return false;
    try {
        return fs.readdirSync(sourceDir).some(f => f.toLowerCase().endsWith(".csproj"));
    } catch { return false; }
}

function isModFolder(dir: string): boolean {
    return fs.existsSync(path.join(dir, "About", "About.xml"));
}

function discoverMods(root: string): DiscoveredMod[] {
    const asMod = (dir: string): DiscoveredMod => {
        const dirName = path.basename(dir);
        return { name: dirName, dirName, hasCsharp: hasCsharpProject(dir), src: dir };
    };

    // Single-repo layout: the root itself is a mod (what CI for one repo gets).
    if (isModFolder(root)) return [asMod(root)];

    // Workspace layout: each immediate child folder with About/About.xml is a mod.
    let entries: string[] = [];
    try { entries = fs.readdirSync(root); } catch { return []; }
    return entries
        .map(e => path.join(root, e))
        .filter(p => { try { return fs.statSync(p).isDirectory() && isModFolder(p); } catch { return false; } })
        .map(asMod)
        .sort((a, b) => a.dirName.localeCompare(b.dirName));
}

// Kept as a getter so the workspace root is honoured at call time rather than import time.
// Exported so the agent/broker can enumerate the developer's mods without hardcoding them.
export function getModsMap(): DiscoveredMod[] {
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
export function classifyLog(lines: string[], maxPerCategory: number) {
    const patterns: Array<[string, RegExp]> = [
        ["synapseTest", /\[SYNAPSE-TEST\]/],
        ["metadataWarning", /needs to have <downloadUrl>/i],
        ["harmonyPatchFailure", /(harmony[^\n]*(exception|fail|error|conflict))|(failed to (apply )?patch)|(patch[^\n]*(threw|failed))/i],
        ["missingDependency", /requires the mod|which is not loaded|you are missing|is not loaded/i],
        ["versionWarning", /made for a different version|different version of RimWorld|not compatible with the current/i],
        ["xmlError", /XML error|Could not (load|find|resolve)[^\n]*(Def|type)|Def named .* not found|Config error/i],
        ["exception", /exception|stacktrace/i],
        ["error", /^\s*(\[[^\]]*\])?\s*error\b|^Verse\.Log/i]
    ];

    const categories: Record<string, string[]> = {};
    for (const [key] of patterns) categories[key] = [];

    const frameRegex = /^\s+at\s+\S+/;
    let inException = false;

    for (const line of lines) {
        if (!line || !line.trim()) { inException = false; continue; }

        if (frameRegex.test(line)) {
            if (inException) categories.exception.push(line.trim());
            continue;   // orphan frame => deliberate trace logging, not an error
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
        if (!matched) inException = false;
    }

    // [SYNAPSE-TEST] PASS|FAIL <case> | <detail>
    const cases: Array<{ result: string; name: string; detail?: string }> = [];
    let passed = 0, failed = 0;
    for (const line of categories.synapseTest) {
        const m = line.match(/\[SYNAPSE-TEST\]\s+(PASS|FAIL)\s+(\S+)\s*(?:\|\s*(.*))?/);
        if (!m) continue;
        cases.push({ result: m[1], name: m[2], detail: m[3] });
        if (m[1] === "PASS") passed++; else failed++;
    }

    const counts: Record<string, number> = {};
    const trimmed: Record<string, string[]> = {};
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
        tests: { passed, failed, cases },
        diagnosis: diagnoseCrashSignatures(lines)
    };
}

/**
 * G7 — map known crash signatures to a one-line diagnosis, so a multi-hour "root-cause" hunt becomes
 * a single hint. These are the traps that have actually cost sessions, seeded from the 2026-08-12
 * base-game-absent incident. Returns [] when nothing matches — an empty diagnosis is not "healthy",
 * it just means no *known* signature fired.
 */
export function diagnoseCrashSignatures(lines: string[]): string[] {
    const joined = lines.join("\n");
    const out: string[] = [];

    // Base game / base defs inactive: RimWorld can't find the abstract parents every def inherits from.
    // This is the SPECIFIC discriminator for a base-game-absent modlist. (The downstream
    // ColoredText.ResetStaticData NRE is NOT keyed on here — per HEADLESS-TESTING-BLOCKERS.md that NRE
    // is the generic play-data recovery path and fires even with the base game present, so it would
    // misattribute; the recovery signature below covers it instead.)
    const missingBaseParents = /could not find parent node ["']Base(?:MentalState|Storyteller|Pawn|Humanlike|Weapon|Building|Apparel|Plant|Thing|Def)["']/i.test(joined);
    if (missingBaseParents) {
        out.push(
            `DIAGNOSIS: base game / base defs likely inactive — the abstract parents defs inherit from are missing. ` +
            `Ensure 'ludeon.rimworld' is in the active modlist (re-run configure_active_mods).`
        );
    }

    // Play-data recovery: RimWorld caught an exception during play-data load and reset ModsConfig to
    // safe mode ("active mods other than Core" → official-DLC-only), disabling every non-official mod
    // — Harmony, the mod under test, and the rimagentic bridge together. The run then "succeeds" as a
    // vanilla game, which the first-pass check can misread as healthy. This is the single most
    // important false-green signal for headless runs (HEADLESS-TESTING-BLOCKERS.md, both blockers).
    const recovered = /Resetting mods config and trying again|Caught exception while loading play data but there are active mods other than Core|Successfully recovered from errors/i.test(joined);
    if (recovered) {
        out.push(
            `DIAGNOSIS: RimWorld RECOVERED by resetting ModsConfig to safe mode during play-data load — the intended ` +
            `modlist was DISCARDED and the run continued as vanilla. A 'clean'/passing result here tested nothing you ` +
            `configured; the rimagentic bridge was disabled by the reset, so run_debug_action will time out. Root cause ` +
            `is an exception thrown during load (often an NRE at ColoredText.ResetStaticData) — look at the first ` +
            `patch/def error ABOVE the reset line for the mod at fault.`
        );
    }

    // Stale cross-mod reference: a companion built against an older version of another RimSynapse mod
    // fails to resolve a type at load. The assembly named is the one whose types moved.
    if (/TypeLoadException/i.test(joined)) {
        const m = joined.match(/could not (?:load|resolve) type ['"]?([^'"\n,]+?)['"]?[^\n]*?\bassembly ['"]?([A-Za-z0-9_.]+)/i);
        out.push(m
            ? `DIAGNOSIS: stale cross-mod reference — a mod references type '${m[1].trim()}' from assembly '${m[2].trim()}' ` +
              `but was built against an older version of it. Rebuild/redeploy the referencing mod.`
            : `DIAGNOSIS: TypeLoadException present — likely a stale cross-mod reference; rebuild/redeploy the referencing mod against the current assemblies.`);
    }

    return out;
}

/**
 * Parse the modlist RimWorld actually loaded, from its own `Initializing new game with mods:` block in
 * Player.log — the authoritative "what really loaded", independent of what ModsConfig.xml says on disk.
 * Returns lowercased packageIds from the LAST such block, or null if the game never got that far.
 * Used to catch a run that collapsed to vanilla after a safe-mode recovery (HEADLESS-TESTING-BLOCKERS.md
 * blocker 1): ModsConfig may still list the intended mods, but this block shows only official content.
 */
export function parseLoadedModsFromLog(lines: string[]): string[] | null {
    let startIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
        if (/Initializing new game with mods/i.test(lines[i])) { startIdx = i; break; }
    }
    if (startIdx === -1) return null;
    const mods: string[] = [];
    for (let i = startIdx + 1; i < lines.length; i++) {
        const m = lines[i].match(/^\s*-\s*([A-Za-z0-9_.]+)\s*$/);
        if (m) mods.push(m[1].trim().toLowerCase());
        else if (lines[i].trim() === "") continue; // tolerate a blank line inside the block
        else break;                                 // first real non-entry line ends the block
    }
    return mods;
}

/** Is a packageId part of the official prefix (base game, its DLCs, or Harmony)? */
function isOfficialPackageId(id: string): boolean {
    const lc = id.toLowerCase();
    return /^ludeon\.rimworld(\.|$)/.test(lc) || lc === "brrainz.harmony";
}

/**
 * Locate a harness script. This module compiles to <server>/build/tools in the repo and
 * <server>/tools in a packaged bundle, so walk up to whichever root holds harness/.
 */
function harnessScript(scriptName: string): string {
    const candidates = [
        process.env.RIMAGENTIC_HARNESS,
        process.env.RIMSYNAPSE_HARNESS,
        path.join(__dirname, "..", "..", "..", "harness"),
        path.join(__dirname, "..", "..", "harness"),
        path.join(__dirname, "..", "harness")
    ].filter(Boolean) as string[];

    for (const dir of candidates) {
        const p = path.join(dir, scriptName);
        if (fs.existsSync(p)) return p;
    }
    throw new Error(
        `Harness script "${scriptName}" not found. Looked in: ${candidates.join(", ")}. ` +
        `Set RIMSYNAPSE_HARNESS to the folder containing the harness .ps1 scripts.`
    );
}

/** Run a harness script and parse the single JSON object it prints. Never rejects. */
function runHarness(scriptName: string, scriptArgs: string[], timeoutMs: number): Promise<any> {
    return new Promise((resolve) => {
        let script: string;
        try {
            script = harnessScript(scriptName);
        } catch (err: any) {
            resolve({ ok: false, error: String(err.message) });
            return;
        }

        const child = spawn(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...scriptArgs],
            { windowsHide: true }
        );

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
            } catch {
                const lastClose = candidate.lastIndexOf("}");
                try {
                    resolve(JSON.parse(candidate.slice(0, lastClose + 1)));
                } catch {
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
 * The full RimWorld test cycle as a reusable, config-explicit core: build in
 * dependency order, launch the in-game TestRunner against a **given**
 * `savedatafolder`, then classify the log. Returns the same structured object the
 * `run_rimworld_tests` tool has always emitted.
 *
 * Unlike the tool handler, this never reads `loadConfig()` / `getSaveDataFolder()`:
 * `savedatafolder` is a required parameter. That is the invariant the async job
 * broker depends on — every run's config is passed in and pinned by the caller,
 * never inherited from a shared global (the root cause of Repo-MCP#18 / #19).
 */
export interface TestCycleOptions {
    /** Build only this repo and its dependencies (e.g. "Factions"). Omit to build everything. */
    repo?: string;
    /** Required. Which RimWorld config the run reads — and therefore which modlist it tests. */
    savedatafolder: string;
    /** Max seconds to wait for the TestRunner to report results (default 420). */
    timeoutSec?: number;
}

/**
 * The build half of the cycle. Split out so the job broker can run builds concurrently
 * (they're independent) while keeping the game-run half serial. Returns the harness build
 * result ({ ok, built, failed, warnings }).
 */
export async function buildStage(repo?: string): Promise<any> {
    const buildArgs = ["-Repo", repo].filter(Boolean) as string[];
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
export async function runStage(
    savedatafolder: string,
    timeoutSec = 420
): Promise<{ launch: any; log: any }> {
    const launch = await runHarness(
        "launch.ps1",
        ["-Test", "-TimeoutSec", String(timeoutSec), "-SaveDataFolder", savedatafolder],
        (timeoutSec + 180) * 1000
    );
    // G3 — launch.ps1 can report `exited` while the detached RimWorldWin64.exe is still alive (hung on
    // a safe-mode dialog, holding a lock on Player.log). Reconcile the wrapper's word against the real
    // process so a hang isn't mistaken for a clean exit.
    if (launch && typeof launch === "object") {
        const stillAlive = rimWorldProcessCount() > 0;
        launch.rimworldStillAlive = stillAlive;
        if (launch.exited === true && stillAlive) {
            launch.processNote = "launch wrapper returned, but RimWorldWin64.exe is still alive — the game likely hung on a dialog (e.g. safe-mode recovery), not a clean exit.";
        }
    }
    // Read the log regardless of how the launch ended — a crash still leaves evidence.
    const log = await runHarness("readlog.ps1", [], 60 * 1000);
    return { launch, log };
}

export async function runTestCycle(
    opts: TestCycleOptions
): Promise<{ ok: boolean; stage: string; build: any; launch?: any; log?: any; configDrift?: ModlistDrift; collapsedToVanilla?: boolean; diagnosis?: string }> {
    const build = await buildStage(opts.repo);
    if (!build || build.ok !== true) {
        return { ok: false, stage: "build", build };
    }

    // G5 — check for ModsConfig drift BEFORE launching. If RimWorld reset the config to safe mode after
    // a prior crash, this run would load vanilla, run nothing, exit fast, and look like a clean pass.
    const configDrift = checkModlistDrift(opts.savedatafolder);

    const { launch, log } = await runStage(opts.savedatafolder, opts.timeoutSec || 420);

    // H1/H2 — the harness readlog.ps1 does its own classification, so enrich it with the TS-side
    // crash-signature and collapse-to-vanilla checks read straight from the Player.log. This is what
    // catches a run that "recovered" to safe mode: it can pass every harness stage while having loaded
    // nothing you configured (HEADLESS-TESTING-BLOCKERS.md).
    let crashDiagnosis: string[] = [];
    let collapsedToVanilla = false;
    try {
        const lp = resolvePlayerLogPath(opts.savedatafolder);
        if (lp) {
            const lines = fs.readFileSync(lp, "utf8").split(/\r?\n/);
            crashDiagnosis = diagnoseCrashSignatures(lines);
            const loaded = parseLoadedModsFromLog(lines);
            const intended = (configDrift.expected.length ? configDrift.expected : configDrift.actual).map(m => m.toLowerCase());
            if (loaded && loaded.length) {
                const loadedNonOfficial = loaded.filter(id => !isOfficialPackageId(id));
                const intendedNonOfficial = intended.filter(id => !isOfficialPackageId(id));
                collapsedToVanilla = intendedNonOfficial.length > 0 && loadedNonOfficial.length === 0;
            }
        }
    } catch { /* best-effort enrichment; never fail the cycle over log parsing */ }
    const recovered = crashDiagnosis.some(d => /RECOVERED/.test(d));

    // G2 — a green build is NOT evidence that tests ran. A run is only valid when the TestRunner
    // actually reported a summary. Fold in the collapse/recovery signals so a run that loaded vanilla
    // can never read as a pass, even if it happened to emit a summary.
    const testsSeen = (log?.tests?.passed ?? 0) + (log?.tests?.failed ?? 0);
    const parts: string[] = [];
    if (collapsedToVanilla) {
        parts.push(
            "RUN COLLAPSED TO VANILLA — the game initialized only official content; the mods you configured " +
            "were discarded when RimWorld reset ModsConfig to safe mode after a load-time crash. This tested nothing."
        );
    }
    if (build?.ok === true && testsSeen === 0) {
        parts.push(
            "NO TESTS RAN — no [SYNAPSE-TEST] summary in the log. A green build does NOT mean tests ran. " +
            "Likely causes: the TestRunner mod isn't active/loaded-last, the base game is missing so RimWorld " +
            "reset to safe mode, or the game hung on a dialog."
        );
    }
    if (configDrift.message) parts.push(`Drift check: ${configDrift.message}`);
    parts.push(...crashDiagnosis);
    if (parts.length) parts.push("Check the first-pass env report and read_rimworld_log before trusting this result.");
    const diagnosis = parts.length ? parts.join(" ") : undefined;

    // All three stages have to agree: the build produced binaries, the game got far enough to finish the
    // suite, and the log carries no blocking entries and no shortfall in case count. A drifted config, an
    // empty run, a collapse to vanilla, or a safe-mode recovery is never a pass — even if each harness
    // stage returned ok.
    const ok = build?.ok === true && launch?.ok === true && log?.ok === true &&
        testsSeen > 0 && !configDrift.drifted && !configDrift.baseGameMissing &&
        !collapsedToVanilla && !recovered;
    return { ok, stage: "complete", build, launch, log, configDrift, collapsedToVanilla, diagnosis };
}

function copyFolderRecursiveSync(source: string, target: string) {
    if (!fs.existsSync(target)) {
        fs.mkdirSync(target, { recursive: true });
    }
    const files = fs.readdirSync(source);
    for (const file of files) {
        const curSource = path.join(source, file);
        const curTarget = path.join(target, file);
        if (fs.lstatSync(curSource).isDirectory()) {
            copyFolderRecursiveSync(curSource, curTarget);
        } else {
            fs.copyFileSync(curSource, curTarget);
        }
    }
}

export async function handleRimworldDevTool(name: string, args: any) {
    const config = loadConfig();
    
    if (name === "deploy_rimworld_mods") {
        const selectedMods = args.mods as string[] | undefined;
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
                        execSync(`dotnet build -c ${buildType}`, { cwd: sourceDir, stdio: "pipe" });
                        logs += `  Compilation successful.\n`;
                    } catch (err: any) {
                        logs += `  Compilation FAILED: ${err.message}\n${err.stderr?.toString() || ""}\n`;
                        continue;
                    }
                }
            }
            
            // 2. Package mod files
            const destPath = path.join(targetModsDir, mod.name);
            logs += `  Packaging release files to ${destPath}...\n`;

            // G6 — remember the binary that was live BEFORE this deploy, so we can say whether the
            // deploy actually changed the DLL. A no-op build that "succeeds" while the live assembly is
            // byte-identical is the classic false-green: a fix that built fine but isn't what runs.
            const priorFp = assemblyFingerprint(destPath);

            try {
                if (fs.existsSync(destPath)) {
                    const stats = fs.lstatSync(destPath);
                    if (stats.isSymbolicLink()) {
                        execSync(`cmd.exe /c rmdir "${destPath}"`, { stdio: "ignore" });
                    } else {
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
                const shipped: string[] = [];
                const unexpected: string[] = [];
                for (const entry of fs.readdirSync(mod.src)) {
                    const isDir = fs.lstatSync(path.join(mod.src, entry)).isDirectory();
                    const listed = isDir ? foldersWhitelist.includes(entry) : filesWhitelist.includes(entry);
                    if (listed) {
                        if (fs.existsSync(path.join(destPath, entry))) shipped.push(entry);
                    } else if (!knownNotShipped.has(entry)) {
                        unexpected.push(entry);
                    }
                }

                const learningDir = path.join(destPath, "Learning");
                const learningCount = fs.existsSync(learningDir)
                    ? fs.readdirSync(learningDir).filter(f => f.toLowerCase().endsWith(".md")).length
                    : 0;

                logs += `  Packaged: ${shipped.join(", ") || "(nothing)"}\n`;
                if (learningCount > 0) logs += `  Learning docs: ${learningCount}\n`;
                if (unexpected.length > 0) {
                    logs += `  NOT PACKAGED (not on the whitelist — intended?): ${unexpected.join(", ")}\n`;
                }

                // G6 — did the deployed binary actually change? Report hash/mtime so a no-op build can't
                // masquerade as a fresh deploy.
                const newFp = assemblyFingerprint(destPath);
                if (newFp.dllCount === 0) {
                    logs += `  Assemblies: none deployed (${mod.dirName} ships no DLL).\n`;
                } else if (priorFp.hash && priorFp.hash === newFp.hash) {
                    logs += `  Assemblies UNCHANGED (${newFp.dllCount} DLL, hash ${shortHash(newFp.hash)}) — no binary delta since last deploy; a source fix may not have compiled.\n`;
                } else {
                    logs += `  Assemblies updated (${newFp.dllCount} DLL, hash ${shortHash(priorFp.hash)}→${shortHash(newFp.hash)}, built ${new Date(newFp.newestMtimeMs).toISOString()}).\n`;
                }

                logs += `  Deployment successful.\n`;
            } catch (err: any) {
                logs += `  Deployment FAILED: ${err.message}\n`;
            }
        }
        
        return { content: [{ type: "text", text: logs }] };
    }
    
    if (name === "launch_rimworld") {
        const savedata = args.savedatafolder || config.savedatafolder || getSaveDataFolder();
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
        let autoloadSave: string | null = null;
        if (args.loadSave !== undefined && args.loadSave !== false && args.loadSave !== null) {
            const saves = listSaves(savedata);
            if (args.loadSave === true) {
                if (saves.length === 0) {
                    logs += `WARNING: loadSave=true but no saves exist in ${path.join(savedata, "Saves")} — launching without resume.\n`;
                } else {
                    autoloadSave = saves[0].name;
                    logs += `loadSave: resuming most recent save '${autoloadSave}' (${saves[0].modified}).\n`;
                }
            } else {
                const requested = String(args.loadSave).trim();
                if (saves.some(s => s.name.toLowerCase() === requested.toLowerCase())) {
                    autoloadSave = saves.find(s => s.name.toLowerCase() === requested.toLowerCase())!.name;
                    logs += `loadSave: resuming save '${autoloadSave}'.\n`;
                } else {
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
        const countRimWorld = (): number => {
            try {
                const out = execSync("powershell -NoProfile -Command \"(Get-CimInstance Win32_Process -Filter \\\"Name='RimWorldWin64.exe'\\\" | Measure-Object).Count\"", { encoding: "utf8" });
                return parseInt(String(out).trim(), 10) || 0;
            } catch { return 0; }
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
                    execSync(`taskkill /f /pid ${oldPid}`, { stdio: "ignore" });
                } catch (e) { /* already dead */ }
                try { fs.unlinkSync(pidFilePath); } catch (e) { /* ignore */ }
            }
            try {
                execSync("taskkill /f /im RimWorldWin64.exe", { stdio: "ignore" }); // kills ALL instances
            } catch (e) { /* taskkill exits non-zero when none are running */ }
            const after = countRimWorld();
            logs += after === 0
                ? (before > 0 ? `Closed ${before} instance(s); none remain.\n` : "No RimWorld instance was running.\n")
                : `WARNING: ${after} RimWorld instance(s) still running after cleanup — check manually.\n`;
        } else {
            const running = countRimWorld();
            if (running > 0) logs += `WARNING: ${running} RimWorld instance(s) already running and killExisting is false — launching another will strain resources.\n`;
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
        } catch (prefsErr: any) {
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
            } catch (e) {}
        }

        // Bug guard + fallback: when Steam is signed out, an isolated launch can't enumerate the Workshop,
        // so mirror each active Workshop mod (Harmony above all) into local Mods as a junction; when Steam
        // is signed in, tear those junctions back down. Self-cleaning via a tracked manifest.
        logs += ensureActiveWorkshopModsLoadable(config.rimworldModsDir, savedata);

        // G5 — did RimWorld clobber ModsConfig back to safe mode since it was configured? A drifted or
        // base-game-less list means the game will load vanilla (or nothing) and any "pass" is empty.
        const preLaunchDrift = checkModlistDrift(savedata);
        if (preLaunchDrift.message) logs += `WARNING (modlist drift): ${preLaunchDrift.message}\n`;

        // G6 — is any deployed mod copy the game will load older than the repo build? Warn before we
        // spend a whole launch cycle running a stale binary.
        const staleWarnings = deployedStalenessWarnings(config.rimworldModsDir);
        if (staleWarnings) logs += `Stale deployed binaries detected:\n${staleWarnings}`;

        const params: string[] = [
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
            const launchEnv: NodeJS.ProcessEnv = {
                ...process.env,
                SteamAppId: "294100",
                SteamAppID: "294100"
            };
            if (autoloadSave) {
                launchEnv.RIMAGENTIC_AUTOLOAD_SAVE = autoloadSave;
            } else {
                // Never inherit a stale autoload from this server's own environment into the game.
                delete launchEnv.RIMAGENTIC_AUTOLOAD_SAVE;
            }
            const child = spawn(rimworldExe, params, {
                detached: true,
                stdio: "ignore",
                env: launchEnv
            });
            child.unref();

            if (child.pid) {
                fs.writeFileSync(pidFilePath, child.pid.toString(), "utf8");
                logs += `RimWorld process successfully spawned in background. Tracked PID: ${child.pid}\n`;
            } else {
                logs += "RimWorld process successfully spawned in background (unable to resolve PID dynamically).\n";
            }

            // Guard against unattended overnight runs: close the game once the agent stops driving it.
            logs += armGameWatchdog({ pid: child.pid ?? null, idleTimeoutMin: args.idleTimeoutMin });

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

            const mover = spawn("powershell", ["-NoProfile", "-Command", moverScript], {
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
            let confirmedReady = false; // did we observe the game reach a live map?
            if (waitForReady && expectsMap) {
                const budgetMs = Math.max(5000, (args.readyTimeoutSec ?? 120) * 1000);
                logs += `Waiting up to ${Math.round(budgetMs / 1000)}s for the map to become live...\n`;
                const start = Date.now();
                let ready: BridgeStatus | null = null;
                while (Date.now() - start < budgetMs) {
                    // Bail immediately on a load-time crash instead of waiting out the whole budget.
                    if (child.pid && !isProcessAlive(child.pid)) {
                        logs += "Game process exited before a map became live — check read_rimworld_log for a startup crash.\n";
                        break;
                    }
                    const st = await requestBridgeStatus(1500);
                    if (st && st.mapLive) { ready = st; break; }
                    await sleep(1000);
                }
                if (ready) {
                    confirmedReady = true;
                    const size = ready.mapSize ? `${ready.mapSize.x}x${ready.mapSize.z}` : "unknown size";
                    logs += `Map is live (${size}, hour ${ready.hourOfDay}, ${ready.colonistCount} colonists) after ${Math.round((Date.now() - start) / 1000)}s — bridge tools are ready.\n`;
                } else if (child.pid && isProcessAlive(child.pid)) {
                    logs += "Map did not report live within the budget — the game may still be loading. Retry a bridge tool (or get_bridge_status) shortly.\n";
                }
            } else if (waitForReady && !expectsMap) {
                logs += "Menu launch (no quicktest/loadSave) — not waiting for a map; the bridge serves tools once a game is loaded.\n";
            }

            // First pass on the freshly launched environment: verify the modlist loaded and the
            // startup log is clean, so a broken test setup (a missed hard dependency, a Harmony
            // failure) is caught right now instead of after the agent starts driving the session.
            logs += await firstPassEnvironmentCheck(savedata, child.pid ?? null, confirmedReady);
        } catch (err: any) {
            logs += `Launch failed: ${err.message}`;
            return { isError: true, content: [{ type: "text", text: logs }] };
        }

        return { content: [{ type: "text", text: logs }] };
    }

    if (name === "list_rimworld_saves") {
        const savedata = args.savedatafolder || config.savedatafolder || getSaveDataFolder();
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
        const savedata = args.savedatafolder || loadConfig().savedatafolder || getSaveDataFolder();
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
        const savedata = args.savedatafolder || config.savedatafolder || getSaveDataFolder();
        const linesToGet = args.lines || 100;
        
        const logPath = resolvePlayerLogPath(savedata);
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
        } catch (e: any) {
            throw new Error(`Failed to read Player.log: ${e.message}`);
        }
    }
    
    throw new Error(`Unknown RimWorld Dev tool: ${name}`);
}
