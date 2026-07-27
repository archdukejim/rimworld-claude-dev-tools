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
import { wikiTools, handleWikiTool } from "./tools/wiki";
import { factionsTools, handleFactionsTool } from "./tools/factions";
import { psychologyTools, handlePsychologyTool } from "./tools/psychology";
import { pcControlTools, handlePcControlTool } from "./tools/pcControl";
import { rimworldDevTools, handleRimworldDevTool } from "./tools/rimworldDev";
import { gameIpcTools, handleGameIpcTool } from "./tools/gameIpc";
import { loadConfig, getGitHubToken } from "./config";

// 1. Setup Config & Auth
const config = loadConfig();
const token = getGitHubToken();
const octokit = new Octokit({ auth: token });

// 2. Setup MCP Server
const server = new Server({
    name: "rimsynapse-mcp-server",
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
    ...wikiTools,
    ...factionsTools,
    ...psychologyTools,
    ...pcControlTools,
    ...rimworldDevTools,
    ...gameIpcTools
];

// 3. Register Tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: ALL_TOOLS as any };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params as any;
    
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
    
    if (wikiTools.some(t => t.name === name)) {
        return await handleWikiTool(name, args);
    }

    if (factionsTools.some(t => t.name === name)) {
        return await handleFactionsTool(name, args);
    }

    if (psychologyTools.some(t => t.name === name)) {
        return await handlePsychologyTool(name, args);
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
            const name = req.params.name;
            const args = req.body.arguments || req.body || {};
            
            try {
                let result;
                if (issueTools.some(t => t.name === name)) {
                    result = await handleIssueTool(name, args, octokit, config.organization);
                } else if (projectTools.some(t => t.name === name)) {
                    result = await handleProjectTool(name, args, token, config.defaultProjectId);
                } else if (codebaseTools.some(t => t.name === name)) {
                    result = await handleCodebaseTool(name, args, octokit, config.organization);
                } else if (testingTools.some(t => t.name === name)) {
                    result = await handleTestingTool(name, args, octokit, config.organization, token, config.defaultProjectId);
                } else if (syncTools.some(t => t.name === name)) {
                    result = await handleSyncTool(name, args, config.organization, token);
                } else if (wikiTools.some(t => t.name === name)) {
                    result = await handleWikiTool(name, args);
                } else if (factionsTools.some(t => t.name === name)) {
                    result = await handleFactionsTool(name, args);
                } else if (psychologyTools.some(t => t.name === name)) {
                    result = await handlePsychologyTool(name, args);
                } else if (pcControlTools.some(t => t.name === name)) {
                    result = await handlePcControlTool(name, args);
                } else if (rimworldDevTools.some(t => t.name === name)) {
                    result = await handleRimworldDevTool(name, args);
                } else if (gameIpcTools.some(t => t.name === name)) {
                    result = await handleGameIpcTool(name, args);
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
        console.error("RimSynapse MCP Server running on stdio");
    }
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
