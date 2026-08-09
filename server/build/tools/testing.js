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
exports.testingTools = void 0;
exports.resolveInstalledMods = resolveInstalledMods;
exports.findMissingDependencies = findMissingDependencies;
exports.withInstalledDependencies = withInstalledDependencies;
exports.resolveModLoadOrder = resolveModLoadOrder;
exports.handleTestingTool = handleTestingTool;
const fs = __importStar(require("fs"));
const graphql_1 = require("@octokit/graphql");
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const config_1 = require("../config");
/**
 * A mod's OWN packageId — the top-level one under <ModMetaData>, NOT a packageId nested inside a
 * dependency declaration. This is fundamental to mod resolution: nearly every mod lists
 * <modDependencies> (Vanilla Expanded and countless others put that block BEFORE their own
 * <packageId>), and each dependency carries its own <packageId>. A naive first-match regex grabs
 * that dependency instead — so, e.g., every mod that depends on Harmony reads back as
 * "brrainz.harmony", masking its real id and (via first-wins dedup) hiding the real Harmony mod
 * entirely. Strip the dependency blocks first, then take the first remaining packageId.
 */
function ownPackageId(xml) {
    const cleaned = xml
        .replace(/<modDependencies>[\s\S]*?<\/modDependencies>/gi, "")
        .replace(/<modDependenciesByVersion>[\s\S]*?<\/modDependenciesByVersion>/gi, "");
    return /<packageId>([^<]+)<\/packageId>/i.exec(cleaned)?.[1]?.trim();
}
/** Resolve a symlinked/junctioned mod folder to its real target (git clones are symlinked into Mods).
 *  Returns undefined when it can't resolve or the path is already real, so callers can show it only when it adds info. */
