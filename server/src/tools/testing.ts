import { Octokit } from "@octokit/rest";
import * as fs from "fs";
import { graphql } from "@octokit/graphql";
import * as path from "path";
import { execSync, spawn } from "child_process";
import { loadConfig, getSaveDataFolder } from "../config";

/** packageId (lowercased) -> the folder that mod lives in. */
type ModIndex = Map<string, string>;

/**
 * Every folder RimWorld will look in for mods, and the packageId each one declares.
 *
 * Covers the local Mods directory and the Steam Workshop content directory, because a modlist
 * routinely mixes both — Empire and VOE come from the Workshop while the RimSynapse mods are
 * local. A packageId present in neither is not installed, which is worth saying out loud rather
 * than writing into the config and letting RimWorld drop it silently.
 */
/** Where a mod folder was found. "data" = base game + official DLCs under RimWorld/Data. */
type ModSource = "local" | "workshop" | "data";
interface InstalledMod { packageId: string; name: string; source: ModSource; folder: string; }

/**
 * Every mod folder RimWorld can see, in scan order (local, then Workshop, then Data),
 * WITHOUT deduping — so two folders declaring the same packageId both appear. That raw
 * view is what detect_mod_conflicts needs to spot collisions.
 */
function scanModRoots(config: { rimworldModsDir?: string }): InstalledMod[] {
    const modsDir = config.rimworldModsDir || "";
    // A modlist routinely mixes local mods with Workshop ones (Empire, VOE), so both are scanned.
    const workshopDir = modsDir
        ? path.resolve(modsDir, "..", "..", "..", "workshop", "content", "294100")
        : "";
    // The base game and official DLCs are packageIds too (ludeon.rimworld, ...) and live in Data/,
    // not Mods/. Scanning it beats hardcoding an allowlist that needs editing every new expansion.
    const dataDir = modsDir ? path.resolve(modsDir, "..", "Data") : "";

    const roots: Array<{ dir: string; source: ModSource }> = [
        { dir: modsDir, source: "local" },
        { dir: workshopDir, source: "workshop" },
        { dir: dataDir, source: "data" }
    ];

    const found: InstalledMod[] = [];
    for (const { dir, source } of roots) {
        if (!dir || !fs.existsSync(dir)) continue;
        let entries: string[] = [];
        try { entries = fs.readdirSync(dir); } catch { continue; }

        for (const entry of entries) {
            const folder = path.join(dir, entry);
            const aboutPath = path.join(folder, "About", "About.xml");
            if (!fs.existsSync(aboutPath)) continue;
            try {
                const xml = fs.readFileSync(aboutPath, "utf8");
                const id = /<packageId>([^<]+)<\/packageId>/i.exec(xml)?.[1]?.trim().toLowerCase();
                if (!id) continue;
                const name = /<name>([\s\S]*?)<\/name>/i.exec(xml)?.[1]?.trim() || entry;
                found.push({ packageId: id, name, source, folder });
            } catch { /* an unreadable About.xml is simply not an entry */ }
        }
    }
    return found;
}

/**
 * Scan every folder RimWorld looks in for mods and record the packageId + name each declares.
 * Order matters: local first, then Workshop, then Data — so "first wins" means a local copy
 * overrides a published one. The single scan behind both modFolderIndex and list_installed_mods.
 */
function scanInstalledMods(config: { rimworldModsDir?: string }): InstalledMod[] {
    const seen = new Set<string>();
    const found: InstalledMod[] = [];
    for (const m of scanModRoots(config)) {
        if (seen.has(m.packageId)) continue;   // first wins: local overrides published
        seen.add(m.packageId);
        found.push(m);
    }
    return found;
}

function modFolderIndex(config: { rimworldModsDir?: string }): ModIndex {
    const index: ModIndex = new Map();
    for (const m of scanInstalledMods(config)) {
        if (!index.has(m.packageId)) index.set(m.packageId, m.folder);
    }
    return index;
}

