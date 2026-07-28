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
exports.handleTestingTool = handleTestingTool;
const fs = __importStar(require("fs"));
const graphql_1 = require("@octokit/graphql");
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const config_1 = require("../config");
/**
 * Every folder RimWorld will look in for mods, and the packageId each one declares.
 *
 * Covers the local Mods directory and the Steam Workshop content directory, because a modlist
 * routinely mixes both — Empire and VOE come from the Workshop while the RimSynapse mods are
 * local. A packageId present in neither is not installed, which is worth saying out loud rather
 * than writing into the config and letting RimWorld drop it silently.
 */
function modFolderIndex(config) {
    const index = new Map();
    const modsDir = config.rimworldModsDir || "";
    const workshopDir = modsDir
        ? path.resolve(modsDir, "..", "..", "..", "workshop", "content", "294100")
        : "";
    // The base game and the official DLCs are packageIds too (ludeon.rimworld,
    // ludeon.rimworld.royalty, ...) and they live in Data/, not Mods/. Scanning it beats
    // hardcoding an allowlist, which would need editing every time Ludeon ships an expansion.
    const dataDir = modsDir ? path.resolve(modsDir, "..", "Data") : "";
    for (const root of [modsDir, workshopDir, dataDir]) {
        if (!root || !fs.existsSync(root))
            continue;
        let entries = [];
        try {
            entries = fs.readdirSync(root);
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            const aboutPath = path.join(root, entry, "About", "About.xml");
            if (!fs.existsSync(aboutPath))
                continue;
            try {
                const xml = fs.readFileSync(aboutPath, "utf8");
                const id = /<packageId>([^<]+)<\/packageId>/i.exec(xml)?.[1]?.trim().toLowerCase();
                // First wins: the local copy is scanned before the Workshop one, matching the
                // intent that local overrides published.
                if (id && !index.has(id))
                    index.set(id, path.join(root, entry));
            }
            catch { /* an unreadable About.xml is simply not an index entry */ }
        }
    }
    return index;
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
        // Standardize list (keep duplicates out)
        activeList = Array.from(new Set(activeList.map(m => m.trim())));
        // Sort active mods list to respect official RimWorld load order:
        // 1. Harmony
        // 2. Core (ludeon.rimworld)
        // 3. Official DLCs (ludeon.rimworld.royalty, ludeon.rimworld.ideology, etc.)
        // 4. Other mods, ordered by the loadAfter/loadBefore they declare
        const officialOrder = [
            "brrainz.harmony",
            "ludeon.rimworld",
            "ludeon.rimworld.royalty",
            "ludeon.rimworld.ideology",
            "ludeon.rimworld.biotech",
            "ludeon.rimworld.anomaly",
            "ludeon.rimworld.odyssey"
        ];
        // Everything past the official block used to fall through to a.localeCompare(b), which
        // is alphabetical and knows nothing about dependencies. That put rimsynapse.factions
        // ahead of rimsynapse.regionsandterritories, and since 0.7 Factions binds against R&T's
        // assembly: every Factions type failed to resolve, its patches never bound, and the only
        // evidence was four "Could not find a type named ..." lines. RimWorld obeys this file and
        // treats loadAfter as advisory, so a modlist writer that ignores loadAfter is a modlist
        // writer that can silently disable a mod.
        const { order: sortedTail, cycles } = orderByDeclaredDependencies(activeList.filter(m => officialOrder.indexOf(m.toLowerCase()) === -1), modFolderIndex(config));
        activeList = [
            ...activeList
                .filter(m => officialOrder.indexOf(m.toLowerCase()) !== -1)
                .sort((a, b) => officialOrder.indexOf(a.toLowerCase()) - officialOrder.indexOf(b.toLowerCase())),
            ...sortedTail
        ];
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
        // only evidence that it was never loaded.
        const installed = modFolderIndex(config);
        const missing = activeList.filter(m => !installed.has(m.toLowerCase()));
        const notes = [];
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
    throw new Error(`Unknown testing tool: ${name}`);
}
