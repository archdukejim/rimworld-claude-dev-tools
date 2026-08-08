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
exports.pcControlTools = void 0;
exports.handlePcControlTool = handlePcControlTool;
const child_process_1 = require("child_process");
const types_1 = require("./pc/types");
const mouse_1 = require("./pc/mouse");
const keyboard_1 = require("./pc/keyboard");
const screen_1 = require("./pc/screen");
const clipboard_1 = require("./pc/clipboard");
const uiAutomation_1 = require("./pc/uiAutomation");
const rimworldDev_1 = require("./rimworldDev");
const gameWatchdog_1 = require("../gameWatchdog");
const gameIpc_1 = require("./gameIpc");
const native_1 = require("./pc/native");
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const crypto_1 = require("crypto");
/**
 * Bring a process's main window to the foreground before a screen grab, and block through a short
 * settle so the desktop switch completes. RimWorld is moved to a SEPARATE virtual desktop at launch,
 * so a plain capture grabs whichever desktop is currently visible (usually the Claude window). This
 * switches Windows to the game's desktop and makes it the visible surface. PrintWindow can't replace
 * this — it returns black for Unity/DirectX. Best-effort; returns a short status token for the log.
 *
 * The script is written to a temp .ps1 and run with -File rather than -Command, so the Add-Type
 * here-string (with its embedded quotes) needs no shell-escaping.
 */
