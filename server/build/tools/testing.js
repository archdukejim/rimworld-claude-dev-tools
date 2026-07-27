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
        const savedata = args.savedatafolder || config.savedatafolder || "D:\\RimWorldDevData";
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
        const savedata = args.savedatafolder || config.savedatafolder || "D:\\RimWorldDevData";
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
        // 4. Other mods (e.g. rimsynapse.core, rimsynapse.nvidiatool)
        const officialOrder = [
            "brrainz.harmony",
            "ludeon.rimworld",
            "ludeon.rimworld.royalty",
            "ludeon.rimworld.ideology",
            "ludeon.rimworld.biotech",
            "ludeon.rimworld.anomaly",
            "ludeon.rimworld.odyssey"
        ];
        activeList.sort((a, b) => {
            const idxA = officialOrder.indexOf(a.toLowerCase());
            const idxB = officialOrder.indexOf(b.toLowerCase());
            if (idxA !== -1 && idxB !== -1) {
                return idxA - idxB;
            }
            if (idxA !== -1)
                return -1;
            if (idxB !== -1)
                return 1;
            return a.localeCompare(b);
        });
        // Format activeMods XML block
        const newActiveXml = `<activeMods>\n` + activeList.map(m => `        <li>${m}</li>`).join("\n") + `\n    </activeMods>`;
        if (content.includes("<activeMods>")) {
            content = content.replace(/<activeMods>[\s\S]*?<\/activeMods>/, newActiveXml);
        }
        else {
            content = content.replace("<ModsConfigData>", `<ModsConfigData>\n    ${newActiveXml}`);
        }
        fs.writeFileSync(configPath, content, "utf8");
        return {
            content: [{
                    type: "text",
                    text: `Successfully configured ModsConfig.xml. Active mods: ${JSON.stringify(activeList)}.`
                }]
        };
    }
    throw new Error(`Unknown testing tool: ${name}`);
}
