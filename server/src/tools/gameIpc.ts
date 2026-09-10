import * as fs from "fs";
import * as path from "path";
import { withIpcLock } from "../ipcLock";

export const gameIpcTools = [
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

// Both ends of this channel must resolve the same physical directory, or every bridge call
// writes its request where nothing is polling and dies at the 10s timeout.
//
// The canonical dev bridge is the generic toolkit game mod (RimAgentic): its
// SynapseGameComponent.ScriptingDir defaults to %LOCALAPPDATA%\RimAgentic\ipc and honours
// RIMAGENTIC_IPC_DIR. This server matches exactly, so the bridge connects with ZERO configuration
// for any modlist that includes the toolkit mod — which force-loads last, so its reflection scan
// (and run_debug_action) sees every other mod. RIMAGENTIC_IPC_DIR overrides both ends together.
//
// (RimSynapse's Core carries a separate, forked bridge that polls <RIMSYNAPSE_ROOT>/Core instead;
// that is Core's own channel, not this generic one. Point RIMAGENTIC_IPC_DIR at it only if you
// deliberately want to drive Core's bridge rather than the toolkit mod's.)
function ipcDir(): string {
    const env = process.env.RIMAGENTIC_IPC_DIR;
    if (env) {
        try { fs.mkdirSync(env, { recursive: true }); } catch { /* best effort */ }
        return env;
    }
    const local = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local");
    const dir = path.join(local, "RimAgentic", "ipc");
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
    return dir;
}

function toolInputFile(): string {
    return path.join(ipcDir(), "tool_input.json");
}

function toolOutputFile(): string {
    return path.join(ipcDir(), "tool_output.json");
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// Tools whose whole point is to change what window is on screen. After one runs, the freshly
// changed window is worth reading back so its contents ride along in the receipt.
const WINDOW_AFFECTING_TOOLS = new Set(["open_window", "activate_gizmo", "invoke_window_control"]);

/**
 * Best-effort follow-up read after a window-affecting command: settle a few frames so the new/
 * changed window draws at least once (the capture layer is per-frame), then read its contents.
 * Returns the read_window payload to attach, or undefined when it doesn't apply. Never throws — a
 * hiccup in the convenience read must not fail the primary command.
 */
async function maybeAttachWindow(toolName: string, toolArgs: any, result: any): Promise<any> {
    if (!WINDOW_AFFECTING_TOOLS.has(toolName)) return undefined;
    if (!result || result.error) return undefined;
    // Target the just-opened window precisely when the tool reported its type; else let read_window
    // pick the topmost real dialog.
    let windowType: string | undefined;
    if (toolName === "open_window" && typeof result.opened === "string") windowType = result.opened;
    else if (toolArgs && typeof toolArgs.windowType === "string") windowType = toolArgs.windowType;
    try {
        await sleep(250); // ~15 frames at 60fps: the new window has drawn and been captured
        return await callInGameTool("read_window", windowType ? { windowType } : {}, 6000);
    } catch {
        return undefined;
    }
}

async function callInGameTool(name: string, args: any, maxWaitMs = 10000): Promise<any> {
    // Serialize every raw round-trip on the shared, fixed-filename channel so
    // concurrent sessions (and un-lease-gated peeks like capture_*) can't clobber
    // each other's request/response. See ipcLock.ts. Cheap when uncontended; the
    // session-level FIFO lease (gameLease.ts) is the coarser, fairer layer above.
    return await withIpcLock(
        ipcDir(),
        name,
        () => callInGameToolUnlocked(name, args, maxWaitMs),
        // Stale-break: a dead/wedged holder may have left a half-written response
        // that positional (id-less) correlation would misread as ours. Scrub it.
        () => { try { fs.unlinkSync(toolOutputFile()); } catch { /* nothing to scrub */ } }
    );
}

async function callInGameToolUnlocked(name: string, args: any, maxWaitMs: number): Promise<any> {
    const requestPayload = {
        name,
        arguments: args
    };

    // Clean old output file if it exists
    if (fs.existsSync(toolOutputFile())) {
        try { fs.unlinkSync(toolOutputFile()); } catch (e) {}
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
            } catch (err: any) {
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
export async function requestInGameSave(saveName: string, timeoutMs = 15000): Promise<boolean> {
    try {
        const result = await callInGameTool("save_game", { name: saveName }, timeoutMs);
        return !!result && !result.error;
    } catch {
        return false;
    }
}

export interface BridgeStatus {
    programState: string;
    mapLive: boolean;
    mapSize?: { x: number; z: number } | null;
    ticksGame?: number;
    hourOfDay?: number;
    colonistCount?: number;
}

/**
 * Probe the in-game bridge's readiness. Returns the parsed status, or null when the bridge did not
 * answer within the (short) budget — which, during launch, simply means the game hasn't reached a
 * live game yet and the caller should retry. Never throws.
 */
export async function requestBridgeStatus(timeoutMs = 2000): Promise<BridgeStatus | null> {
    try {
        const result = await callInGameTool("get_bridge_status", {}, timeoutMs);
        if (!result || result.error) return null;
        return result as BridgeStatus;
    } catch {
        return null;
    }
}

export interface OpenWindow {
    type: string;
    fullType: string;
    id: number;
    layer: string;
    rect: { x: number; y: number; width: number; height: number };
}
export interface OpenWindows {
    count: number;
    screen?: { width: number; height: number };
    windows: OpenWindow[];
}

/**
 * Read RimWorld's live window stack (types, layers, and on-screen rects) plus the UI screen dims.
 * Returns null if the bridge didn't answer (no live game). Used by capture_game_window to crop a
 * screenshot down to a single menu. Never throws.
 */
export async function requestOpenWindows(timeoutMs = 4000): Promise<OpenWindows | null> {
    try {
        const result = await callInGameTool("get_open_windows", {}, timeoutMs);
        if (!result || result.error || !Array.isArray(result.windows)) return null;
        return result as OpenWindows;
    } catch {
        return null;
    }
}

export interface GizmoRect { label: string; x: number; y: number; width: number; height: number; }
export interface Gizmos {
    count: number;
    screen?: { width: number; height: number };
    bounds?: { x: number; y: number; width: number; height: number } | null;
    gizmos: GizmoRect[];
    note?: string | null;
}

/**
 * Read the command buttons (gizmos) currently drawn for the selection, with their on-screen rects.
 * Returns null if the bridge didn't answer. Used by capture_gizmo to crop a screenshot to a single
 * button or the whole gizmo bar. Never throws.
 */
export async function requestGizmos(timeoutMs = 4000): Promise<Gizmos | null> {
    try {
        const result = await callInGameTool("get_gizmos", {}, timeoutMs);
        if (!result || result.error || !Array.isArray(result.gizmos)) return null;
        return result as Gizmos;
    } catch {
        return null;
    }
}

export interface BarEntry { label: string; x: number; y: number; width: number; height: number; }
export interface ColonistBar {
    count: number;
    screen?: { width: number; height: number };
    bounds?: { x: number; y: number; width: number; height: number } | null;
    entries: BarEntry[];
    note?: string | null;
}

/**
 * Read the colonist-bar portraits currently drawn at the top of the screen, with their rects.
 * Returns null if the bridge didn't answer. Used by capture_colonist_bar. Never throws.
 */
export async function requestColonistBar(timeoutMs = 4000): Promise<ColonistBar | null> {
    try {
        const result = await callInGameTool("get_colonist_bar", {}, timeoutMs);
        if (!result || result.error || !Array.isArray(result.entries)) return null;
        return result as ColonistBar;
    } catch {
        return null;
    }
}

export interface ToggleEntry { label: string; on: boolean; x: number; y: number; width: number; height: number; }
export interface PlaySettings {
    count: number;
    screen?: { width: number; height: number };
    bounds?: { x: number; y: number; width: number; height: number } | null;
    toggles: ToggleEntry[];
    note?: string | null;
}

/**
 * Read the bottom-right play-settings / map-overlay toggle buttons, with rects + on/off state.
 * Returns null if the bridge didn't answer. Used by capture_play_settings. Never throws.
 */
export async function requestPlaySettings(timeoutMs = 4000): Promise<PlaySettings | null> {
    try {
        const result = await callInGameTool("get_play_settings", {}, timeoutMs);
        if (!result || result.error || !Array.isArray(result.toggles)) return null;
        return result as PlaySettings;
    } catch {
        return null;
    }
}

export async function handleGameIpcTool(name: string, args: any) {
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

        // Self-describing UI: after a command that changes the window stack, settle a couple of
        // frames and attach the resulting window's contents (buttons/labels/checkboxes) to the same
        // receipt — so the caller sees what it can act on without a separate "read the screen" call.
        // This collapses "open -> inspect -> locate -> click" into "command (receipt = state) ->
        // follow-up command". Gated to window-affecting tools so ordinary calls pay nothing.
        const attached = await maybeAttachWindow(toolName, toolArgs, result);
        const payload = attached !== undefined ? { result, window: attached } : result;
        return {
            content: [{
                type: "text",
                text: JSON.stringify(payload, null, 2)
            }]
        };
    }
    
    throw new Error(`Unknown game IPC tool: ${name}`);
}
