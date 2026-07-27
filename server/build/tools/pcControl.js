"use strict";
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
const keyValues = Object.values(types_1.Key);
const formatValues = Object.values(types_1.CaptureFormat);
const mouseButtonValues = Object.values(types_1.MouseButton);
const scrollDirectionValues = Object.values(types_1.ScrollDirection);
exports.pcControlTools = [
    {
        name: "launch_quicktest",
        description: "Launches RimWorld directly with the -quicktest argument to generate a test map instantly.",
        inputSchema: {
            type: "object",
            properties: {
                killExisting: { type: "boolean", description: "Whether to force close any already running instances of RimWorld first (default: true)" }
            }
        }
    },
    {
        name: "capture_screen",
        description: "Capture the entire screen as an image",
        inputSchema: {
            type: "object",
            properties: {
                format: { type: "string", enum: formatValues, description: "Image format (png or jpeg)" },
                quality: { type: "integer", minimum: 1, maximum: 100, description: "JPEG quality (1-100, default: 80)" }
            }
        }
    },
    {
        name: "capture_region",
        description: "Capture a specific region of the screen",
        inputSchema: {
            type: "object",
            properties: {
                left: { type: "integer", minimum: 0, description: "Left position of the region in pixels" },
                top: { type: "integer", minimum: 0, description: "Top position of the region in pixels" },
                width: { type: "integer", minimum: 1, description: "Width of the region in pixels" },
                height: { type: "integer", minimum: 1, description: "Height of the region in pixels" },
                format: { type: "string", enum: formatValues, description: "Image format (png or jpeg)" },
                quality: { type: "integer", minimum: 1, maximum: 100, description: "JPEG quality (1-100, default: 80)" }
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
                const { format, quality } = args;
                const result = await (0, screen_1.captureScreen)(format, quality);
                return { content: [{ type: "text", text: `Screen captured successfully. ${result}` }] };
            }
            case "capture_region": {
                const { left, top, width, height, format, quality } = args;
                const region = { left, top, width, height };
                const result = await (0, screen_1.captureRegion)(region, format, quality);
                return { content: [{ type: "text", text: `Screen region captured successfully. ${result}` }] };
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
                return { content: [{ type: "text", text: "RimWorld quicktest launched successfully." }] };
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
