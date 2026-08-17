import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import express from "express";
import * as http from "http";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Octokit } from "@octokit/rest";
import * as fs from "fs";
import * as path from "path";

// 1. Setup GitHub Client
const tokenFilePath = path.join(__dirname, "..", "..", "github_token.txt");
let githubToken = process.env.GITHUB_TOKEN;

import { issueTools, handleIssueTool } from "./tools/issues";
import { projectTools, handleProjectTool } from "./tools/projects";
import { codebaseTools, handleCodebaseTool } from "./tools/codebase";
import { testingTools, handleTestingTool } from "./tools/testing";
import { syncTools, handleSyncTool } from "./tools/sync";
import { moddingDocsTools, handleModdingDocsTool } from "./tools/moddingDocs";
import { apiSearchTools, handleApiSearchTool } from "./tools/apiSearch";
import { perfTools, handlePerfTool } from "./tools/perf";
import { workshopImageTools, handleWorkshopImageTool } from "./tools/workshopImages";
import { showcaseTools, handleShowcaseTool } from "./tools/showcase";
import { imgurTools, handleImgurTool } from "./tools/imgur";
import { chromeCtlTools, handleChromeCtlTool } from "./tools/chromeCtl";
import { defValidateTools, handleDefValidateTool } from "./tools/defValidate";
import { defCorpusTools, handleDefCorpusTool } from "./tools/defCorpus";
import { corpusRegistryTools, handleCorpusRegistryTool } from "./tools/corpusRegistry";
import { harmonyTools, handleHarmonyTool } from "./tools/harmony";
import { pcControlTools, handlePcControlTool } from "./tools/pcControl";
import { rimworldDevTools, handleRimworldDevTool } from "./tools/rimworldDev";
import { gameIpcTools, handleGameIpcTool } from "./tools/gameIpc";
import { jobsTools, handleJobsTool } from "./tools/jobs";
import { authTools, handleAuthTool } from "./tools/auth";
import { rimsortTools, handleRimsortTool } from "./tools/rimsort";
import { noteGameActivity } from "./gameWatchdog";
import { loadConfig, getGitHubToken, requireGitHubToken } from "./config";
// Steam Workshop families (merged in from steam-workshop-helper)
import { connectBridge, Bridge } from "./bridge";
import { swhTools, handleSwhTool } from "./tools/workshop";
import { githubTools as swhGithubTools, handleGithubTool as handleSwhGithubTool } from "./tools/github";

// 1. Setup Config & Auth
const config = loadConfig();
// `let`, not `const`: set_github_token hot-swaps these so a freshly-pasted PAT takes effect
// without a server restart. Every CallTool dispatch reads the current values.
let token = getGitHubToken();
let octokit = new Octokit({ auth: token });

/** Swap the running process's GitHub token + client. Called by set_github_token after it saves a PAT. */
function applyGitHubToken(newToken: string): void {
    token = newToken;
    octokit = new Octokit({ auth: newToken });
}

// Steam loopback bridge — set in main(); the swh_* tools require it.
let bridge: Bridge | null = null;

// 2. Setup MCP Server
const server = new Server({
    name: "rimagentic",
    version: "1.0.0"
}, {
    capabilities: {
        tools: {}
    }
});

const ALL_TOOLS = [
    ...issueTools, 
    ...projectTools,
    ...codebaseTools,
    ...testingTools,
    ...syncTools,
    ...moddingDocsTools,
    ...apiSearchTools,
    ...perfTools,
    ...workshopImageTools,
    ...showcaseTools,
    ...imgurTools,
    ...chromeCtlTools,
    ...defValidateTools,
    ...defCorpusTools,
    ...corpusRegistryTools,
    ...harmonyTools,
    ...pcControlTools,
    ...rimworldDevTools,
    ...gameIpcTools,
    ...jobsTools,
    ...swhTools,
    ...swhGithubTools,
    ...authTools,
    ...rimsortTools
];

// The tools that cannot do anything without a GitHub token. The token is optional overall - the
// RimWorld and pc-control families never touch GitHub - so this is checked per call rather than at
// startup, and every other tool stays usable on a machine with no token configured.
const GITHUB_BACKED_TOOLS = new Set<string>([
    ...issueTools.map((t: any) => t.name),
    ...projectTools.map((t: any) => t.name),
    ...codebaseTools.map((t: any) => t.name),
    ...syncTools.map((t: any) => t.name),
    "create_testing_plan_issues",
]);

