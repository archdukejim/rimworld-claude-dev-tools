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
const index_js_1 = require("@modelcontextprotocol/sdk/server/index.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const sse_js_1 = require("@modelcontextprotocol/sdk/server/sse.js");
const express_js_1 = require("@modelcontextprotocol/sdk/server/express.js");
const http = __importStar(require("http"));
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const rest_1 = require("@octokit/rest");
const path = __importStar(require("path"));
// 1. Setup GitHub Client
const tokenFilePath = path.join(__dirname, "..", "..", "github_token.txt");
let githubToken = process.env.GITHUB_TOKEN;
const issues_1 = require("./tools/issues");
const projects_1 = require("./tools/projects");
const codebase_1 = require("./tools/codebase");
const testing_1 = require("./tools/testing");
const sync_1 = require("./tools/sync");
const wiki_1 = require("./tools/wiki");
const factions_1 = require("./tools/factions");
const psychology_1 = require("./tools/psychology");
const pcControl_1 = require("./tools/pcControl");
const rimworldDev_1 = require("./tools/rimworldDev");
const gameIpc_1 = require("./tools/gameIpc");
const config_1 = require("./config");
// 1. Setup Config & Auth
const config = (0, config_1.loadConfig)();
const token = (0, config_1.getGitHubToken)();
const octokit = new rest_1.Octokit({ auth: token });
// 2. Setup MCP Server
const server = new index_js_1.Server({
    name: "rimsynapse-mcp-server",
    version: "1.0.0"
}, {
    capabilities: {
        tools: {}
    }
});
const ALL_TOOLS = [
    ...issues_1.issueTools,
    ...projects_1.projectTools,
    ...codebase_1.codebaseTools,
    ...testing_1.testingTools,
    ...sync_1.syncTools,
    ...wiki_1.wikiTools,
    ...factions_1.factionsTools,
    ...psychology_1.psychologyTools,
    ...pcControl_1.pcControlTools,
    ...rimworldDev_1.rimworldDevTools,
    ...gameIpc_1.gameIpcTools
];
// 3. Register Tools
server.setRequestHandler(types_js_1.ListToolsRequestSchema, async () => {
    return { tools: ALL_TOOLS };
});
server.setRequestHandler(types_js_1.CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (issues_1.issueTools.some(t => t.name === name)) {
        return await (0, issues_1.handleIssueTool)(name, args, octokit, config.organization);
    }
    if (projects_1.projectTools.some(t => t.name === name)) {
        return await (0, projects_1.handleProjectTool)(name, args, token, config.defaultProjectId);
    }
    if (codebase_1.codebaseTools.some(t => t.name === name)) {
        return await (0, codebase_1.handleCodebaseTool)(name, args, octokit, config.organization);
    }
    if (testing_1.testingTools.some(t => t.name === name)) {
        return await (0, testing_1.handleTestingTool)(name, args, octokit, config.organization, token, config.defaultProjectId);
    }
    if (sync_1.syncTools.some(t => t.name === name)) {
        return await (0, sync_1.handleSyncTool)(name, args, config.organization, token);
    }
    if (wiki_1.wikiTools.some(t => t.name === name)) {
        return await (0, wiki_1.handleWikiTool)(name, args);
    }
    if (factions_1.factionsTools.some(t => t.name === name)) {
        return await (0, factions_1.handleFactionsTool)(name, args);
    }
    if (psychology_1.psychologyTools.some(t => t.name === name)) {
        return await (0, psychology_1.handlePsychologyTool)(name, args);
    }
    if (pcControl_1.pcControlTools.some(t => t.name === name)) {
        return await (0, pcControl_1.handlePcControlTool)(name, args);
    }
    if (rimworldDev_1.rimworldDevTools.some(t => t.name === name)) {
        return await (0, rimworldDev_1.handleRimworldDevTool)(name, args);
    }
    if (gameIpc_1.gameIpcTools.some(t => t.name === name)) {
        return await (0, gameIpc_1.handleGameIpcTool)(name, args);
    }
    throw new Error(`Unknown tool: ${name}`);
});
// 4. Start Server
async function main() {
    const isSse = process.argv.includes("--sse");
    if (isSse) {
        let port = 3000;
        const portIndex = process.argv.indexOf("--port");
        if (portIndex !== -1) {
            if (portIndex + 1 < process.argv.length) {
                port = parseInt(process.argv[portIndex + 1], 10);
            }
        }
        const app = (0, express_js_1.createMcpExpressApp)();
        // Log incoming requests (method and IP)
        app.use((req, res, next) => {
            const rawIp = req.ip || req.socket.remoteAddress || "127.0.0.1";
            const cleanIp = rawIp.replace("::ffff:", "").replace("::1", "127.0.0.1");
            console.error("received " + req.method.toLowerCase() + " from " + cleanIp);
            next();
        });
        const transports = {};
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
            }, () => { });
            postReq.on("error", () => { });
            postReq.write(payload);
            postReq.end();
        };
        // Establish SSE connection
        app.get("/sse", async (req, res) => {
            notifyActivity();
            try {
                const transport = new sse_js_1.SSEServerTransport("/messages", res);
                const sessionId = transport.sessionId;
                transports[sessionId] = transport;
                transport.onclose = () => {
                    delete transports[sessionId];
                };
                await server.connect(transport);
            }
            catch (err) {
                console.error("SSE connection error:", err);
                if (!res.headersSent) {
                    res.status(500).send("Error establishing SSE stream");
                }
            }
        });
        // Receive client messages (POST)
        app.post("/messages", async (req, res) => {
            notifyActivity();
            const sessionId = req.query.sessionId;
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
            }
            catch (err) {
                console.error("Error handling POST message:", err);
                if (!res.headersSent) {
                    res.status(500).send(err.message);
                }
            }
        });
        // Expose HTTP endpoints
        app.get("/api/tools", (req, res) => {
            notifyActivity();
            res.json({ tools: ALL_TOOLS });
        });
        app.post("/api/tools/:name", async (req, res) => {
            notifyActivity();
            const name = req.params.name;
            const args = req.body.arguments || req.body || {};
            try {
                let result;
                if (issues_1.issueTools.some(t => t.name === name)) {
                    result = await (0, issues_1.handleIssueTool)(name, args, octokit, config.organization);
                }
                else if (projects_1.projectTools.some(t => t.name === name)) {
                    result = await (0, projects_1.handleProjectTool)(name, args, token, config.defaultProjectId);
                }
                else if (codebase_1.codebaseTools.some(t => t.name === name)) {
                    result = await (0, codebase_1.handleCodebaseTool)(name, args, octokit, config.organization);
                }
                else if (testing_1.testingTools.some(t => t.name === name)) {
                    result = await (0, testing_1.handleTestingTool)(name, args, octokit, config.organization, token, config.defaultProjectId);
                }
                else if (sync_1.syncTools.some(t => t.name === name)) {
                    result = await (0, sync_1.handleSyncTool)(name, args, config.organization, token);
                }
                else if (wiki_1.wikiTools.some(t => t.name === name)) {
                    result = await (0, wiki_1.handleWikiTool)(name, args);
                }
                else if (factions_1.factionsTools.some(t => t.name === name)) {
                    result = await (0, factions_1.handleFactionsTool)(name, args);
                }
                else if (psychology_1.psychologyTools.some(t => t.name === name)) {
                    result = await (0, psychology_1.handlePsychologyTool)(name, args);
                }
                else if (pcControl_1.pcControlTools.some(t => t.name === name)) {
                    result = await (0, pcControl_1.handlePcControlTool)(name, args);
                }
                else if (rimworldDev_1.rimworldDevTools.some(t => t.name === name)) {
                    result = await (0, rimworldDev_1.handleRimworldDevTool)(name, args);
                }
                else if (gameIpc_1.gameIpcTools.some(t => t.name === name)) {
                    result = await (0, gameIpc_1.handleGameIpcTool)(name, args);
                }
                else {
                    res.status(404).json({ error: "Unknown tool: " + name });
                    return;
                }
                res.json(result);
            }
            catch (err) {
                res.status(500).json({ error: err.message });
            }
        });
        app.listen(port, () => {
            console.error("RimSynapse MCP Server (SSE/HTTP Mode) running on port " + port);
        });
    }
    else {
        const transport = new stdio_js_1.StdioServerTransport();
        await server.connect(transport);
        console.error("RimSynapse MCP Server running on stdio");
    }
}
main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
