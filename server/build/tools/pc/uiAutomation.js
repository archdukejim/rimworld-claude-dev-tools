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
exports.uiAutomationTools = exports.invokeUiElementActionTool = exports.getUiElementInfoTool = void 0;
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const zod_1 = require("zod");
const child_process_1 = require("child_process");
const path = __importStar(require("path"));
// Helper to get script paths relative to the compiled JS folder
// __dirname compiles to d:\github\rimsynapse\Repo-MCP\server\build\tools\pc\
const getInfoScriptPath = path.resolve(__dirname, "../../../../scripts/GetUIElementInfo.ps1");
const invokeActionScriptPath = path.resolve(__dirname, "../../../../scripts/InvokeUIElementAction.ps1");
const GetUiElementInfoInputSchema = zod_1.z.object({
    windowTitle: zod_1.z.string().min(1, "Window title must be provided"),
    elementName: zod_1.z.string().optional(),
    automationId: zod_1.z.string().optional(),
    className: zod_1.z.string().optional(),
});
exports.getUiElementInfoTool = {
    name: "get_ui_element_info",
    description: "Finds a UI element within a specified window using UI Automation and returns its properties (Name, AutomationId, ClassName, ControlType, BoundingRectangle, IsEnabled, IsOffscreen, Value). Requires window title and at least one element identifier (name, automationId, or className).",
    inputSchema: GetUiElementInfoInputSchema,
    execute: async (input) => {
        return new Promise((resolve, reject) => {
            const args = [
                "-NoProfile",
                "-ExecutionPolicy", "Bypass",
                "-File", getInfoScriptPath,
                "-WindowTitle", input.windowTitle,
            ];
            if (input.elementName)
                args.push("-ElementName", input.elementName);
            if (input.automationId)
                args.push("-AutomationId", input.automationId);
            if (input.className)
                args.push("-ClassName", input.className);
            const ps = (0, child_process_1.spawn)("powershell.exe", args);
            let stdoutData = "";
            let stderrData = "";
            ps.stdout.on("data", (data) => {
                stdoutData += data.toString();
            });
            ps.stderr.on("data", (data) => {
                stderrData += data.toString();
            });
            ps.on("close", (code) => {
                if (code === 0) {
                    try {
                        const trimmedOutput = stdoutData.trim();
                        if (trimmedOutput.startsWith("{") && trimmedOutput.endsWith("}")) {
                            JSON.parse(trimmedOutput); // Validate JSON
                            resolve(trimmedOutput);
                        }
                        else if (trimmedOutput.startsWith("[") && trimmedOutput.endsWith("]")) {
                            JSON.parse(trimmedOutput); // Validate JSON array
                            resolve(trimmedOutput);
                        }
                        else if (trimmedOutput) {
                            resolve(`Script executed successfully, but output was not valid JSON:\n${trimmedOutput}`);
                        }
                        else {
                            resolve("Script executed successfully with no JSON output.");
                        }
                    }
                    catch (parseError) {
                        console.error("Raw stdout:", stdoutData);
                        const errorMessage = parseError instanceof Error ? parseError.message : String(parseError);
                        reject(new types_js_1.McpError(types_js_1.ErrorCode.InternalError, `Script succeeded but failed to parse JSON output: ${errorMessage}\nOutput:\n${stdoutData}`));
                    }
                }
                else {
                    console.error("PowerShell Error Output:", stderrData);
                    const errorMessage = stderrData.trim() || stdoutData.trim() || `PowerShell script exited with code ${code}`;
                    reject(new types_js_1.McpError(types_js_1.ErrorCode.InternalError, `Failed to get UI element info: ${errorMessage}`));
                }
            });
            ps.on("error", (err) => {
                reject(new types_js_1.McpError(types_js_1.ErrorCode.InternalError, `Failed to start PowerShell process: ${err.message}`));
            });
        });
    },
};
const InvokeUiElementActionInputSchema = zod_1.z.object({
    windowTitle: zod_1.z.string().min(1, "Window title must be provided"),
    action: zod_1.z.enum(["Click", "SetValue", "Focus"]),
    elementName: zod_1.z.string().optional(),
    automationId: zod_1.z.string().optional(),
    className: zod_1.z.string().optional(),
    valueToSet: zod_1.z.string().optional(),
});
exports.invokeUiElementActionTool = {
    name: "invoke_ui_element_action",
    description: "Performs an action (Click, SetValue, Focus) on a specified UI element found via UI Automation. Requires window title, action, and at least one element identifier. Requires valueToSet for the SetValue action.",
    inputSchema: InvokeUiElementActionInputSchema,
    execute: async (input) => {
        return new Promise((resolve, reject) => {
            const args = [
                "-NoProfile",
                "-ExecutionPolicy", "Bypass",
                "-File", invokeActionScriptPath,
                "-WindowTitle", input.windowTitle,
                "-Action", input.action,
            ];
            if (input.elementName)
                args.push("-ElementName", input.elementName);
            if (input.automationId)
                args.push("-AutomationId", input.automationId);
            if (input.className)
                args.push("-ClassName", input.className);
            if (input.action === "SetValue" && input.valueToSet !== undefined) {
                args.push("-ValueToSet", input.valueToSet);
            }
            const ps = (0, child_process_1.spawn)("powershell.exe", args);
            let stdoutData = "";
            let stderrData = "";
            ps.stdout.on("data", (data) => {
                stdoutData += data.toString();
            });
            ps.stderr.on("data", (data) => {
                stderrData += data.toString();
            });
            ps.on("close", (code) => {
                if (code === 0) {
                    resolve(stdoutData.trim() || "Action completed successfully.");
                }
                else {
                    console.error("PowerShell Error Output:", stderrData);
                    const errorMessage = stderrData.trim() || stdoutData.trim() || `PowerShell script exited with code ${code}`;
                    reject(new types_js_1.McpError(types_js_1.ErrorCode.InternalError, `Failed to invoke UI element action: ${errorMessage}`));
                }
            });
            ps.on("error", (err) => {
                reject(new types_js_1.McpError(types_js_1.ErrorCode.InternalError, `Failed to start PowerShell process: ${err.message}`));
            });
        });
    },
};
exports.uiAutomationTools = [
    exports.getUiElementInfoTool,
    exports.invokeUiElementActionTool
];
