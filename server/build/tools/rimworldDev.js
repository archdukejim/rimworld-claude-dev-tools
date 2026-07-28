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
exports.classifyLog = classifyLog;
exports.handleRimworldDevTool = handleRimworldDevTool;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const config_1 = require("../config");
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
        description: "Closes existing RimWorld instances and launches a new one with developer, quicktest, or custom save data folder parameters.",
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
    const fromEnv = process.env.RIMSYNAPSE_ROOT;
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
// dirName is the repo folder; name is the folder the mod is packaged into under Mods\.
// Ordered so dependencies build first: Core, then Regions, then the rest, Factions last.
const modDefs = [
    { name: "RimSynapseCore", dirName: "Core", hasCsharp: true },
    { name: "RimSynapseRegionsAndTerritories", dirName: "Regions-and-Territories", hasCsharp: true },
    { name: "RimSynapseConversations", dirName: "Conversations", hasCsharp: true },
    { name: "RimSynapsePsychology", dirName: "Psychology", hasCsharp: true },
    { name: "RimSynapseWorldNews", dirName: "WorldNews", hasCsharp: true },
    { name: "RimSynapseNVIDIATool", dirName: "NVIDIA-Tool", hasCsharp: true },
    { name: "RimSynapseFactions", dirName: "Factions", hasCsharp: true },
    { name: "RimSynapseAuraAlgorithm", dirName: "AuraAlgorithm", hasCsharp: false },
    { name: "RimSynapseLLMTrainer", dirName: "LLM-Trainer", hasCsharp: true },
    { name: "RimSynapseTestRunner", dirName: "TestRunner", hasCsharp: true }
];
// Kept as a getter so RIMSYNAPSE_ROOT is honoured at call time rather than import time.
function getModsMap() {
    const root = workspaceRoot();
    return modDefs.map(m => ({ ...m, src: path.join(root, m.dirName) }));
}
const foldersWhitelist = [
    "About",
    "Assemblies",
    "Defs",
    "Textures",
    "Patches",
    "Languages",
    "Sounds",
    "Common",
    "1.0",
    "1.1",
    "1.2",
    "1.3",
    "1.4",
    "1.5",
    "1.6"
];
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
        const quicktest = args.quicktest === true;
        const developer = args.developer !== false;
        const killExisting = args.killExisting !== false;
        const verbose = args.verbose === true;
        const nosound = args.nosound !== false;
        const pidFilePath = path.join(__dirname, "..", "..", "dev_instance_pid.txt");
        let logs = `Launching RimWorld directly...\n`;
        if (killExisting) {
            logs += "Closing existing developer RimWorld instances...\n";
            // 1. Try to close the specifically tracked PID first
            if (fs.existsSync(pidFilePath)) {
                try {
                    const oldPid = fs.readFileSync(pidFilePath, "utf8").trim();
                    logs += `Closing tracked developer instance with PID ${oldPid}...\n`;
                    (0, child_process_1.execSync)(`taskkill /f /pid ${oldPid}`, { stdio: "ignore" });
                    fs.unlinkSync(pidFilePath);
                }
                catch (e) {
                    // Ignore if already dead
                }
            }
            // 2. Backup safety check: scan all RimWorld processes and terminate ONLY those containing '-savedatafolder'.
            try {
                (0, child_process_1.execSync)("powershell -Command \"Get-CimInstance Win32_Process -Filter \\\"Name = 'RimWorldWin64.exe'\\\" | Where-Object { $_.CommandLine -like '*savedatafolder*' } | Foreach-Object { Stop-Process -Id $_.ProcessId -Force }\"", { stdio: "ignore" });
                logs += "Targeted developer instances cleanup completed safely.\n";
            }
            catch (e) {
                // Ignore if none found
            }
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
            const child = (0, child_process_1.spawn)(rimworldExe, params, {
                detached: true,
                stdio: "ignore",
                env: {
                    ...process.env,
                    SteamAppId: "294100",
                    SteamAppID: "294100"
                }
            });
            child.unref();
            if (child.pid) {
                fs.writeFileSync(pidFilePath, child.pid.toString(), "utf8");
                logs += `RimWorld process successfully spawned in background. Tracked PID: ${child.pid}\n`;
            }
            else {
                logs += "RimWorld process successfully spawned in background (unable to resolve PID dynamically).\n";
            }
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
            logs += "Virtual desktop migration script spawned in background.";
        }
        catch (err) {
            logs += `Launch failed: ${err.message}`;
            return { isError: true, content: [{ type: "text", text: logs }] };
        }
        return { content: [{ type: "text", text: logs }] };
    }
    if (name === "run_rimworld_tests") {
        // Delegates to the PowerShell harness, which owns build order, the Steam launch and
        // log rotation. Each script prints a single JSON object, so this stays thin.
        const timeoutSec = args.timeoutSec || 420;
        const buildArgs = ["-Repo", args.repo].filter(Boolean);
        const build = await runHarness("build.ps1", args.repo ? buildArgs : [], 10 * 60 * 1000);
        if (!build || build.ok !== true) {
            return {
                isError: true,
                content: [{ type: "text", text: JSON.stringify({ ok: false, stage: "build", build }, null, 2) }]
            };
        }
        const launch = await runHarness("launch.ps1", ["-Test", "-TimeoutSec", String(timeoutSec)], (timeoutSec + 180) * 1000);
        // Read the log regardless of how the launch ended — a crash still leaves evidence.
        const log = await runHarness("readlog.ps1", [], 60 * 1000);
        const ok = build?.ok === true && log?.ok === true;
        return {
            isError: !ok,
            content: [{ type: "text", text: JSON.stringify({ ok, stage: "complete", build, launch, log }, null, 2) }]
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