/** Parse the About.xml fields an agent needs to place or evaluate a mod. */
function readModAbout(folder: string): Record<string, any> {
    const aboutPath = path.join(folder, "About", "About.xml");
    const xml = fs.readFileSync(aboutPath, "utf8");
    const tag = (t: string) => new RegExp(`<${t}>([\\s\\S]*?)</${t}>`, "i").exec(xml)?.[1]?.trim();
    const list = (t: string): string[] => {
        const block = new RegExp(`<${t}>([\\s\\S]*?)</${t}>`, "i").exec(xml)?.[1];
        return block ? Array.from(block.matchAll(/<li>([^<]+)<\/li>/gi)).map(m => m[1].trim()) : [];
    };
    const depIds = Array.from(
        (/<modDependencies>([\s\S]*?)<\/modDependencies>/i.exec(xml)?.[1] ?? "")
            .matchAll(/<packageId>([^<]+)<\/packageId>/gi)
    ).map(m => m[1].trim());

    return {
        packageId: tag("packageId"),
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
function declaredOrdering(folder: string | undefined): { after: string[]; before: string[] } {
    if (!folder) return { after: [], before: [] };
    const aboutPath = path.join(folder, "About", "About.xml");
    if (!fs.existsSync(aboutPath)) return { after: [], before: [] };

    let xml = "";
    try { xml = fs.readFileSync(aboutPath, "utf8"); } catch { return { after: [], before: [] }; }

    const listOf = (tag: string): string[] => {
        const block = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i").exec(xml)?.[1];
        if (!block) return [];
        return Array.from(block.matchAll(/<li>([^<]+)<\/li>/gi)).map(m => m[1].trim().toLowerCase());
    };

    // modDependencies imply ordering too: a hard dependency must load first.
    const deps = Array.from(
        (/<modDependencies>([\s\S]*?)<\/modDependencies>/i.exec(xml)?.[1] ?? "")
            .matchAll(/<packageId>([^<]+)<\/packageId>/gi)
    ).map(m => m[1].trim().toLowerCase());

    return {
        after: [...listOf("loadAfter"), ...deps],
        before: listOf("loadBefore")
    };
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
function orderByDeclaredDependencies(mods: string[], index: ModIndex): { order: string[]; cycles: string[] } {
    const present = new Set(mods.map(m => m.toLowerCase()));
    const edges = new Map<string, Set<string>>(); // mod -> mods that must precede it

    for (const mod of mods) {
        const key = mod.toLowerCase();
        if (!edges.has(key)) edges.set(key, new Set());

        const { after, before } = declaredOrdering(index.get(key));
        for (const dep of after) {
            if (present.has(dep) && dep !== key) edges.get(key)!.add(dep);
        }
        for (const later of before) {
            if (!present.has(later) || later === key) continue;
            if (!edges.has(later)) edges.set(later, new Set());
            edges.get(later)!.add(key);
        }
    }

    const order: string[] = [];
    const placed = new Set<string>();
    const cycles: string[] = [];
    const remaining = mods.map(m => m.toLowerCase());

    while (remaining.length > 0) {
        // Take the first mod whose prerequisites are all placed — first, not any, so the caller's
        // ordering survives wherever the declarations are silent.
        const readyAt = remaining.findIndex(m =>
            Array.from(edges.get(m) ?? []).every(dep => placed.has(dep) || !present.has(dep))
        );

        if (readyAt === -1) {
            // Everything left is in a cycle. Emit in caller order and say so.
            cycles.push(...remaining);
            for (const m of remaining) { order.push(m); placed.add(m); }
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
export function resolveModLoadOrder(
    activeMods: string[],
    config: { rimworldModsDir?: string }
): { resolved: string[]; cycles: string[]; ambiguous: string[]; uninstalled: string[] } {
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
    if (toolkitAt !== -1) resolved.push(resolved.splice(toolkitAt, 1)[0]);

    // A mod is "placed" iff it declares ordering or another present mod names it.
    // Everything installed and left out of that set is genuinely unplaced.
    const present = new Set(tailInput.map(m => m.toLowerCase()));
    const constrained = new Set<string>();
    for (const m of tailInput) {
        const { after, before } = declaredOrdering(index.get(m.toLowerCase()));
        if (after.length || before.length) constrained.add(m.toLowerCase());
        for (const t of [...after, ...before]) if (present.has(t)) constrained.add(t);
    }
    const ambiguous = tailInput.filter(
        m => index.has(m.toLowerCase()) && !constrained.has(m.toLowerCase())
    );

    const uninstalled = deduped.filter(m => !index.has(m.toLowerCase()));

    return { resolved, cycles, ambiguous, uninstalled };
}

export const testingTools = [
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
        description: "Configures active mods and DLCs in RimWorld's ModsConfig.xml. Resolves file path dynamically.",
        inputSchema: {
            type: "object",
            properties: {
                activeMods: {
                    type: "array",
                    items: { type: "string" },
                    description: "List of mod IDs to set as active. Overwrites current list."
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
        description:
            "Read-only. Resolves a set of mod packageIds into RimWorld load order using the exact " +
            "rules configure_active_mods writes with (official block first — harmony, core, DLCs — " +
            "then a topological sort of declared loadAfter/loadBefore/modDependencies). Reads each " +
            "mod's About.xml; writes nothing. Returns { resolved, ambiguous, cycles, uninstalled }: " +
            "'ambiguous' = installed mods with no ordering constraints (the ones needing judgment), " +
            "'cycles' = mutually-conflicting declarations left in the given order, 'uninstalled' = " +
            "packageIds found in no mod folder (RimWorld silently drops them). If 'mods' is omitted, " +
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
        description:
            "Read-only. Lists every mod RimWorld can see — scanning the local Mods folder, the Steam " +
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
        description:
            "Read-only. Reads a single mod's About.xml by packageId and returns its metadata: name, " +
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
        description:
            "Read-only. Analyzes a mod set (or the active ModsConfig list) for the conflicts a modder " +
            "must deconflict: duplicate packageIds across installed folders (RimWorld loads only the " +
            "first, silently shadowing the rest — e.g. a Workshop mod squatting a DLC's id), " +
            "incompatibleWith pairs that are both active, and load-order cycles from declared " +
            "loadAfter/loadBefore. Returns { conflictCount, duplicatePackageIds, incompatiblePairs, " +
            "cycles }. Reads About.xml; writes nothing. If 'mods' is omitted, reads the active list " +
            "from ModsConfig.xml.",
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

export async function handleTestingTool(
    name: string,
    args: any,
    octokit: Octokit,
    org: string,
    token?: string,
    defaultProjectId?: string
) {
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
            const graphqlWithAuth = graphql.defaults({
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
            const result: any = await graphqlWithAuth(query, { issueId: issueNodeId });
            const projectItems = result.node?.projectItems?.nodes || [];
            
            let projectItem = projectItems.find((item: any) => item.project?.id === defaultProjectId);
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
                const addResult: any = await graphqlWithAuth(addMutation, { 
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
        const config = loadConfig();
        const savedata = args.savedatafolder || config.savedatafolder || getSaveDataFolder();
        const pidFilePath = path.join(__dirname, "..", "..", "dev_instance_pid.txt");

        // 1. Safe Kill: terminate only tracked dev PID or processes running with custom savedatafolder
        let killMsg = "No active dev instance found to close.";
        if (fs.existsSync(pidFilePath)) {
            try {
                const oldPid = fs.readFileSync(pidFilePath, "utf8").trim();
                execSync(`taskkill /f /pid ${oldPid}`, { stdio: "ignore" });
                fs.unlinkSync(pidFilePath);
                killMsg = `Tracked dev instance PID ${oldPid} killed.`;
            } catch (e) {}
        }
        try {
            execSync(`powershell -Command "Get-CimInstance Win32_Process -Filter \\"Name = 'RimWorldWin64.exe'\\" | Where-Object { $_.CommandLine -like '*savedatafolder*' } | Foreach-Object { Stop-Process -Id $_.ProcessId -Force }"`, { stdio: "ignore" });
            killMsg = "Developer RimWorld instances closed safely.";
        } catch (e) {}

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
            } catch (e) {}
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
            const child = spawn(rimworldPath, gameArgs, {
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
        } catch (err: any) {
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
        const config = loadConfig();
        const savedata = args.savedatafolder || config.savedatafolder || getSaveDataFolder();
        const configDir = path.join(savedata, "Config");
        const configPath = path.join(configDir, "ModsConfig.xml");

        if (!fs.existsSync(configPath)) {
            try {
                fs.mkdirSync(configDir, { recursive: true });
                const defaultXml = `<?xml version="1.0" encoding="utf-8"?>\n<ModsConfigData>\n  <version>1.6.4871 rev591</version>\n  <activeMods>\n    <li>brrainz.harmony</li>\n    <li>ludeon.rimworld</li>\n  </activeMods>\n  <knownExpansions>\n    <li>ludeon.rimworld.royalty</li>\n    <li>ludeon.rimworld.ideology</li>\n    <li>ludeon.rimworld.biotech</li>\n    <li>ludeon.rimworld.anomaly</li>\n    <li>ludeon.rimworld.odyssey</li>\n  </knownExpansions>\n</ModsConfigData>`;
                fs.writeFileSync(configPath, defaultXml, "utf8");
            } catch (e: any) {
                throw new Error(`Failed to create default ModsConfig.xml: ${e.message}`);
            }
        }

        let content = fs.readFileSync(configPath, "utf8");
        
        // Map of DLC keywords to their mod IDs
        const dlcMap: Record<string, string> = {
            royalty: "ludeon.rimworld.royalty",
            ideology: "ludeon.rimworld.ideology",
            biotech: "ludeon.rimworld.biotech",
            anomaly: "ludeon.rimworld.anomaly",
            odyssey: "ludeon.rimworld.odyssey"
        };

        // Extract current active mods list
        let activeList: string[] = [];
        const match = content.match(/<activeMods>([\s\S]*?)<\/activeMods>/);
        if (match) {
            const listMatches = match[1].matchAll(/<li>(.*?)<\/li>/g);
            for (const lm of listMatches) {
                activeList.push(lm[1].trim());
            }
        }

        if (args.activeMods && Array.isArray(args.activeMods)) {
            activeList = args.activeMods;
        } else {
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
                const removeList = args.removeMods.map((m: string) => m.trim().toLowerCase());
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

        // Resolve into official-first, dependency-aware load order via the shared resolver.
        // Ignoring loadAfter here once silently disabled Factions: alphabetical order put it
        // ahead of Regions-and-Territories whose assembly it binds against, so every Factions
        // type failed to resolve with only four "Could not find a type named ..." lines as
        // evidence. RimWorld obeys this file and treats loadAfter as advisory.
        const { resolved, cycles, uninstalled: missing } = resolveModLoadOrder(activeList, config);
        activeList = resolved;

        // Format activeMods XML block
        const newActiveXml = `<activeMods>\n` + activeList.map(m => `        <li>${m}</li>`).join("\n") + `\n    </activeMods>`;
        
        if (content.includes("<activeMods>")) {
            content = content.replace(/<activeMods>[\s\S]*?<\/activeMods>/, newActiveXml);
        } else {
            content = content.replace("<ModsConfigData>", `<ModsConfigData>\n    ${newActiveXml}`);
        }

        fs.writeFileSync(configPath, content, "utf8");

        // Say what was written, where, and what is wrong with it. A modlist naming a mod that is
        // not installed used to be accepted in silence: RimWorld drops the entry, the mod's own
        // "not detected" branch logs, and the run looks like evidence about that mod when it is
        // only evidence that it was never loaded. `missing` comes from the resolver above.
        const notes: string[] = [];
        notes.push(`Wrote ${configPath}`);
        if (missing.length > 0) {
            notes.push(`NOT INSTALLED (RimWorld will ignore these): ${missing.join(", ")}`);
        }
        if (cycles.length > 0) {
            notes.push(`Circular loadAfter/loadBefore among: ${cycles.join(", ")} — left in the order given.`);
        }

        return {
            isError: missing.length > 0,
            content: [{
                type: "text",
                text: [
                    missing.length > 0
                        ? `Configured ModsConfig.xml, but ${missing.length} requested mod(s) are not installed.`
                        : `Successfully configured ModsConfig.xml.`,
                    ...notes,
                    `Active mods, in load order: ${JSON.stringify(activeList)}`
                ].join("\n")
            }]
        };
    }
    
    if (name === "resolve_mod_load_order") {
        const config = loadConfig();
        let mods: string[] = Array.isArray(args.mods) ? args.mods.map((m: string) => String(m)) : [];

        // No explicit set → resolve whatever ModsConfig.xml currently has active.
        if (mods.length === 0) {
            const savedata = args.savedatafolder || config.savedatafolder || getSaveDataFolder();
            const configPath = path.join(savedata, "Config", "ModsConfig.xml");
            if (!fs.existsSync(configPath)) {
                throw new Error(`No 'mods' provided and no ModsConfig.xml at ${configPath}.`);
            }
            const content = fs.readFileSync(configPath, "utf8");
            const match = content.match(/<activeMods>([\s\S]*?)<\/activeMods>/);
            if (match) {
                for (const lm of match[1].matchAll(/<li>(.*?)<\/li>/g)) mods.push(lm[1].trim());
            }
        }

        const result = resolveModLoadOrder(mods, config);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (name === "list_installed_mods") {
        const config = loadConfig();
        let mods = scanInstalledMods(config);
        if (args.source) mods = mods.filter(m => m.source === args.source);
        return {
            content: [{
                type: "text",
                text: JSON.stringify({ count: mods.length, mods }, null, 2)
            }]
        };
    }

    if (name === "get_mod_metadata") {
        if (!args.packageId) throw new Error("get_mod_metadata requires a packageId.");
        const config = loadConfig();
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
        const config = loadConfig();
        let mods: string[] = Array.isArray(args.mods) ? args.mods.map((m: string) => String(m)) : [];
        if (mods.length === 0) {
            const savedata = args.savedatafolder || config.savedatafolder || getSaveDataFolder();
            const configPath = path.join(savedata, "Config", "ModsConfig.xml");
            if (fs.existsSync(configPath)) {
                const content = fs.readFileSync(configPath, "utf8");
                const match = content.match(/<activeMods>([\s\S]*?)<\/activeMods>/);
                if (match) for (const lm of match[1].matchAll(/<li>(.*?)<\/li>/g)) mods.push(lm[1].trim());
            }
        }
        const setLower = new Set(mods.map(m => m.toLowerCase()));
        const index = modFolderIndex(config);

        // 1. Duplicate packageIds across installed folders — RimWorld loads only the first.
        const byId = new Map<string, string[]>();
        for (const m of scanModRoots(config)) {
            if (!byId.has(m.packageId)) byId.set(m.packageId, []);
            byId.get(m.packageId)!.push(m.folder);
        }
        const duplicatePackageIds = Array.from(byId.entries())
            .filter(([, folders]) => folders.length > 1)
            .map(([packageId, folders]) => ({
                packageId,
                folders,
                note: `${folders.length} folders declare this id; RimWorld loads the first and shadows ${folders.length - 1}`
            }));

        // 2. incompatibleWith pairs where both sides are in the set.
        const incompatiblePairs: Array<{ a: string; b: string }> = [];
        const seenPair = new Set<string>();
        for (const m of mods) {
            const folder = index.get(m.toLowerCase());
            if (!folder) continue;
            const inc = (readModAbout(folder).incompatibleWith as string[]) || [];
            for (const other of inc) {
                if (!setLower.has(other.toLowerCase())) continue;
                const key = [m.toLowerCase(), other.toLowerCase()].sort().join("|");
                if (!seenPair.has(key)) { seenPair.add(key); incompatiblePairs.push({ a: m, b: other }); }
            }
        }

        // 3. Load-order cycles within the set (official block never cycles).
        const { cycles } = orderByDeclaredDependencies(
            mods.filter(m => OFFICIAL_ORDER.indexOf(m.toLowerCase()) === -1),
            index
        );

        const conflictCount = duplicatePackageIds.length + incompatiblePairs.length + (cycles.length > 0 ? 1 : 0);
        return {
            content: [{
                type: "text",
                text: JSON.stringify({ conflictCount, duplicatePackageIds, incompatiblePairs, cycles }, null, 2)
            }]
        };
    }

    throw new Error(`Unknown testing tool: ${name}`);
}