// 3. Register Tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: ALL_TOOLS as any };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params as any;

    // Any tool call means the agent is still driving the loop — keep the game's idle watchdog alive.
    noteGameActivity();

    if (GITHUB_BACKED_TOOLS.has(name)) {
        requireGitHubToken(token, name);
    }

    // Not GitHub-backed: this is how you INSTALL the token, so it must never require one.
    if (authTools.some(t => t.name === name)) {
        return await handleAuthTool(name, args, applyGitHubToken);
    }

    if (rimsortTools.some(t => t.name === name)) {
        return await handleRimsortTool(name, args);
    }

    if (issueTools.some(t => t.name === name)) {
        return await handleIssueTool(name, args, octokit, config.organization);
    }

    if (projectTools.some(t => t.name === name)) {
        return await handleProjectTool(name, args, token, config.defaultProjectId);
    }
    
    if (codebaseTools.some(t => t.name === name)) {
        return await handleCodebaseTool(name, args, octokit, config.organization);
    }
    
    if (testingTools.some(t => t.name === name)) {
        return await handleTestingTool(name, args, octokit, config.organization, token, config.defaultProjectId);
    }
    
    if (syncTools.some(t => t.name === name)) {
        return await handleSyncTool(name, args, config.organization, token);
    }
    
    if (moddingDocsTools.some(t => t.name === name)) {
        return await handleModdingDocsTool(name, args);
    }

    if (apiSearchTools.some(t => t.name === name)) {
        return await handleApiSearchTool(name, args);
    }

    if (perfTools.some(t => t.name === name)) {
        return await handlePerfTool(name, args);
    }

    if (workshopImageTools.some(t => t.name === name)) {
        return await handleWorkshopImageTool(name, args);
    }

    if (showcaseTools.some(t => t.name === name)) {
        return await handleShowcaseTool(name, args);
    }

    if (imgurTools.some(t => t.name === name)) {
        return await handleImgurTool(name, args);
    }

    // Chrome launcher + tab-group hygiene. Tab/group calls need the extension, so the bridge is passed
    // through; launch/status/close work with or without it.
    if (chromeCtlTools.some(t => t.name === name)) {
        return await handleChromeCtlTool(name, args, bridge);
    }

    if (defValidateTools.some(t => t.name === name)) {
        return await handleDefValidateTool(name, args);
    }

    if (defCorpusTools.some(t => t.name === name)) {
        return await handleDefCorpusTool(name, args);
    }

    if (corpusRegistryTools.some(t => t.name === name)) {
        return await handleCorpusRegistryTool(name, args);
    }

    if (harmonyTools.some(t => t.name === name)) {
        return await handleHarmonyTool(name, args);
    }

    if (pcControlTools.some(t => t.name === name)) {
        return await handlePcControlTool(name, args);
    }

    if (rimworldDevTools.some(t => t.name === name)) {
        return await handleRimworldDevTool(name, args);
    }
    
    if (gameIpcTools.some(t => t.name === name)) {
        return await handleGameIpcTool(name, args);
    }

    if (jobsTools.some(t => t.name === name)) {
        return await handleJobsTool(name, args);
    }

    // Steam Workshop GitHub issue tools (repo-map based; API direct, no bridge).
    if (swhGithubTools.some(t => t.name === name)) {
        return await handleSwhGithubTool(name, args);
    }

    // Steam Workshop actions run in the browser via the loopback bridge.
    if (swhTools.some(t => t.name === name)) {
        if (!bridge) throw new Error("Steam loopback bridge not started yet.");
        return await handleSwhTool(name, args, bridge);
    }

    throw new Error(`Unknown tool: ${name}`);
});

