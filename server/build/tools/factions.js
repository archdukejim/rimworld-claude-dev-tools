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
exports.factionsTools = void 0;
exports.handleFactionsTool = handleFactionsTool;
const fs = __importStar(require("fs"));
exports.factionsTools = [
    {
        name: "get_all_factions",
        description: "Returns a list of all faction names and details currently in the game.",
        inputSchema: {
            type: "object",
            properties: {}
        }
    },
    {
        name: "get_motivated_factions",
        description: "Returns a list of hostile factions along with their perceived colony strength and greed ratio (wealth vs defense). Use this to determine which faction to send in a raid.",
        inputSchema: {
            type: "object",
            properties: {}
        }
    },
    {
        name: "get_faction_relations_history",
        description: "Returns a summary of relations history and recent interactions with a specific faction.",
        inputSchema: {
            type: "object",
            properties: {
                factionName: { type: "string", description: "The name of the faction to look up." }
            },
            required: ["factionName"]
        }
    },
    {
        name: "trigger_settlement_crisis",
        description: "Triggers a localized crisis (e.g. Blight) at a random settlement of the target faction. Can be used for subterfuge.",
        inputSchema: {
            type: "object",
            properties: {
                factionName: { type: "string", description: "The name of the target faction." },
                crisisType: { type: "string", description: "The type of crisis to trigger (e.g., 'Blight')." }
            },
            required: ["factionName", "crisisType"]
        }
    },
    {
        name: "trigger_leader_backstory_generation",
        description: "Manually triggers the three-step backstory and profile generation pipeline for all faction leaders.",
        inputSchema: {
            type: "object",
            properties: {}
        }
    }
];
const toolInputPath = "d:/github/rimsynapse/Core/tool_input.json";
const toolOutputPath = "d:/github/rimsynapse/Core/tool_output.json";
async function callInGameTool(name, args) {
    const requestPayload = {
        name,
        arguments: args
    };
    // Clean old output file if it exists
    if (fs.existsSync(toolOutputPath)) {
        try {
            fs.unlinkSync(toolOutputPath);
        }
        catch (e) { }
    }
    fs.writeFileSync(toolInputPath, JSON.stringify(requestPayload, null, 2), "utf8");
    // Poll for tool_output.json for up to 10 seconds (100 iterations * 100ms)
    for (let i = 0; i < 100; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (fs.existsSync(toolOutputPath)) {
            try {
                const outputContent = fs.readFileSync(toolOutputPath, "utf8");
                // Attempt to parse JSON to ensure it is fully written
                const parsed = JSON.parse(outputContent);
                fs.unlinkSync(toolOutputPath);
                return parsed;
            }
            catch (err) {
                // If file is partially written or locked, let it poll again
            }
        }
    }
    throw new Error("Timeout waiting for in-game tool execution response. Is the game running and unpaused?");
}
async function handleFactionsTool(name, args) {
    try {
        const result = await callInGameTool(name, args);
        return {
            content: [{
                    type: "text",
                    text: JSON.stringify(result, null, 2)
                }]
        };
    }
    catch (err) {
        return {
            content: [{
                    type: "text",
                    text: JSON.stringify({ error: err.message }, null, 2)
                }],
            isError: true
        };
    }
}
