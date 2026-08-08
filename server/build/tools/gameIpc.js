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
exports.gameIpcTools = void 0;
exports.requestInGameSave = requestInGameSave;
exports.requestBridgeStatus = requestBridgeStatus;
exports.requestOpenWindows = requestOpenWindows;
exports.requestGizmos = requestGizmos;
exports.handleGameIpcTool = handleGameIpcTool;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
exports.gameIpcTools = [
    {
        name: "list_game_tools",
        description: "Retrieves the directory of all active gameplay tools exposed by RimSynapse Core inside the running RimWorld instance. Can optionally filter by a search query.",
        inputSchema: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "Optional search query to filter tool names and descriptions."
                }
            }
        }
    },
    {
        name: "save_rimworld_game",
        description: "Saves the currently running RimWorld dev game to a named slot via the in-game bridge, so you can close the game and later resume this exact state with launch_rimworld's loadSave. Requires a live game (does nothing at the main menu).",
        inputSchema: {
            type: "object",
            properties: {
                name: {
                    type: "string",
                    description: "Save slot name, without extension. Defaults to 'RimAgentic_dev'."
                }
            }
        }
    },
    {
        name: "execute_game_tool",
        description: "Executes an interactive gameplay tool inside RimWorld by name, passing a JSON arguments object.",
        inputSchema: {
            type: "object",
            properties: {
                tool_name: {
                    type: "string",
                    description: "The exact name of the tool to execute."
                },
                arguments: {
                    type: "object",
                    description: "The arguments object to pass to the tool. E.g. {} if no arguments are required."
                }
            },
            required: ["tool_name"]
        }
    }
];
// Both ends of this channel must agree on the directory. The game-side mod
// (SynapseGameComponent.ScriptingDir) and this server both default to the same fixed
// location — %LOCALAPPDATA%\RimAgentic\ipc — and both honour RIMAGENTIC_IPC_DIR, so the
// bridge connects with zero configuration and no knowledge of where the mod is installed.
function ipcDir() {
    const env = process.env.RIMAGENTIC_IPC_DIR;
    if (env)
        return env;
    const local = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local");
    const dir = path.join(local, "RimAgentic", "ipc");
    try {
        fs.mkdirSync(dir, { recursive: true });
    }
    catch { /* best effort */ }
    return dir;
}
function toolInputFile() {
    return path.join(ipcDir(), "tool_input.json");
}
function toolOutputFile() {
    return path.join(ipcDir(), "tool_output.json");
}
async function callInGameTool(name, args, maxWaitMs = 10000) {
    const requestPayload = {
        name,
        arguments: args
    };
    // Clean old output file if it exists
    if (fs.existsSync(toolOutputFile())) {
        try {
            fs.unlinkSync(toolOutputFile());
        }
        catch (e) { }
    }
    fs.writeFileSync(toolInputFile(), JSON.stringify(requestPayload, null, 2), "utf8");
    // Poll for tool_output.json in 100ms steps until maxWaitMs elapses.
    const iterations = Math.max(1, Math.round(maxWaitMs / 100));
    for (let i = 0; i < iterations; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (fs.existsSync(toolOutputFile())) {
            try {
                const outputContent = fs.readFileSync(toolOutputFile(), "utf8");
                const parsed = JSON.parse(outputContent);
                fs.unlinkSync(toolOutputFile());
                return parsed;
            }
            catch (err) {
                // If file is partially written or locked, let it poll again
            }
        }
    }
    // The old message — "Is the game running and unpaused?" — was a guess, and a wrong one twice
    // over: once while the game was running fine but the request had been written to a folder the
    // game was not reading, and once while the game had already died of a native crash. Neither
    // time did checking the game state help. What actually diagnoses this is the path being
    // watched and whether the request is still sitting there unread.
    const stillPending = fs.existsSync(toolInputFile());
    const detail = stillPending
        ? `The request is still unread at ${toolInputFile()}, so nothing is polling it. ` +
            `The game polls the Core mod folder it was loaded from — check that the loaded Core is the one at this path ` +
            `(RIMSYNAPSE_ROOT overrides it), and that the game has reached a live game: the poll runs from ` +
            `GameComponentUpdate, which only ticks once a Game exists.`
        : `The request was consumed but no response appeared at ${toolOutputFile()}, so the game read it and did not answer.`;
    throw new Error(`Timeout after ${Math.round(maxWaitMs / 1000)}s waiting for an in-game tool response. ${detail}`);
}
/**
 * Fire an in-game save through the bridge and report whether it confirmed within the budget.
 * Never throws — the idle watchdog uses this as a best-effort checkpoint right before it closes
 * an unattended game, and a game sitting at the menu (nothing polling) simply times out to false.
 */
async function requestInGameSave(saveName, timeoutMs = 15000) {
    try {
        const result = await callInGameTool("save_game", { name: saveName }, timeoutMs);
        return !!result && !result.error;
    }
    catch {
        return false;
    }
}
/**
 * Probe the in-game bridge's readiness. Returns the parsed status, or null when the bridge did not
 * answer within the (short) budget — which, during launch, simply means the game hasn't reached a
 * live game yet and the caller should retry. Never throws.
 */
async function requestBridgeStatus(timeoutMs = 2000) {
    try {
        const result = await callInGameTool("get_bridge_status", {}, timeoutMs);
        if (!result || result.error)
            return null;
        return result;
    }
    catch {
        return null;
    }
}
/**
 * Read RimWorld's live window stack (types, layers, and on-screen rects) plus the UI screen dims.
 * Returns null if the bridge didn't answer (no live game). Used by capture_game_window to crop a
 * screenshot down to a single menu. Never throws.
 */
async function requestOpenWindows(timeoutMs = 4000) {
    try {
        const result = await callInGameTool("get_open_windows", {}, timeoutMs);
        if (!result || result.error || !Array.isArray(result.windows))
            return null;
        return result;
    }
    catch {
        return null;
    }
}
/**
 * Read the command buttons (gizmos) currently drawn for the selection, with their on-screen rects.
 * Returns null if the bridge didn't answer. Used by capture_gizmo to crop a screenshot to a single
 * button or the whole gizmo bar. Never throws.
 */
async function requestGizmos(timeoutMs = 4000) {
    try {
        const result = await callInGameTool("get_gizmos", {}, timeoutMs);
        if (!result || result.error || !Array.isArray(result.gizmos))
            return null;
        return result;
    }
    catch {
        return null;
    }
}
async function handleGameIpcTool(name, args) {
    if (name === "list_game_tools") {
        const query = args.query || null;
        const result = await callInGameTool("list_available_tools", { query });
        return {
            content: [{
                    type: "text",
                    text: JSON.stringify(result, null, 2)
                }]
        };
    }
    if (name === "save_rimworld_game") {
        const saveName = (args.name && String(args.name).trim()) || "RimAgentic_dev";
        const result = await callInGameTool("save_game", { name: saveName });
        return {
            content: [{
                    type: "text",
                    text: JSON.stringify(result, null, 2)
                }]
        };
    }
    if (name === "execute_game_tool") {
        const toolName = args.tool_name;
        const toolArgs = args.arguments || {};
        const result = await callInGameTool("execute_game_tool", {
            tool_name: toolName,
            arguments_json: JSON.stringify(toolArgs)
        });
        return {
            content: [{
                    type: "text",
                    text: JSON.stringify(result, null, 2)
                }]
        };
    }
    throw new Error(`Unknown game IPC tool: ${name}`);
}