function realTargetOf(folder) {
    try {
        const real = fs.realpathSync.native ? fs.realpathSync.native(folder) : fs.realpathSync(folder);
        return path.resolve(real) !== path.resolve(folder) ? real : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * Every mod folder RimWorld can see, in scan order (local, then Workshop, then Data),
 * WITHOUT deduping — so two folders declaring the same packageId both appear. That raw
 * view is what detect_mod_conflicts needs to spot collisions.
 */
function scanModRoots(config) {
    const modsDir = config.rimworldModsDir || "";
    // A modlist routinely mixes local mods with Workshop ones (Empire, VOE), so both are scanned.
    const workshopDir = modsDir
        ? path.resolve(modsDir, "..", "..", "..", "workshop", "content", "294100")
        : "";
    // The base game and official DLCs are packageIds too (ludeon.rimworld, ...) and live in Data/,
    // not Mods/. Scanning it beats hardcoding an allowlist that needs editing every new expansion.
    const dataDir = modsDir ? path.resolve(modsDir, "..", "Data") : "";
    const roots = [
        { dir: modsDir, source: "local" },
        { dir: workshopDir, source: "workshop" },
        { dir: dataDir, source: "data" }
    ];
    const found = [];
    for (const { dir, source } of roots) {
        if (!dir || !fs.existsSync(dir))
            continue;
        let entries = [];
        try {
            entries = fs.readdirSync(dir);
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            const folder = path.join(dir, entry);
            const aboutPath = path.join(folder, "About", "About.xml");
            if (!fs.existsSync(aboutPath))
                continue;
            try {
                const xml = fs.readFileSync(aboutPath, "utf8");
                const id = ownPackageId(xml)?.toLowerCase();
                if (!id)
                    continue;
                const name = /<name>([\s\S]*?)<\/name>/i.exec(xml)?.[1]?.trim() || entry;
                found.push({ packageId: id, name, source, folder, realPath: realTargetOf(folder) });
            }
            catch { /* an unreadable About.xml is simply not an entry */ }
        }
    }
    return found;
}
/**
 * Scan every folder RimWorld looks in for mods and record the packageId + name each declares.
 * Order matters: local first, then Workshop, then Data — so "first wins" means a local copy
 * overrides a published one. The single scan behind both modFolderIndex and list_installed_mods.
 */
function scanInstalledMods(config) {
    const seen = new Set();
    const found = [];
    for (const m of scanModRoots(config)) {
        if (seen.has(m.packageId))
            continue; // first wins: local overrides published
        seen.add(m.packageId);
        found.push(m);
    }
    return found;
}
/**
 * Public resolver — every installed mod deduped to its OWN packageId (first-wins: local > workshop >
 * data), each with source and symlink-resolved realPath. The single, corrected source of truth for
 * "which mod is where", shared with the launch tooling so it can tell whether an active mod lives only
 * in the Steam Workshop (which an isolated, Steam-bypassed launch cannot enumerate).
 */
function resolveInstalledMods(config) {
    return scanInstalledMods(config);
}
function modFolderIndex(config) {
    const index = new Map();
    for (const m of scanInstalledMods(config)) {
        if (!index.has(m.packageId))
            index.set(m.packageId, m.folder);
    }
    return index;
}
/** Parse the About.xml fields an agent needs to place or evaluate a mod. */
function readModAbout(folder) {
    const aboutPath = path.join(folder, "About", "About.xml");
    const xml = fs.readFileSync(aboutPath, "utf8");
    const tag = (t) => new RegExp(`<${t}>([\\s\\S]*?)</${t}>`, "i").exec(xml)?.[1]?.trim();
    const list = (t) => {
        const block = new RegExp(`<${t}>([\\s\\S]*?)</${t}>`, "i").exec(xml)?.[1];
        return block ? Array.from(block.matchAll(/<li>([^<]+)<\/li>/gi)).map(m => m[1].trim()) : [];
    };
    const depIds = Array.from((/<modDependencies>([\s\S]*?)<\/modDependencies>/i.exec(xml)?.[1] ?? "")
        .matchAll(/<packageId>([^<]+)<\/packageId>/gi)).map(m => m[1].trim());
    return {
        packageId: ownPackageId(xml),
        name: tag("name"),
        author: tag("author"),
        description: tag("description"),
        supportedVersions: list("supportedVersions"),
        loadAfter: list("loadAfter"),
        loadBefore: list("loadBefore"),
        forceLoadAfter: list("forceLoadAfter"),
        forceLoadBefore: list("forceLoadBefore"),
        incompatibleWith: list("incompatibleWith"),
        modDependencies: depIds
    };
}
/** The loadAfter / loadBefore a mod declares, lowercased. Empty when the mod is not installed. */
function declaredOrdering(folder) {
    if (!folder)
        return { after: [], before: [] };
    const aboutPath = path.join(folder, "About", "About.xml");
    if (!fs.existsSync(aboutPath))
        return { after: [], before: [] };
    let xml = "";
    try {
        xml = fs.readFileSync(aboutPath, "utf8");
    }
    catch {
        return { after: [], before: [] };
    }
    const listOf = (tag) => {
        const block = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i").exec(xml)?.[1];
        if (!block)
            return [];
        return Array.from(block.matchAll(/<li>([^<]+)<\/li>/gi)).map(m => m[1].trim().toLowerCase());
    };
    // modDependencies imply ordering too: a hard dependency must load first.
    const deps = Array.from((/<modDependencies>([\s\S]*?)<\/modDependencies>/i.exec(xml)?.[1] ?? "")
        .matchAll(/<packageId>([^<]+)<\/packageId>/gi)).map(m => m[1].trim().toLowerCase());
    return {
        after: [...listOf("loadAfter"), ...deps],
        before: listOf("loadBefore")
    };
}
/**
 * A mod's declared HARD dependencies — the <modDependencies> and <modDependenciesByVersion>
 * blocks — each with the packageId it requires plus the displayName/downloadUrl the author gave.
 * These are the mods RimWorld needs BOTH installed AND active: a hard dependency that is merely
 * absent doesn't reorder anything, it makes the dependent mod fail deep in startup (the classic
 * "Could not resolve type 'HarmonyLib.Harmony'"). Empty when the mod isn't installed or declares none.
 */
function modHardDependencies(folder) {
    if (!folder)
        return [];
    const aboutPath = path.join(folder, "About", "About.xml");
    if (!fs.existsSync(aboutPath))
        return [];
    let xml = "";
    try {
        xml = fs.readFileSync(aboutPath, "utf8");
    }
    catch {
        return [];
    }
    // modDependenciesByVersion nests <li> inside per-version blocks; joining both regions and then
    // scanning for <li> finds every declared dependency regardless of which block it lives in.
    const region = [
        /<modDependencies>([\s\S]*?)<\/modDependencies>/i.exec(xml)?.[1] ?? "",
        /<modDependenciesByVersion>([\s\S]*?)<\/modDependenciesByVersion>/i.exec(xml)?.[1] ?? ""
    ].join("\n");
    const out = [];
    const seen = new Set();
    for (const li of region.matchAll(/<li>([\s\S]*?)<\/li>/gi)) {
        const inner = li[1];
        const pid = /<packageId>([^<]+)<\/packageId>/i.exec(inner)?.[1]?.trim().toLowerCase();
        if (!pid || seen.has(pid))
            continue;
        seen.add(pid);
        out.push({
            packageId: pid,
            displayName: /<displayName>([^<]+)<\/displayName>/i.exec(inner)?.[1]?.trim(),
            downloadUrl: /<downloadUrl>([^<]+)<\/downloadUrl>/i.exec(inner)?.[1]?.trim()
        });
    }
    return out;
}
/**
 * Every HARD dependency an active mod declares that is NOT itself in the active set — the check
 * that was missing. Load-order sorting only ever reasoned about mods already in the list, so a mod
 * whose prerequisite was simply absent loaded anyway and failed later with a cryptic error. The
 * `installed` flag splits "installed but not activated" (just activate it) from "not installed at
 * all" (the modlist cannot be satisfied on this machine). An uninstalled ACTIVE mod is skipped here
 * because it is already reported as `uninstalled`; we only chase dependencies of mods that exist.
 */
function findMissingDependencies(activeMods, config) {
    const index = modFolderIndex(config);
    const activeLower = new Set(activeMods.map(m => m.trim().toLowerCase()));
    const missing = [];
    const seen = new Set();
    for (const mod of activeMods) {
        const folder = index.get(mod.trim().toLowerCase());
        if (!folder)
            continue;
        for (const dep of modHardDependencies(folder)) {
            if (activeLower.has(dep.packageId))
                continue;
            const key = `${mod.trim().toLowerCase()}|${dep.packageId}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            missing.push({
                mod: mod.trim().toLowerCase(),
                dependsOn: dep.packageId,
                displayName: dep.displayName,
                downloadUrl: dep.downloadUrl,
                installed: index.has(dep.packageId)
            });
        }
    }
    return missing;
}
/**
 * Add every INSTALLED hard dependency that `activeMods` leaves out, transitively, returning the
 * augmented list and the record of what was pulled in. This is what makes a configured test
 * environment actually correct: a mod's installed prerequisites are activated for it instead of
 * being silently dropped. Dependencies that are not installed at all can't be added — they are left
 * for `findMissingDependencies` to report as unsatisfiable. Pure: reads About.xml, mutates nothing.
 */
function withInstalledDependencies(activeMods, config) {
    const index = modFolderIndex(config);
    const result = [...activeMods];
    const activeLower = new Set(result.map(m => m.trim().toLowerCase()));
    const added = [];
    let changed = true;
    while (changed) {
        changed = false;
        for (const mod of [...result]) {
            const folder = index.get(mod.trim().toLowerCase());
            if (!folder)
                continue;
            for (const dep of modHardDependencies(folder)) {
                if (activeLower.has(dep.packageId))
                    continue;
                if (!index.has(dep.packageId))
                    continue; // not installed — can't satisfy, reported elsewhere
                result.push(dep.packageId);
                activeLower.add(dep.packageId);
                added.push({ dependency: dep.packageId, requiredBy: mod.trim().toLowerCase() });
                changed = true;
            }
        }
    }
    return { activeMods: result, added };
}
/**
 * Order mods so every declared loadAfter / modDependency comes first, preserving the caller's
 * order wherever the declarations do not care.
 *
 * A stable topological sort rather than a comparator: "load after X" is not a total order, and
 * feeding a non-transitive comparator to Array.sort produces whatever the engine feels like.
 * Cycles are reported rather than thrown on — a broken pair of declarations in somebody else's
 * mod should not stop the modlist being written.
 */
function orderByDeclaredDependencies(mods, index) {
    const present = new Set(mods.map(m => m.toLowerCase()));
    const edges = new Map(); // mod -> mods that must precede it
    for (const mod of mods) {
        const key = mod.toLowerCase();
        if (!edges.has(key))
            edges.set(key, new Set());
        const { after, before } = declaredOrdering(index.get(key));
        for (const dep of after) {
            if (present.has(dep) && dep !== key)
                edges.get(key).add(dep);
        }
        for (const later of before) {
            if (!present.has(later) || later === key)
                continue;
            if (!edges.has(later))
                edges.set(later, new Set());
            edges.get(later).add(key);
        }
    }
    const order = [];
    const placed = new Set();
    const cycles = [];
    const remaining = mods.map(m => m.toLowerCase());
    while (remaining.length > 0) {
        // Take the first mod whose prerequisites are all placed — first, not any, so the caller's
        // ordering survives wherever the declarations are silent.
        const readyAt = remaining.findIndex(m => Array.from(edges.get(m) ?? []).every(dep => placed.has(dep) || !present.has(dep)));
        if (readyAt === -1) {
            // Everything left is in a cycle. Emit in caller order and say so.
            cycles.push(...remaining);
            for (const m of remaining) {
                order.push(m);
                placed.add(m);
            }
            break;
        }
        const [next] = remaining.splice(readyAt, 1);
        order.push(next);
        placed.add(next);
    }
    return { order, cycles };
}
/**
 * The official RimWorld load-order prefix: Harmony, base game, then DLCs. Everything
 * else loads after this block, ordered by what it declares.
 */
const OFFICIAL_ORDER = [
    "brrainz.harmony",
    "ludeon.rimworld",
    "ludeon.rimworld.royalty",
    "ludeon.rimworld.ideology",
    "ludeon.rimworld.biotech",
    "ludeon.rimworld.anomaly",
    "ludeon.rimworld.odyssey"
];
// The RimAgentic game mod is forced to the very end of the load order (see
// resolveModLoadOrder) so its reflection scan observes every other mod. Legacy id kept.
const TOOLKIT_PACKAGE_IDS = new Set(["archdukejim.rimagentic", "archdukejim.rimtoolkit"]);
/**
 * Resolve a set of active mods into RimWorld load order — the single source of
 * truth shared by the `configure_active_mods` writer and the read-only
 * `resolve_mod_load_order` connector, so the two can never disagree about what
 * order will actually load.
 *
 * Rules (unchanged from the writer): dedupe, official block first, then the tail
 * topologically sorted by declared loadAfter/loadBefore/modDependencies. Pure and
 * read-only — reads About.xml, writes nothing.
 *
 * `ambiguous` is what the connector adds over the writer: installed mods that
 * neither declare their own ordering nor are named by any other present mod, so the
 * topo-sort can't place them and they float on caller order. Those are exactly the
 * mods an agent has to judge. `uninstalled` are packageIds found in no mod folder —
 * RimWorld silently drops them, so they are worth naming.
 */
function resolveModLoadOrder(activeMods, config) {
    const deduped = Array.from(new Set(activeMods.map(m => m.trim())));
    const index = modFolderIndex(config);
    const officials = deduped
        .filter(m => OFFICIAL_ORDER.indexOf(m.toLowerCase()) !== -1)
        .sort((a, b) => OFFICIAL_ORDER.indexOf(a.toLowerCase()) - OFFICIAL_ORDER.indexOf(b.toLowerCase()));
    const tailInput = deduped.filter(m => OFFICIAL_ORDER.indexOf(m.toLowerCase()) === -1);
    const { order: sortedTail, cycles } = orderByDeclaredDependencies(tailInput, index);
    const resolved = [...officials, ...sortedTail];
    // The RimAgentic game mod must load DEAD LAST: its startup reflection scan should observe
    // every other mod's defs and debug actions, so it goes after everything else in the list.
    const toolkitAt = resolved.findIndex(m => TOOLKIT_PACKAGE_IDS.has(m.toLowerCase()));
    if (toolkitAt !== -1)
        resolved.push(resolved.splice(toolkitAt, 1)[0]);
    // A mod is "placed" iff it declares ordering or another present mod names it.
    // Everything installed and left out of that set is genuinely unplaced.
    const present = new Set(tailInput.map(m => m.toLowerCase()));
    const constrained = new Set();
    for (const m of tailInput) {
        const { after, before } = declaredOrdering(index.get(m.toLowerCase()));
        if (after.length || before.length)
            constrained.add(m.toLowerCase());
        for (const t of [...after, ...before])
            if (present.has(t))
                constrained.add(t);
    }
    const ambiguous = tailInput.filter(m => index.has(m.toLowerCase()) && !constrained.has(m.toLowerCase()));
    const uninstalled = deduped.filter(m => !index.has(m.toLowerCase()));
    // Unsatisfied HARD dependencies: a prerequisite a present mod declares but that is not in the
    // active set. This is the gap the load-order sort never covered — an absent dependency isn't a
    // mis-ordering, it's a mod that will fail to load. Reported so callers can activate or install it.
    const missingDependencies = findMissingDependencies(deduped, config);
    return { resolved, cycles, ambiguous, uninstalled, missingDependencies };
}
exports.testingTools = [
    {
        name: "create_testing_plan_issues",
        description: "Parse a local testing plan Markdown file, add it as a comment to the issue, and set the project item status to 'Testing'",
        inputSchema: {
            type: "object",
            properties: {
                repo: { type: "string", description: "The repository containing the issue" },
                issueNumber: { type: "number", description: "The number of the issue/ticket to comment on" },
                planFilePath: { type: "string", description: "Absolute local path to the testing plan MD file" }
            },
            required: ["repo", "issueNumber", "planFilePath"]
        }
    },
    {
        name: "restart_game",
        description: "Brings down the running RimWorld process and relaunches it with quicktest developer mode (-quicktest) enabled to bypass the main menu and load a test colony immediately.",
        inputSchema: {
            type: "object",
            properties: {
                quicktest: { type: "boolean", description: "If true, restarts with -quicktest enabled. Defaults to true." }
            }
        }
    },
    {
        name: "configure_active_mods",
        description: "Configures active mods and DLCs in RimWorld's ModsConfig.xml, resolving official-first, " +
            "dependency-aware load order. Also enforces HARD dependencies (<modDependencies>): any " +
            "installed prerequisite a chosen mod requires is automatically activated for it (transitively), " +
            "and a prerequisite that is not installed at all is reported as an error because RimWorld will " +
            "fail to load the dependent mod. Resolves file path dynamically.",
        inputSchema: {
            type: "object",
            properties: {
                activeMods: {
                    type: "array",
                    items: { type: "string" },
                    description: "List of mod IDs to set as active. Overwrites current list."
                },
                autoAddDependencies: {
                    type: "boolean",
                    description: "Automatically activate installed hard dependencies (<modDependencies>) that the chosen mods require but that were left out of the list (default: true). Set false to leave the list exactly as given and only report unsatisfied dependencies."
                },
                addMods: {
                    type: "array",
                    items: { type: "string" },
                    description: "List of mod IDs to add to the active list without overwriting the rest."
                },
                removeMods: {
                    type: "array",
                    items: { type: "string" },
                    description: "List of mod IDs to remove from the active list."
                },
                enableDlc: {
                    type: "array",
                    items: { type: "string" },
                    description: "List of DLC names to enable (royalty, ideology, biotech, anomaly, odyssey)."
                },
                disableDlc: {
                    type: "array",
                    items: { type: "string" },
                    description: "List of DLC names to disable."
                },
                savedatafolder: {
                    type: "string",
                    description: "Optional custom path for -savedatafolder. Overrides the configured path."
                }
            }
        }
    },
    {
        name: "resolve_mod_load_order",
        description: "Read-only. Resolves a set of mod packageIds into RimWorld load order using the exact " +
            "rules configure_active_mods writes with (official block first — harmony, core, DLCs — " +
            "then a topological sort of declared loadAfter/loadBefore/modDependencies). Reads each " +
            "mod's About.xml; writes nothing. Returns { resolved, ambiguous, cycles, uninstalled, " +
            "missingDependencies }: 'ambiguous' = installed mods with no ordering constraints (the ones " +
            "needing judgment), 'cycles' = mutually-conflicting declarations left in the given order, " +
            "'uninstalled' = packageIds found in no mod folder (RimWorld silently drops them), " +
            "'missingDependencies' = hard <modDependencies> prerequisites not in the set (each flagged " +
            "installed=true if just inactive, false if not on disk at all). If 'mods' is omitted, " +
            "reads the current active list from ModsConfig.xml.",
        inputSchema: {
            type: "object",
            properties: {
                mods: {
                    type: "array",
                    items: { type: "string" },
                    description: "packageIds to resolve. If omitted, reads the current active list from ModsConfig.xml."
                },
                savedatafolder: {
                    type: "string",
                    description: "Optional; which ModsConfig.xml to read the active list from when 'mods' is omitted."
                }
            }
        }
    },
    {
        name: "list_installed_mods",
        description: "Read-only. Lists every mod RimWorld can see — scanning the local Mods folder, the Steam " +
            "Workshop content folder, and the game's Data folder (base game + official DLCs). Returns " +
            "each mod's packageId, name, source (local|workshop|data), and folder. The agent's inventory " +
            "of what is available to activate. Writes nothing.",
        inputSchema: {
            type: "object",
            properties: {
                source: {
                    type: "string",
                    enum: ["local", "workshop", "data"],
                    description: "Optional filter to only mods from this source."
                }
            }
        }
    },
    {
        name: "get_mod_metadata",
        description: "Read-only. Reads a single mod's About.xml by packageId and returns its metadata: name, " +
            "author, description, supportedVersions, and every ordering/relationship declaration " +
            "(loadAfter, loadBefore, forceLoadAfter, forceLoadBefore, modDependencies, incompatibleWith). " +
            "Use this to evaluate a new or ambiguous mod before deciding where it loads. Writes nothing.",
        inputSchema: {
            type: "object",
            properties: {
                packageId: {
                    type: "string",
                    description: "The packageId to look up (case-insensitive), e.g. 'oskarpotocki.vanillafactionsexpanded.core'."
                }
            },
            required: ["packageId"]
        }
    },
    {
        name: "detect_mod_conflicts",
        description: "Read-only. Analyzes a mod set (or the active ModsConfig list) for the conflicts a modder " +
            "must deconflict: duplicate packageIds across installed folders (RimWorld loads only the " +
            "first, silently shadowing the rest — e.g. a Workshop mod squatting a DLC's id), " +
            "incompatibleWith pairs that are both active, load-order cycles from declared " +
            "loadAfter/loadBefore, and unsatisfied HARD dependencies (a <modDependencies> prerequisite " +
            "not in the active set — the dependent mod will fail to load). Returns { conflictCount, " +
            "duplicatePackageIds, incompatiblePairs, cycles, missingDependencies }. Reads About.xml; " +
            "writes nothing. If 'mods' is omitted, reads the active list from ModsConfig.xml.",
        inputSchema: {
            type: "object",
            properties: {
                mods: {
                    type: "array",
                    items: { type: "string" },
                    description: "packageIds to analyze. If omitted, reads the active list from ModsConfig.xml."
                },
                savedatafolder: {
                    type: "string",
                    description: "Optional; which ModsConfig.xml to read the active list from when 'mods' is omitted."
                }
            }
        }
    }
];
async function handleTestingTool(name, args, octokit, org, token, defaultProjectId) {
    if (name === "create_testing_plan_issues") {
        if (!fs.existsSync(args.planFilePath)) {
            throw new Error(`Testing plan file not found: ${args.planFilePath}`);
        }
        const content = fs.readFileSync(args.planFilePath, "utf8");
        const commentBody = `### Testing Plan\n\n${content}`;
        // 1. Post comment on the issue
        const commentRes = await octokit.rest.issues.createComment({
            owner: org,
            repo: args.repo,
            issue_number: args.issueNumber,
            body: commentBody
        });
        let projectUpdateStatus = "No project item updated (token or defaultProjectId missing)";
        if (token && defaultProjectId) {
            const graphqlWithAuth = graphql_1.graphql.defaults({
                headers: {
                    authorization: `token ${token}`
                }
            });
            // 2. Fetch the issue's node ID
            const { data: issue } = await octokit.rest.issues.get({
                owner: org,
                repo: args.repo,
                issue_number: args.issueNumber
            });
            const issueNodeId = issue.node_id;
            // 3. Query the issue's projectItems
            const query = `
                query($issueId: ID!) {
                    node(id: $issueId) {
                        ... on Issue {
                            projectItems(first: 10) {
                                nodes {
                                    id
                                    project {
                                        id
                                    }
                                }
                            }
                        }
                    }
                }
            `;
            const result = await graphqlWithAuth(query, { issueId: issueNodeId });
            const projectItems = result.node?.projectItems?.nodes || [];
            let projectItem = projectItems.find((item) => item.project?.id === defaultProjectId);
            let itemId = projectItem?.id;
            // If the item is not on the project board, add it first
            if (!itemId) {
                const addMutation = `
                    mutation($projectId: ID!, $contentId: ID!) {
                        addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) {
                            item {
                                id
                            }
                        }
                    }
                `;
                const addResult = await graphqlWithAuth(addMutation, {
                    projectId: defaultProjectId,
                    contentId: issueNodeId
                });
                itemId = addResult.addProjectV2ItemById.item.id;
            }
            // 4. Update its status on the project board to "Testing" (ddca9270)
            const fieldId = "PVTSSF_lADOEfI01s4BdlhxzhYGB9g";
            const optionId = "ddca9270"; // Testing status
            const statusMutation = `
                mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
                    updateProjectV2ItemFieldValue(
                        input: {
                            projectId: $projectId
                            itemId: $itemId
                            fieldId: $fieldId
                            value: { singleSelectOptionId: $optionId }
                        }
                    ) {
                        projectV2Item {
                            id
                        }
                    }
                }
            `;
            await graphqlWithAuth(statusMutation, {
                projectId: defaultProjectId,
                itemId,
                fieldId,
                optionId
            });
            projectUpdateStatus = `Project item ${itemId} status set to Testing`;
        }
        return {
            content: [{
                    type: "text",
                    text: `Comment added to issue #${args.issueNumber} (${commentRes.data.html_url}). ${projectUpdateStatus}.`
                }]
        };
    }
    if (name === "restart_game") {
        const quicktest = args.quicktest !== false;
        const config = (0, config_1.loadConfig)();
        const savedata = args.savedatafolder || config.savedatafolder || (0, config_1.getSaveDataFolder)();
        const pidFilePath = path.join(__dirname, "..", "..", "dev_instance_pid.txt");
        // 1. Safe Kill: terminate only tracked dev PID or processes running with custom savedatafolder
        let killMsg = "No active dev instance found to close.";
        if (fs.existsSync(pidFilePath)) {
            try {
                const oldPid = fs.readFileSync(pidFilePath, "utf8").trim();
                (0, child_process_1.execSync)(`taskkill /f /pid ${oldPid}`, { stdio: "ignore" });
                fs.unlinkSync(pidFilePath);
                killMsg = `Tracked dev instance PID ${oldPid} killed.`;
            }
            catch (e) { }
        }
        try {
            (0, child_process_1.execSync)(`powershell -Command "Get-CimInstance Win32_Process -Filter \\"Name = 'RimWorldWin64.exe'\\" | Where-Object { $_.CommandLine -like '*savedatafolder*' } | Foreach-Object { Stop-Process -Id $_.ProcessId -Force }"`, { stdio: "ignore" });
            killMsg = "Developer RimWorld instances closed safely.";
        }
        catch (e) { }
        // 2. Resolve RimWorld executable path
        let rimworldPath = config.rimworldPath;
        if (!rimworldPath) {
            const propsPath = "d:\\github\\rimsynapse\\Core\\Source\\GamePath.props";
            if (fs.existsSync(propsPath)) {
                const content = fs.readFileSync(propsPath, "utf-8");
                const match = content.match(/<RimWorldPath>(.*?)<\/RimWorldPath>/);
                if (match) {
                    rimworldPath = path.join(match[1].trim(), "RimWorldWin64.exe");
                }
            }
        }
        if (!rimworldPath) {
            rimworldPath = "C:\\Program Files (x86)\\Steam\\steamapps\\common\\RimWorld\\RimWorldWin64.exe";
        }
        if (!fs.existsSync(rimworldPath)) {
            throw new Error(`RimWorld executable not found at: ${rimworldPath}`);
        }
        // 3. Prevent Steam Relaunch (Write steam_appid.txt in game directory if missing)
        const gameDir = path.dirname(rimworldPath);
        const appidPath = path.join(gameDir, "steam_appid.txt");
        if (!fs.existsSync(appidPath)) {
            try {
                fs.writeFileSync(appidPath, "294100", "utf8");
            }
            catch (e) { }
        }
        // 4. Launch RimWorld directly in the background (detached and steam bypass)
        const gameArgs = [
            `-savedatafolder=${savedata}`,
            "-developer",
            "-nosound"
        ];
        if (quicktest) {
            gameArgs.push("-quicktest");
        }
        try {
            const child = (0, child_process_1.spawn)(rimworldPath, gameArgs, {
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
            }
        }
        catch (err) {
            throw new Error(`Failed to spawn RimWorld executable directly: ${err.message}`);
        }
        return {
            content: [{
                    type: "text",
                    text: `${killMsg} Spawning isolated dev game at ${rimworldPath} on ${savedata}. (PID: ${fs.existsSync(pidFilePath) ? fs.readFileSync(pidFilePath, "utf8").trim() : "unknown"})`
                }]
        };
    }
    if (name === "configure_active_mods") {
        const config = (0, config_1.loadConfig)();
        const savedata = args.savedatafolder || config.savedatafolder || (0, config_1.getSaveDataFolder)();
        const configDir = path.join(savedata, "Config");
        const configPath = path.join(configDir, "ModsConfig.xml");
        if (!fs.existsSync(configPath)) {
            try {
                fs.mkdirSync(configDir, { recursive: true });
                const defaultXml = `<?xml version="1.0" encoding="utf-8"?>\n<ModsConfigData>\n  <version>1.6.4871 rev591</version>\n  <activeMods>\n    <li>brrainz.harmony</li>\n    <li>ludeon.rimworld</li>\n  </activeMods>\n  <knownExpansions>\n    <li>ludeon.rimworld.royalty</li>\n    <li>ludeon.rimworld.ideology</li>\n    <li>ludeon.rimworld.biotech</li>\n    <li>ludeon.rimworld.anomaly</li>\n    <li>ludeon.rimworld.odyssey</li>\n  </knownExpansions>\n</ModsConfigData>`;
                fs.writeFileSync(configPath, defaultXml, "utf8");
            }
            catch (e) {
                throw new Error(`Failed to create default ModsConfig.xml: ${e.message}`);
            }
        }
        let content = fs.readFileSync(configPath, "utf8");
        // Map of DLC keywords to their mod IDs
        const dlcMap = {
            royalty: "ludeon.rimworld.royalty",
            ideology: "ludeon.rimworld.ideology",
            biotech: "ludeon.rimworld.biotech",
            anomaly: "ludeon.rimworld.anomaly",
            odyssey: "ludeon.rimworld.odyssey"
        };
        // Extract current active mods list
        let activeList = [];
        const match = content.match(/<activeMods>([\s\S]*?)<\/activeMods>/);
        if (match) {
            const listMatches = match[1].matchAll(/<li>(.*?)<\/li>/g);
            for (const lm of listMatches) {
                activeList.push(lm[1].trim());
            }
        }
        if (args.activeMods && Array.isArray(args.activeMods)) {
            activeList = args.activeMods;
        }
        else {
            // Apply addMods
            if (args.addMods && Array.isArray(args.addMods)) {
                for (const m of args.addMods) {
                    const cleanM = m.trim().toLowerCase();
                    if (!activeList.map(item => item.toLowerCase()).includes(cleanM)) {
                        activeList.push(m.trim());
                    }
                }
            }
            // Apply removeMods
            if (args.removeMods && Array.isArray(args.removeMods)) {
                const removeList = args.removeMods.map((m) => m.trim().toLowerCase());
                activeList = activeList.filter(m => !removeList.includes(m.toLowerCase()));
            }
            // Apply enableDlc
            if (args.enableDlc && Array.isArray(args.enableDlc)) {
                for (const d of args.enableDlc) {
                    const key = d.toLowerCase();
                    if (dlcMap[key] && !activeList.map(item => item.toLowerCase()).includes(dlcMap[key])) {
                        activeList.push(dlcMap[key]);
                    }
                }
            }
            // Apply disableDlc
            if (args.disableDlc && Array.isArray(args.disableDlc)) {
                for (const d of args.disableDlc) {
                    const key = d.toLowerCase();
                    if (dlcMap[key]) {
                        activeList = activeList.filter(m => m.toLowerCase() !== dlcMap[key]);
                    }
                }
            }
        }
        // Pull in installed HARD dependencies the caller left out, BEFORE ordering. A hard
        // dependency (<modDependencies>) must be both installed AND active or the dependent mod
        // fails deep in startup; the load-order sort alone never noticed an absent prerequisite,
        // so a missing dependency was silently dropped (the recent miss this fixes). Installed
        // prerequisites are activated for their dependents; ones not installed at all are reported.
        const autoAddDeps = args.autoAddDependencies !== false;
        let autoAdded = [];
        if (autoAddDeps) {
            const augmented = withInstalledDependencies(activeList, config);
            activeList = augmented.activeMods;
            autoAdded = augmented.added;
        }
        // Resolve into official-first, dependency-aware load order via the shared resolver.
        // Ignoring loadAfter here once silently disabled Factions: alphabetical order put it
        // ahead of Regions-and-Territories whose assembly it binds against, so every Factions
        // type failed to resolve with only four "Could not find a type named ..." lines as
        // evidence. RimWorld obeys this file and treats loadAfter as advisory.
        const { resolved, cycles, uninstalled: missing, missingDependencies } = resolveModLoadOrder(activeList, config);
        activeList = resolved;
        // After auto-add, anything still unsatisfied is a hard dependency not installed at all (or,
        // if autoAddDependencies was disabled, one merely not activated). The former can't be fixed
        // from here and breaks the run; the latter is fixable by the caller.
        const unsatisfiedDeps = missingDependencies.filter(d => !d.installed);
        const inactiveDeps = missingDependencies.filter(d => d.installed); // only when auto-add is off
        // Format activeMods XML block
        const newActiveXml = `<activeMods>\n` + activeList.map(m => `        <li>${m}</li>`).join("\n") + `\n    </activeMods>`;
        if (content.includes("<activeMods>")) {
            content = content.replace(/<activeMods>[\s\S]*?<\/activeMods>/, newActiveXml);
        }
        else {
            content = content.replace("<ModsConfigData>", `<ModsConfigData>\n    ${newActiveXml}`);
        }
        fs.writeFileSync(configPath, content, "utf8");
        // Say what was written, where, and what is wrong with it. A modlist naming a mod that is
        // not installed used to be accepted in silence: RimWorld drops the entry, the mod's own
        // "not detected" branch logs, and the run looks like evidence about that mod when it is
        // only evidence that it was never loaded. `missing` comes from the resolver above.
        const notes = [];
        notes.push(`Wrote ${configPath}`);
        if (autoAdded.length > 0) {
            notes.push(`Auto-activated ${autoAdded.length} installed hard dependency(ies): ` +
                autoAdded.map(a => `${a.dependency} (required by ${a.requiredBy})`).join(", "));
        }
        if (unsatisfiedDeps.length > 0) {
            notes.push(`MISSING HARD DEPENDENCY — not installed; RimWorld will fail to load the dependent mod: ` +
                unsatisfiedDeps.map(d => {
                    const nm = d.displayName ? `${d.displayName} [${d.dependsOn}]` : d.dependsOn;
                    const src = d.downloadUrl ? ` — get it: ${d.downloadUrl}` : "";
                    return `${nm} required by ${d.mod}${src}`;
                }).join("; "));
        }
        if (inactiveDeps.length > 0) {
            notes.push(`Installed but NOT activated (autoAddDependencies is off — activate these or re-run with it on): ` +
                inactiveDeps.map(d => `${d.dependsOn} required by ${d.mod}`).join(", "));
        }
        if (missing.length > 0) {
            notes.push(`NOT INSTALLED (RimWorld will ignore these): ${missing.join(", ")}`);
        }
        if (cycles.length > 0) {
            notes.push(`Circular loadAfter/loadBefore among: ${cycles.join(", ")} — left in the order given.`);
        }
        const hasBlockingProblem = missing.length > 0 || unsatisfiedDeps.length > 0;
        const headline = hasBlockingProblem
            ? `Configured ModsConfig.xml, but the test environment is NOT sound (see notes).`
            : autoAdded.length > 0
                ? `Successfully configured ModsConfig.xml (auto-activated ${autoAdded.length} missing hard dependency(ies)).`
                : `Successfully configured ModsConfig.xml.`;
        return {
            isError: hasBlockingProblem,
            content: [{
                    type: "text",
                    text: [
                        headline,
                        ...notes,
                        `Active mods, in load order: ${JSON.stringify(activeList)}`
                    ].join("\n")
                }]
        };
    }
    if (name === "resolve_mod_load_order") {
        const config = (0, config_1.loadConfig)();
        let mods = Array.isArray(args.mods) ? args.mods.map((m) => String(m)) : [];
        // No explicit set → resolve whatever ModsConfig.xml currently has active.
        if (mods.length === 0) {
            const savedata = args.savedatafolder || config.savedatafolder || (0, config_1.getSaveDataFolder)();
            const configPath = path.join(savedata, "Config", "ModsConfig.xml");
            if (!fs.existsSync(configPath)) {
                throw new Error(`No 'mods' provided and no ModsConfig.xml at ${configPath}.`);
            }
            const content = fs.readFileSync(configPath, "utf8");
            const match = content.match(/<activeMods>([\s\S]*?)<\/activeMods>/);
            if (match) {
                for (const lm of match[1].matchAll(/<li>(.*?)<\/li>/g))
                    mods.push(lm[1].trim());
            }
        }
        const result = resolveModLoadOrder(mods, config);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    if (name === "list_installed_mods") {
        const config = (0, config_1.loadConfig)();
        let mods = scanInstalledMods(config);
        if (args.source)
            mods = mods.filter(m => m.source === args.source);
        return {
            content: [{
                    type: "text",
                    text: JSON.stringify({ count: mods.length, mods }, null, 2)
                }]
        };
    }
    if (name === "get_mod_metadata") {
        if (!args.packageId)
            throw new Error("get_mod_metadata requires a packageId.");
        const config = (0, config_1.loadConfig)();
        const folder = modFolderIndex(config).get(String(args.packageId).trim().toLowerCase());
        if (!folder) {
            return {
                isError: true,
                content: [{ type: "text", text: JSON.stringify({ found: false, packageId: args.packageId }, null, 2) }]
            };
        }
        const meta = readModAbout(folder);
        return { content: [{ type: "text", text: JSON.stringify({ found: true, folder, ...meta }, null, 2) }] };
    }
    if (name === "detect_mod_conflicts") {
        const config = (0, config_1.loadConfig)();
        let mods = Array.isArray(args.mods) ? args.mods.map((m) => String(m)) : [];
        if (mods.length === 0) {
            const savedata = args.savedatafolder || config.savedatafolder || (0, config_1.getSaveDataFolder)();
            const configPath = path.join(savedata, "Config", "ModsConfig.xml");
            if (fs.existsSync(configPath)) {
                const content = fs.readFileSync(configPath, "utf8");
                const match = content.match(/<activeMods>([\s\S]*?)<\/activeMods>/);
                if (match)
                    for (const lm of match[1].matchAll(/<li>(.*?)<\/li>/g))
                        mods.push(lm[1].trim());
            }
        }
        const setLower = new Set(mods.map(m => m.toLowerCase()));
        const index = modFolderIndex(config);
        // 1. Duplicate packageIds across installed folders — RimWorld loads only the first.
        const byId = new Map();
        for (const m of scanModRoots(config)) {
            if (!byId.has(m.packageId))
                byId.set(m.packageId, []);
            byId.get(m.packageId).push(m.folder);
        }
        const duplicatePackageIds = Array.from(byId.entries())
            .filter(([, folders]) => folders.length > 1)
            .map(([packageId, folders]) => ({
            packageId,
            folders,
            note: `${folders.length} folders declare this id; RimWorld loads the first and shadows ${folders.length - 1}`
        }));
        // 2. incompatibleWith pairs where both sides are in the set.
        const incompatiblePairs = [];
        const seenPair = new Set();
        for (const m of mods) {
            const folder = index.get(m.toLowerCase());
            if (!folder)
                continue;
            const inc = readModAbout(folder).incompatibleWith || [];
            for (const other of inc) {
                if (!setLower.has(other.toLowerCase()))
                    continue;
                const key = [m.toLowerCase(), other.toLowerCase()].sort().join("|");
                if (!seenPair.has(key)) {
                    seenPair.add(key);
                    incompatiblePairs.push({ a: m, b: other });
                }
            }
        }
        // 3. Load-order cycles within the set (official block never cycles).
        const { cycles } = orderByDeclaredDependencies(mods.filter(m => OFFICIAL_ORDER.indexOf(m.toLowerCase()) === -1), index);
        // 4. Unsatisfied hard dependencies — a prerequisite an active mod requires but that is not
        // active. RimWorld will load the dependent mod and it will fail; this is the class of miss
        // that motivated the check. Reported alongside the deconfliction conflicts.
        const missingDependencies = findMissingDependencies(mods, config);
        const conflictCount = duplicatePackageIds.length + incompatiblePairs.length
            + (cycles.length > 0 ? 1 : 0) + missingDependencies.length;
        return {
            content: [{
                    type: "text",
                    text: JSON.stringify({ conflictCount, duplicatePackageIds, incompatiblePairs, cycles, missingDependencies }, null, 2)
                }]
        };
    }
    throw new Error(`Unknown testing tool: ${name}`);
}