// 4. Start Server
async function main() {
    // Connect the Steam Workshop loopback bridge (127.0.0.1): bind as owner, or
    // — when a peer MCP session already owns the port — relay through it as a
    // proxy, so every concurrent session's swh_*/tab tools share one queue.
    // Best-effort: on genuine failure the RimWorld/GitHub tools still work.
    try {
        bridge = await connectBridge(config);
    } catch (err) {
        console.error("[rwdt] Steam bridge failed to start (swh_* tools disabled):", err instanceof Error ? err.message : err);
    }

    const isSse = process.argv.includes("--sse");
    if (isSse) {
        let port = 3000;
        const portIndex = process.argv.indexOf("--port");
        if (portIndex !== -1) {
            if (portIndex + 1 < process.argv.length) {
                port = parseInt(process.argv[portIndex + 1], 10);
            }
        }
        
        const app = createMcpExpressApp();
        
        // Log incoming requests (method and IP)
        app.use((req: any, res: any, next: any) => {
            const rawIp = req.ip || req.socket.remoteAddress || "127.0.0.1";
            const cleanIp = rawIp.replace("::ffff:", "").replace("::1", "127.0.0.1");
            console.error("received " + req.method.toLowerCase() + " from " + cleanIp);
            next();
        });

        const transports: Record<string, SSEServerTransport> = {};
        
        // Helper to notify manager of activity without using ampersands
        const notifyActivity = () => {
            const payload = JSON.stringify({ timestamp: Date.now() });
            const postReq = http.request({
                hostname: "localhost",
                port: 4001,
                path: "/api/manager/activity",
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(payload)
                }
            }, () => {});
            
            postReq.on("error", () => {});
            postReq.write(payload);
            postReq.end();
        };

        // Establish SSE connection
        app.get("/sse", async (req: any, res: any) => {
            notifyActivity();
            try {
                const transport = new SSEServerTransport("/messages", res);
                const sessionId = transport.sessionId;
                transports[sessionId] = transport;
                
                transport.onclose = () => {
                    delete transports[sessionId];
                };
                
                await server.connect(transport);
            } catch (err: any) {
                console.error("SSE connection error:", err);
                if (!res.headersSent) {
                    res.status(500).send("Error establishing SSE stream");
                }
            }
        });

        // Receive client messages (POST)
        app.post("/messages", async (req: any, res: any) => {
            notifyActivity();
            const sessionId = req.query.sessionId as string;
            if (!sessionId) {
                res.status(400).send("Missing sessionId parameter");
                return;
            }
            
            const transport = transports[sessionId];
            if (!transport) {
                res.status(404).send("Session not found");
                return;
            }
            
            try {
                await transport.handlePostMessage(req, res, req.body);
            } catch (err: any) {
                console.error("Error handling POST message:", err);
                if (!res.headersSent) {
                    res.status(500).send(err.message);
                }
            }
        });

        // Expose HTTP endpoints
        app.get("/api/tools", (req: any, res: any) => {
            notifyActivity();
            res.json({ tools: ALL_TOOLS });
        });

        app.post("/api/tools/:name", async (req: any, res: any) => {
            notifyActivity();
            noteGameActivity();
            const name = req.params.name;
            const args = req.body.arguments || req.body || {};

            try {
                if (GITHUB_BACKED_TOOLS.has(name)) {
                    requireGitHubToken(token, name);
                }

                let result;
                if (authTools.some(t => t.name === name)) {
                    result = await handleAuthTool(name, args, applyGitHubToken);
                } else if (rimsortTools.some(t => t.name === name)) {
                    result = await handleRimsortTool(name, args);
                } else if (issueTools.some(t => t.name === name)) {
                    result = await handleIssueTool(name, args, octokit, config.organization);
                } else if (projectTools.some(t => t.name === name)) {
                    result = await handleProjectTool(name, args, token, config.defaultProjectId);
                } else if (codebaseTools.some(t => t.name === name)) {
                    result = await handleCodebaseTool(name, args, octokit, config.organization);
                } else if (testingTools.some(t => t.name === name)) {
                    result = await handleTestingTool(name, args, octokit, config.organization, token, config.defaultProjectId);
                } else if (syncTools.some(t => t.name === name)) {
                    result = await handleSyncTool(name, args, config.organization, token);
                } else if (moddingDocsTools.some(t => t.name === name)) {
                    result = await handleModdingDocsTool(name, args);
                } else if (apiSearchTools.some(t => t.name === name)) {
                    result = await handleApiSearchTool(name, args);
                } else if (perfTools.some(t => t.name === name)) {
                    result = await handlePerfTool(name, args);
                } else if (workshopImageTools.some(t => t.name === name)) {
                    result = await handleWorkshopImageTool(name, args);
                } else if (showcaseTools.some(t => t.name === name)) {
                    result = await handleShowcaseTool(name, args);
                } else if (imgurTools.some(t => t.name === name)) {
                    result = await handleImgurTool(name, args);
                } else if (chromeCtlTools.some(t => t.name === name)) {
                    result = await handleChromeCtlTool(name, args, bridge);
                } else if (defValidateTools.some(t => t.name === name)) {
                    result = await handleDefValidateTool(name, args);
                } else if (defCorpusTools.some(t => t.name === name)) {
                    result = await handleDefCorpusTool(name, args);
                } else if (corpusRegistryTools.some(t => t.name === name)) {
                    result = await handleCorpusRegistryTool(name, args);
                } else if (harmonyTools.some(t => t.name === name)) {
                    result = await handleHarmonyTool(name, args);
                } else if (pcControlTools.some(t => t.name === name)) {
                    result = await handlePcControlTool(name, args);
                } else if (rimworldDevTools.some(t => t.name === name)) {
                    result = await handleRimworldDevTool(name, args);
                } else if (gameIpcTools.some(t => t.name === name)) {
                    result = await handleGameIpcTool(name, args);
                } else if (jobsTools.some(t => t.name === name)) {
                    result = await handleJobsTool(name, args);
                } else if (swhGithubTools.some(t => t.name === name)) {
                    result = await handleSwhGithubTool(name, args);
                } else if (swhTools.some(t => t.name === name)) {
                    if (!bridge) throw new Error("Steam loopback bridge not started yet.");
                    result = await handleSwhTool(name, args, bridge);
                } else {
                    res.status(404).json({ error: "Unknown tool: " + name });
                    return;
                }
                
                res.json(result);
            } catch (err: any) {
                res.status(500).json({ error: err.message });
            }
        });

        app.listen(port, () => {
            console.error("RimSynapse MCP Server (SSE/HTTP Mode) running on port " + port);
        });
    } else {
        const transport = new StdioServerTransport();
        await server.connect(transport);
        console.error("RimWorld Claude Dev Tools MCP running on stdio");
    }
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