function foregroundGameWindow(imageName = "RimWorldWin64") {
    const safeName = imageName.replace(/[^A-Za-z0-9_]/g, ""); // only ever an image name; keep it inert
    const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Fg {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
}
"@
$p = Get-Process -Name ${safeName} -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($p) {
  [Fg]::ShowWindow($p.MainWindowHandle, 9) | Out-Null   # SW_RESTORE
  [Fg]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
  Start-Sleep -Milliseconds 700
  "focused"
} else { "notfound" }
`;
    const scriptPath = path.join(os.tmpdir(), `rwdt_focus_${(0, crypto_1.randomBytes)(6).toString("hex")}.ps1`);
    try {
        fs.writeFileSync(scriptPath, script, "utf8");
        const out = (0, child_process_1.execSync)(`powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`, { encoding: "utf8", timeout: 8000 });
        return String(out).trim() || "unknown";
    }
    catch (e) {
        return `error:${e?.message ?? e}`;
    }
    finally {
        try {
            fs.unlinkSync(scriptPath);
        }
        catch { /* best effort */ }
    }
}
/** Turn foregroundGameWindow's status token into a human note for the tool result. */
function describeFocus(token) {
    if (token === "focused")
        return "(RimWorld foregrounded)";
    if (token === "notfound")
        return "(focusGame requested but no RimWorld window found — is the game running?)";
    return `(focus attempt: ${token})`;
}
/**
 * Foreground RimWorld, capture the full screen, then crop to a UI-space rect — the shared body of
 * capture_game_window and capture_gizmo. Scales the rect from UI pixels to image pixels via the
 * game-reported screen dims (so it's correct at any UI Scale) and clamps to the image bounds.
 */
async function captureAndCrop(rect, uiW, uiH, opts) {
    const focusToken = foregroundGameWindow();
    const fullPath = await (0, screen_1.captureScreen)(opts.format, opts.quality);
    const meta = await (0, native_1.sharp)()(fullPath).metadata();
    const imgW = meta.width || 0, imgH = meta.height || 0;
    const sx = uiW ? imgW / uiW : 1, sy = uiH ? imgH / uiH : 1;
    const p = Math.max(0, Math.round(Number(opts.pad) || 0));
    let left = Math.round(rect.x * sx) - p;
    let top = Math.round(rect.y * sy) - p;
    let cropW = Math.round(rect.width * sx) + 2 * p;
    let cropH = Math.round(rect.height * sy) + 2 * p;
    left = Math.max(0, Math.min(left, Math.max(0, imgW - 1)));
    top = Math.max(0, Math.min(top, Math.max(0, imgH - 1)));
    cropW = Math.max(1, Math.min(cropW, imgW - left));
    cropH = Math.max(1, Math.min(cropH, imgH - top));
    const ext = opts.format === types_1.CaptureFormat.JPEG ? "jpeg" : "png";
    const outPath = path.resolve(`${opts.outName || "window_crop"}.${ext}`);
    let pipeline = (0, native_1.sharp)()(fullPath).extract({ left, top, width: cropW, height: cropH });
    if (opts.format === types_1.CaptureFormat.JPEG) {
        pipeline = pipeline.jpeg({ quality: Math.max(1, Math.min(100, opts.quality || 80)) });
    }
    await pipeline.toFile(outPath);
    return { outPath, left, top, cropW, cropH, fullPath, focusToken };
}
const keyValues = Object.values(types_1.Key);
const formatValues = Object.values(types_1.CaptureFormat);
const mouseButtonValues = Object.values(types_1.MouseButton);
const scrollDirectionValues = Object.values(types_1.ScrollDirection);
exports.pcControlTools = [
    {
        name: "launch_quicktest",
        description: "Launches RimWorld with -quicktest to generate a test map instantly, booting from the CONFIGURED dev savedatafolder so it loads the modlist configure_active_mods set (not the player's default LocalLow config). Thin wrapper over launch_rimworld with quicktest enabled.",
        inputSchema: {
            type: "object",
            properties: {
                killExisting: { type: "boolean", description: "Whether to force close any already running instances of RimWorld first (default: true)" },
                bare: { type: "boolean", description: "Escape hatch: minimal spawn that opens the game with the player's DEFAULT LocalLow config — no -savedatafolder pinning, dev-mode/Prefs, Workshop mirroring, or desktop move. Use to poke the game open as-is, not to test a configured modlist. Default: false (guarded launch)." },
                savedatafolder: { type: "string", description: "Optional override for -savedatafolder (ignored when bare). Defaults to the configured dev save folder — the same one configure_active_mods writes." },
                developer: { type: "boolean", description: "Force developer mode enabled (default: true)." },
                nosound: { type: "boolean", description: "Mute game audio via -nosound (default: true)." },
                idleTimeoutMin: { type: "number", description: "Minutes with no MCP tool call before the idle watchdog closes the game, so it never runs unattended overnight. 0 disables it. Default: RIMAGENTIC_GAME_IDLE_TIMEOUT_MIN (30)." }
            }
        }
    },
    {
        name: "capture_screen",
        description: "Capture the entire screen to an image file and return its path (read it with the Read tool). Pass focusGame:true to grab RimWorld even after the launcher moves it to a separate virtual desktop — it foregrounds the game window first so the capture lands on the game rather than whatever desktop is visible.",
        inputSchema: {
            type: "object",
            properties: {
                format: { type: "string", enum: formatValues, description: "Image format (png or jpeg)" },
                quality: { type: "integer", minimum: 1, maximum: 100, description: "JPEG quality (1-100, default: 80)" },
                focusGame: { type: "boolean", description: "Bring the RimWorld window to the foreground (switching to its virtual desktop) immediately before capturing, so the grab lands on the game and not the currently visible desktop. Default false." }
            }
        }
    },
    {
        name: "capture_game_window",
        description: "Screenshot a single RimWorld menu/dialog, cropped to just that window. Foregrounds the game, captures the screen, finds the window in the game's own window stack, and crops to its rect (scaled from UI to image pixels). window: a case-insensitive substring of the window's C# type to target (e.g. 'ModsConfig', 'ModSettings', 'Options'); omit to use the frontmost dialog. Open the menu first with open_window. Returns the cropped image path (read it with the Read tool).",
        inputSchema: {
            type: "object",
            properties: {
                window: { type: "string", description: "Substring of the target window's C# type (e.g. 'ModSettings', 'ModsConfig'). Omit to use the frontmost dialog." },
                pad: { type: "integer", minimum: 0, description: "Pixels of padding to add around the window rect (default 0)." },
                format: { type: "string", enum: formatValues, description: "Image format (png or jpeg)" },
                quality: { type: "integer", minimum: 1, maximum: 100, description: "JPEG quality (1-100, default: 80)" }
            }
        }
    },
    {
        name: "capture_gizmo",
        description: "Screenshot the selected thing's command buttons (gizmos — draft/attack/toggles/designators), cropped. gizmo: a case-insensitive label substring to isolate one button (e.g. 'Draft'); omit to capture the whole gizmo bar. Select a thing first with select_thing_at — gizmos only draw for a selected thing with commands. Returns the cropped image path (read it with the Read tool).",
        inputSchema: {
            type: "object",
            properties: {
                gizmo: { type: "string", description: "Label substring of the command button to isolate (e.g. 'Draft', 'Attack'). Omit to capture the whole gizmo bar." },
                pad: { type: "integer", minimum: 0, description: "Pixels of padding around the crop (default 2 for one gizmo, 4 for the bar)." },
                format: { type: "string", enum: formatValues, description: "Image format (png or jpeg)" },
                quality: { type: "integer", minimum: 1, maximum: 100, description: "JPEG quality (1-100, default: 80)" }
            }
        }
    },
    {
        name: "capture_colonist_bar",
        description: "Screenshot the colonist bar at the top of the screen, cropped. colonist: a case-insensitive name substring to isolate one portrait (e.g. 'Nate'); omit to capture the whole bar. No selection needed — the bar draws whenever colonists exist. Returns the cropped image path (read it with the Read tool).",
        inputSchema: {
            type: "object",
            properties: {
                colonist: { type: "string", description: "Name substring of the colonist portrait to isolate (e.g. 'Nate'). Omit to capture the whole bar." },
                pad: { type: "integer", minimum: 0, description: "Pixels of padding around the crop (default 4 for one portrait, 6 for the bar)." },
                format: { type: "string", enum: formatValues, description: "Image format (png or jpeg)" },
                quality: { type: "integer", minimum: 1, maximum: 100, description: "JPEG quality (1-100, default: 80)" }
            }
        }
    },
    {
        name: "capture_play_settings",
        description: "Screenshot the bottom-right map-overlay / play-settings toggle row, cropped. toggle: a tooltip-label substring to isolate one button (e.g. 'roof'); omit to capture the whole row. No selection needed. Returns the cropped image path (read it with the Read tool).",
        inputSchema: {
            type: "object",
            properties: {
                toggle: { type: "string", description: "Tooltip-label substring of the toggle to isolate (e.g. 'roof', 'fertility'). Omit to capture the whole row." },
                pad: { type: "integer", minimum: 0, description: "Pixels of padding around the crop (default 3 for one toggle, 6 for the row)." },
                format: { type: "string", enum: formatValues, description: "Image format (png or jpeg)" },
                quality: { type: "integer", minimum: 1, maximum: 100, description: "JPEG quality (1-100, default: 80)" }
            }
        }
    },
    {
        name: "capture_region",
        description: "Capture a specific region of the screen to an image file and return its path (read it with the Read tool). Pass focusGame:true to foreground the RimWorld window first (see capture_screen).",
        inputSchema: {
            type: "object",
            properties: {
                left: { type: "integer", minimum: 0, description: "Left position of the region in pixels" },
                top: { type: "integer", minimum: 0, description: "Top position of the region in pixels" },
                width: { type: "integer", minimum: 1, description: "Width of the region in pixels" },
                height: { type: "integer", minimum: 1, description: "Height of the region in pixels" },
                format: { type: "string", enum: formatValues, description: "Image format (png or jpeg)" },
                quality: { type: "integer", minimum: 1, maximum: 100, description: "JPEG quality (1-100, default: 80)" },
                focusGame: { type: "boolean", description: "Bring the RimWorld window to the foreground before capturing, so the grab lands on the game. Default false." }
            },
            required: ["left", "top", "width", "height"]
        }
    },
    {
        name: "get_screen_size",
        description: "Get the dimensions of the screen",
        inputSchema: {
            type: "object",
            properties: {}
        }
    },
    {
        name: "move_mouse",
        description: "Move the mouse cursor to a specific position",
        inputSchema: {
            type: "object",
            properties: {
                x: { type: "integer", minimum: 0, description: "X coordinate in pixels" },
                y: { type: "integer", minimum: 0, description: "Y coordinate in pixels" }
            },
            required: ["x", "y"]
        }
    },
    {
        name: "get_mouse_position",
        description: "Get the current position of the mouse cursor",
        inputSchema: {
            type: "object",
            properties: {}
        }
    },
    {
        name: "click_mouse",
        description: "Click the mouse at the current position",
        inputSchema: {
            type: "object",
            properties: {
                button: { type: "string", enum: mouseButtonValues, description: "Mouse button to click" }
            }
        }
    },
    {
        name: "click_at",
        description: "Click the mouse at a specific position",
        inputSchema: {
            type: "object",
            properties: {
                x: { type: "integer", minimum: 0, description: "X coordinate in pixels" },
                y: { type: "integer", minimum: 0, description: "Y coordinate in pixels" },
                button: { type: "string", enum: mouseButtonValues, description: "Mouse button to click" }
            },
            required: ["x", "y"]
        }
    },
    {
        name: "double_click",
        description: "Double-click the mouse at the current position",
        inputSchema: {
            type: "object",
            properties: {}
        }
    },
    {
        name: "double_click_at",
        description: "Double-click the mouse at a specific position",
        inputSchema: {
            type: "object",
            properties: {
                x: { type: "integer", minimum: 0, description: "X coordinate in pixels" },
                y: { type: "integer", minimum: 0, description: "Y coordinate in pixels" }
            },
            required: ["x", "y"]
        }
    },
    {
        name: "scroll_mouse",
        description: "Scroll the mouse wheel",
        inputSchema: {
            type: "object",
            properties: {
                direction: { type: "string", enum: scrollDirectionValues, description: "Direction to scroll" },
                amount: { type: "integer", minimum: 1, maximum: 10, description: "Amount to scroll (number of clicks)" }
            },
            required: ["direction"]
        }
    },
    {
        name: "drag_mouse",
        description: "Drag the mouse from current position to target position",
        inputSchema: {
            type: "object",
            properties: {
                x: { type: "integer", minimum: 0, description: "Target X coordinate in pixels" },
                y: { type: "integer", minimum: 0, description: "Target Y coordinate in pixels" }
            },
            required: ["x", "y"]
        }
    },
    {
        name: "drag_mouse_from_to",
        description: "Drag the mouse from start position to end position",
        inputSchema: {
            type: "object",
            properties: {
                startX: { type: "integer", minimum: 0, description: "Start X coordinate in pixels" },
                startY: { type: "integer", minimum: 0, description: "Start Y coordinate in pixels" },
                endX: { type: "integer", minimum: 0, description: "End X coordinate in pixels" },
                endY: { type: "integer", minimum: 0, description: "End Y coordinate in pixels" }
            },
            required: ["startX", "startY", "endX", "endY"]
        }
    },
    {
        name: "type_text",
        description: "Type text at the current cursor position",
        inputSchema: {
            type: "object",
            properties: {
                text: { type: "string", minLength: 1, description: "The text to type" }
            },
            required: ["text"]
        }
    },
    {
        name: "type_text_with_delay",
        description: "Type text with a delay between keystrokes",
        inputSchema: {
            type: "object",
            properties: {
                text: { type: "string", minLength: 1, description: "The text to type" },
                delayMs: { type: "integer", minimum: 10, maximum: 1000, description: "Delay between keystrokes in milliseconds" }
            },
            required: ["text"]
        }
    },
    {
        name: "press_key",
        description: "Press a keyboard key",
        inputSchema: {
            type: "object",
            properties: {
                key: { type: "string", enum: keyValues, description: "The key to press" }
            },
            required: ["key"]
        }
    },
    {
        name: "press_key_shortcut",
        description: "Press a keyboard shortcut (combination of keys)",
        inputSchema: {
            type: "object",
            properties: {
                keys: {
                    type: "array",
                    items: { type: "string", enum: keyValues },
                    minItems: 1,
                    maxItems: 5,
                    description: "Array of keys to press simultaneously"
                }
            },
            required: ["keys"]
        }
    },
    {
        name: "hold_key",
        description: "Hold down a keyboard key",
        inputSchema: {
            type: "object",
            properties: {
                key: { type: "string", enum: keyValues, description: "The key to hold down" }
            },
            required: ["key"]
        }
    },
    {
        name: "release_key",
        description: "Release a held keyboard key",
        inputSchema: {
            type: "object",
            properties: {
                key: { type: "string", enum: keyValues, description: "The key to release" }
            },
            required: ["key"]
        }
    },
    {
        name: "get_clipboard_text",
        description: "Get text from the clipboard",
        inputSchema: {
            type: "object",
            properties: {}
        }
    },
    {
        name: "set_clipboard_text",
        description: "Set text to the clipboard",
        inputSchema: {
            type: "object",
            properties: {
                text: { type: "string", description: "The text to set to the clipboard" }
            },
            required: ["text"]
        }
    },
    {
        name: "copy_selected_text",
        description: "Copy selected text to clipboard and return it",
        inputSchema: {
            type: "object",
            properties: {}
        }
    },
    {
        name: "paste_text",
        description: "Paste text at current cursor position",
        inputSchema: {
            type: "object",
            properties: {
                text: { type: "string", description: "The text to paste" }
            },
            required: ["text"]
        }
    },
    {
        name: "get_clipboard_image",
        description: "Get image from the clipboard (if available) as base64 data",
        inputSchema: {
            type: "object",
            properties: {}
        }
    },
    {
        name: "get_ui_element_info",
        description: uiAutomation_1.getUiElementInfoTool.description,
        inputSchema: {
            type: "object",
            properties: {
                windowTitle: { type: "string", description: "Window title must be provided" },
                elementName: { type: "string", description: "Name identifier" },
                automationId: { type: "string", description: "Automation ID identifier" },
                className: { type: "string", description: "Class name identifier" }
            },
            required: ["windowTitle"]
        }
    },
    {
        name: "invoke_ui_element_action",
        description: uiAutomation_1.invokeUiElementActionTool.description,
        inputSchema: {
            type: "object",
            properties: {
                windowTitle: { type: "string", description: "Window title must be provided" },
                action: { type: "string", enum: ["Click", "SetValue", "Focus"], description: "Action to perform" },
                elementName: { type: "string", description: "Name identifier" },
                automationId: { type: "string", description: "Automation ID identifier" },
                className: { type: "string", description: "Class name identifier" },
                valueToSet: { type: "string", description: "Value to set (only used for SetValue action)" }
            },
            required: ["windowTitle", "action"]
        }
    }
];
async function handlePcControlTool(name, args) {
    try {
        switch (name) {
            case "capture_screen": {
                const { format, quality, focusGame } = args;
                const focusNote = focusGame ? " " + describeFocus(foregroundGameWindow()) : "";
                const filePath = await (0, screen_1.captureScreen)(format, quality);
                return { content: [{ type: "text", text: `Screen captured to ${filePath}${focusNote} — open it with the Read tool to view the image.` }] };
            }
            case "capture_game_window": {
                const { window: wantType, pad, format, quality } = args;
                // 1) Read the game's window stack (needs a live game — the bridge only answers then).
                const wins = await (0, gameIpc_1.requestOpenWindows)();
                if (!wins) {
                    return { isError: true, content: [{ type: "text", text: "capture_game_window: no window data from the game. Is RimWorld running with a live game loaded? (Open a menu with open_window first.)" }] };
                }
                // 2) Pick the target window (skip the tiny always-on ImmediateWindow overlays).
                const candidates = wins.windows.filter(w => w.type !== "ImmediateWindow");
                let target;
                if (wantType) {
                    const q = String(wantType).toLowerCase();
                    // Search front-to-back so the most-recently-opened match wins.
                    target = [...candidates].reverse().find(w => w.type.toLowerCase().includes(q) || w.fullType.toLowerCase().includes(q));
                }
                else {
                    const dialogs = candidates.filter(w => w.layer === "Dialog");
                    target = (dialogs.length ? dialogs : candidates).slice(-1)[0];
                }
                if (!target) {
                    const names = candidates.map(w => w.type).join(", ") || "(none open)";
                    return { isError: true, content: [{ type: "text", text: `capture_game_window: no window matched "${wantType ?? "(frontmost)"}". Currently open: ${names}. Open one with open_window.` }] };
                }
                const r = await captureAndCrop(target.rect, wins.screen?.width || 0, wins.screen?.height || 0, { pad, format, quality, outName: "window_crop" });
                return { content: [{ type: "text", text: `Captured '${target.type}' cropped to ${r.cropW}x${r.cropH} at (${r.left},${r.top}) → ${r.outPath} ${describeFocus(r.focusToken)}. Read it to view. (Full frame kept at ${r.fullPath}.)` }] };
            }
            case "capture_gizmo": {
                const { gizmo: wantLabel, pad, format, quality } = args;
                const g = await (0, gameIpc_1.requestGizmos)();
                if (!g) {
                    return { isError: true, content: [{ type: "text", text: "capture_gizmo: no gizmo data from the game. Is RimWorld running with a live game loaded?" }] };
                }
                if (!g.gizmos.length) {
                    return { isError: true, content: [{ type: "text", text: "capture_gizmo: no gizmos on screen. Select a thing first with select_thing_at — gizmos (command buttons) only draw for a selected thing that has commands." }] };
                }
                let rect;
                let labelDesc;
                if (wantLabel) {
                    const q = String(wantLabel).toLowerCase();
                    const hit = g.gizmos.find(x => (x.label || "").toLowerCase().includes(q));
                    if (!hit) {
                        const names = g.gizmos.map(x => x.label).join(", ");
                        return { isError: true, content: [{ type: "text", text: `capture_gizmo: no gizmo matched "${wantLabel}". On screen: ${names}.` }] };
                    }
                    rect = { x: hit.x, y: hit.y, width: hit.width, height: hit.height };
                    labelDesc = `gizmo '${hit.label}'`;
                }
                else {
                    const b = g.bounds || g.gizmos[0];
                    rect = { x: b.x, y: b.y, width: b.width, height: b.height };
                    labelDesc = `gizmo bar (${g.gizmos.length} buttons)`;
                }
                // A little padding so button borders aren't clipped; more for the whole-bar shot.
                const effPad = pad ?? (wantLabel ? 2 : 4);
                const r = await captureAndCrop(rect, g.screen?.width || 0, g.screen?.height || 0, { pad: effPad, format, quality, outName: "gizmo_crop" });
                return { content: [{ type: "text", text: `Captured ${labelDesc} cropped to ${r.cropW}x${r.cropH} at (${r.left},${r.top}) → ${r.outPath} ${describeFocus(r.focusToken)}. Read it to view.` }] };
            }
            case "capture_colonist_bar": {
                const { colonist: wantName, pad, format, quality } = args;
                const cb = await (0, gameIpc_1.requestColonistBar)();
                if (!cb) {
                    return { isError: true, content: [{ type: "text", text: "capture_colonist_bar: no colonist-bar data from the game. Is RimWorld running with a live game loaded?" }] };
                }
                if (!cb.entries.length) {
                    return { isError: true, content: [{ type: "text", text: "capture_colonist_bar: no colonist bar on screen — are there colonists, and is the bar enabled in Options?" }] };
                }
                let rect;
                let desc;
                if (wantName) {
                    const q = String(wantName).toLowerCase();
                    const hit = cb.entries.find(e => (e.label || "").toLowerCase().includes(q));
                    if (!hit) {
                        const names = cb.entries.map(e => e.label).join(", ");
                        return { isError: true, content: [{ type: "text", text: `capture_colonist_bar: no colonist matched "${wantName}". On the bar: ${names}.` }] };
                    }
                    rect = { x: hit.x, y: hit.y, width: hit.width, height: hit.height };
                    desc = `colonist '${hit.label}'`;
                }
                else {
                    const b = cb.bounds || cb.entries[0];
                    rect = { x: b.x, y: b.y, width: b.width, height: b.height };
                    desc = `colonist bar (${cb.entries.length} pawns)`;
                }
                const effPad = pad ?? (wantName ? 4 : 6);
                const r = await captureAndCrop(rect, cb.screen?.width || 0, cb.screen?.height || 0, { pad: effPad, format, quality, outName: "colonistbar_crop" });
                return { content: [{ type: "text", text: `Captured ${desc} cropped to ${r.cropW}x${r.cropH} at (${r.left},${r.top}) → ${r.outPath} ${describeFocus(r.focusToken)}. Read it to view.` }] };
            }
            case "capture_play_settings": {
                const { toggle: wantToggle, pad, format, quality } = args;
                const ps = await (0, gameIpc_1.requestPlaySettings)();
                if (!ps) {
                    return { isError: true, content: [{ type: "text", text: "capture_play_settings: no play-settings data from the game. Is RimWorld running with a live map view?" }] };
                }
                if (!ps.toggles.length) {
                    return { isError: true, content: [{ type: "text", text: "capture_play_settings: no toggles captured — need a live map view (the play-settings row doesn't draw on the world map)." }] };
                }
                let rect;
                let desc;
                if (wantToggle) {
                    const q = String(wantToggle).toLowerCase();
                    const hit = ps.toggles.find(t => (t.label || "").toLowerCase().includes(q));
                    if (!hit) {
                        const names = ps.toggles.map(t => t.label).join(", ");
                        return { isError: true, content: [{ type: "text", text: `capture_play_settings: no toggle matched "${wantToggle}". On the row: ${names}.` }] };
                    }
                    rect = { x: hit.x, y: hit.y, width: hit.width, height: hit.height };
                    desc = `toggle '${hit.label}'`;
                }
                else {
                    const b = ps.bounds || ps.toggles[0];
                    rect = { x: b.x, y: b.y, width: b.width, height: b.height };
                    desc = `play-settings row (${ps.toggles.length} toggles)`;
                }
                const effPad = pad ?? (wantToggle ? 3 : 6);
                const r = await captureAndCrop(rect, ps.screen?.width || 0, ps.screen?.height || 0, { pad: effPad, format, quality, outName: "playsettings_crop" });
                return { content: [{ type: "text", text: `Captured ${desc} cropped to ${r.cropW}x${r.cropH} at (${r.left},${r.top}) → ${r.outPath} ${describeFocus(r.focusToken)}. Read it to view.` }] };
            }
            case "capture_region": {
                const { left, top, width, height, format, quality, focusGame } = args;
                const focusNote = focusGame ? " " + describeFocus(foregroundGameWindow()) : "";
                const region = { left, top, width, height };
                const filePath = await (0, screen_1.captureRegion)(region, format, quality);
                return { content: [{ type: "text", text: `Screen region captured to ${filePath}${focusNote} — open it with the Read tool to view the image.` }] };
            }
            case "get_screen_size": {
                const { width, height } = await (0, screen_1.getScreenSize)();
                return { content: [{ type: "text", text: `Screen dimensions: ${width}x${height} pixels` }] };
            }
            case "move_mouse": {
                const { x, y } = args;
                const position = { x, y };
                await (0, mouse_1.moveMouse)(position);
                return { content: [{ type: "text", text: `Mouse moved to position: (${x}, ${y})` }] };
            }
            case "get_mouse_position": {
                const { x, y } = await (0, mouse_1.getMousePosition)();
                return { content: [{ type: "text", text: `Current mouse position: (${x}, ${y})` }] };
            }
            case "click_mouse": {
                const { button } = args;
                await (0, mouse_1.clickMouse)(button);
                return { content: [{ type: "text", text: `Mouse clicked with ${button || types_1.MouseButton.LEFT} button` }] };
            }
            case "click_at": {
                const { x, y, button } = args;
                const position = { x, y };
                await (0, mouse_1.clickMouseAt)(position, button);
                return { content: [{ type: "text", text: `Mouse clicked at position (${x}, ${y}) with ${button || types_1.MouseButton.LEFT} button` }] };
            }
            case "double_click": {
                await (0, mouse_1.doubleClick)();
                return { content: [{ type: "text", text: "Mouse double-clicked" }] };
            }
            case "double_click_at": {
                const { x, y } = args;
                const position = { x, y };
                await (0, mouse_1.doubleClickAt)(position);
                return { content: [{ type: "text", text: `Mouse double-clicked at position (${x}, ${y})` }] };
            }
            case "scroll_mouse": {
                const { direction, amount } = args;
                await (0, mouse_1.scrollMouse)(direction, amount);
                return { content: [{ type: "text", text: `Mouse scrolled ${direction} by ${amount || 1} clicks` }] };
            }
            case "drag_mouse": {
                const { x, y } = args;
                const target = { x, y };
                await (0, mouse_1.dragMouse)(target);
                return { content: [{ type: "text", text: `Mouse dragged to position (${x}, ${y})` }] };
            }
            case "drag_mouse_from_to": {
                const { startX, startY, endX, endY } = args;
                const start = { x: startX, y: startY };
                const end = { x: endX, y: endY };
                await (0, mouse_1.dragMouseFromTo)(start, end);
                return { content: [{ type: "text", text: `Mouse dragged from position (${startX}, ${startY}) to (${endX}, ${endY})` }] };
            }
            case "type_text": {
                const { text } = args;
                await (0, keyboard_1.typeText)(text);
                return { content: [{ type: "text", text: `Typed: ${text}` }] };
            }
            case "type_text_with_delay": {
                const { text, delayMs } = args;
                await (0, keyboard_1.typeTextWithDelay)(text, delayMs);
                return { content: [{ type: "text", text: `Typed with delay: ${text}` }] };
            }
            case "press_key": {
                const { key } = args;
                await (0, keyboard_1.pressKey)(key);
                return { content: [{ type: "text", text: `Pressed key: ${key}` }] };
            }
            case "press_key_shortcut": {
                const { keys } = args;
                await (0, keyboard_1.pressKeyShortcut)(keys);
                return { content: [{ type: "text", text: `Pressed key shortcut: ${keys.join(" + ")}` }] };
            }
            case "hold_key": {
                const { key } = args;
                await (0, keyboard_1.holdKey)(key);
                return { content: [{ type: "text", text: `Holding key: ${key}` }] };
            }
            case "release_key": {
                const { key } = args;
                await (0, keyboard_1.releaseKey)(key);
                return { content: [{ type: "text", text: `Released key: ${key}` }] };
            }
            case "get_clipboard_text": {
                const text = await (0, clipboard_1.getClipboardText)();
                return { content: [{ type: "text", text: `Clipboard content: ${text}` }] };
            }
            case "set_clipboard_text": {
                const { text } = args;
                await (0, clipboard_1.setClipboardText)(text);
                return { content: [{ type: "text", text: "Text set to clipboard successfully" }] };
            }
            case "copy_selected_text": {
                const text = await (0, clipboard_1.copySelectedText)();
                return { content: [{ type: "text", text: `Copied text: ${text}` }] };
            }
            case "paste_text": {
                const { text } = args;
                await (0, clipboard_1.pasteText)(text);
                return { content: [{ type: "text", text: "Text pasted successfully" }] };
            }
            case "get_clipboard_image": {
                const base64Image = await (0, clipboard_1.getClipboardImage)();
                if (base64Image) {
                    return { content: [{ type: "text", text: `Clipboard image retrieved successfully. Image data: ${base64Image}` }] };
                }
                else {
                    return { content: [{ type: "text", text: "No image found on the clipboard." }] };
                }
            }
            case "get_ui_element_info": {
                const resultJson = await uiAutomation_1.getUiElementInfoTool.execute(args);
                return { content: [{ type: "text", text: resultJson }] };
            }
            case "invoke_ui_element_action": {
                const resultMessage = await uiAutomation_1.invokeUiElementActionTool.execute(args);
                return { content: [{ type: "text", text: resultMessage }] };
            }
            case "launch_quicktest": {
                // Bare escape hatch (bare:true): the old minimal spawn — just open the game as the player has
                // it. No -savedatafolder pinning, no Prefs.xml, no Workshop mirroring, no desktop move; it uses
                // the default LocalLow config. Use it to poke the game open as-is, NOT to test a configured
                // modlist (that's the guarded path below). The idle watchdog is still armed so a bare launch
                // can't run unattended overnight either.
                if (args.bare === true) {
                    const killExisting = args.killExisting !== false;
                    if (killExisting) {
                        try {
                            (0, child_process_1.execSync)("taskkill /f /im RimWorldWin64.exe", { stdio: "ignore" });
                        }
                        catch (e) {
                            // Ignore if process not found
                        }
                    }
                    const rimworldPath = "C:\\Program Files (x86)\\Steam\\steamapps\\common\\RimWorld\\RimWorldWin64.exe";
                    const child = (0, child_process_1.spawn)(rimworldPath, ["-quicktest"], {
                        detached: true,
                        stdio: "ignore"
                    });
                    child.unref();
                    const watchdogNote = (0, gameWatchdog_1.armGameWatchdog)({ pid: child.pid ?? null, idleTimeoutMin: args.idleTimeoutMin });
                    return { content: [{ type: "text", text: `RimWorld quicktest launched (bare) — default LocalLow config, no dev/savedatafolder pinning.\n${watchdogNote}`.trim() }] };
                }
                // Guarded default: route through launch_rimworld with quicktest so the map boots from the
                // CONFIGURED savedatafolder (the one configure_active_mods writes) — not the player's default
                // LocalLow config. Booting from the wrong config is a silent false pass: the modlist you set up
                // isn't the one that loads. Delegating also picks up the Steam bypass, Workshop-mod mirroring,
                // PID tracking and idle watchdog. Any launch_rimworld option (savedatafolder, killExisting,
                // developer, nosound, loadSave, idleTimeoutMin) passes through.
                return await (0, rimworldDev_1.handleRimworldDevTool)("launch_rimworld", { ...args, quicktest: true });
            }
            default:
                throw new Error(`Unknown PC Control tool: ${name}`);
        }
    }
    catch (error) {
        return {
            isError: true,
            content: [
                {
                    type: "text",
                    text: `Error executing ${name}: ${error instanceof Error ? error.message : String(error)}`
                }
            ]
        };
    }
}
