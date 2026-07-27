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
exports.psychologyTools = void 0;
exports.handlePsychologyTool = handlePsychologyTool;
const fs = __importStar(require("fs"));
exports.psychologyTools = [
    {
        name: "get_colonist_psychology_profile",
        description: "Retrieves traits, sanity breaks predictions, weighted memories, burdens, social network relationship stats (trust/familiarity), and therapy sessions history for a colonist.",
        inputSchema: {
            type: "object",
            properties: {
                pawnName: { type: "string", description: "Name of the colonist (e.g. John)" }
            },
            required: ["pawnName"]
        }
    },
    {
        name: "get_recent_social_interactions",
        description: "Retrieves a chronological list of recent social chatter logs (insults, chit-chat, deep talks) on the map.",
        inputSchema: {
            type: "object",
            properties: {
                pawnName: { type: "string", description: "Optional: Filter social interactions involving a specific colonist name" }
            }
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
async function handlePsychologyTool(name, args) {
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
