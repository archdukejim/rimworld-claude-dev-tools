import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { spawn } from "child_process";
import * as path from "path";

// Helper to get script paths relative to the compiled JS folder
// __dirname compiles to d:\github\rimsynapse\Repo-MCP\server\build\tools\pc\
const getInfoScriptPath = path.resolve(__dirname, "../../../../scripts/GetUIElementInfo.ps1");
const invokeActionScriptPath = path.resolve(__dirname, "../../../../scripts/InvokeUIElementAction.ps1");

const GetUiElementInfoInputSchema = z.object({
  windowTitle: z.string().min(1, "Window title must be provided"),
  elementName: z.string().optional(),
  automationId: z.string().optional(),
  className: z.string().optional(),
});

export type GetUiElementInfoInput = z.infer<typeof GetUiElementInfoInputSchema>;

export const getUiElementInfoTool = {
  name: "get_ui_element_info",
  description: "Finds a UI element within a specified window using UI Automation and returns its properties (Name, AutomationId, ClassName, ControlType, BoundingRectangle, IsEnabled, IsOffscreen, Value). Requires window title and at least one element identifier (name, automationId, or className).",
  inputSchema: GetUiElementInfoInputSchema,

  execute: async (input: GetUiElementInfoInput): Promise<string> => {
    return new Promise((resolve, reject) => {
      const args = [
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", getInfoScriptPath,
        "-WindowTitle", input.windowTitle,
      ];
      if (input.elementName) args.push("-ElementName", input.elementName);
      if (input.automationId) args.push("-AutomationId", input.automationId);
      if (input.className) args.push("-ClassName", input.className);

      const ps = spawn("powershell.exe", args);

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
            } else if (trimmedOutput.startsWith("[") && trimmedOutput.endsWith("]")) {
               JSON.parse(trimmedOutput); // Validate JSON array
               resolve(trimmedOutput);
            } else if (trimmedOutput) {
                resolve(`Script executed successfully, but output was not valid JSON:\n${trimmedOutput}`);
            } else {
                resolve("Script executed successfully with no JSON output.");
            }
           } catch (parseError: unknown) {
             console.error("Raw stdout:", stdoutData);
             const errorMessage = parseError instanceof Error ? parseError.message : String(parseError);
             reject(new McpError(ErrorCode.InternalError, `Script succeeded but failed to parse JSON output: ${errorMessage}\nOutput:\n${stdoutData}`));
           }
         } else {
           console.error("PowerShell Error Output:", stderrData);
           const errorMessage = stderrData.trim() || stdoutData.trim() || `PowerShell script exited with code ${code}`;
           reject(new McpError(ErrorCode.InternalError, `Failed to get UI element info: ${errorMessage}`));
         }
       });

        ps.on("error", (err) => {
          reject(new McpError(ErrorCode.InternalError, `Failed to start PowerShell process: ${err.message}`));
        });
     });
  },
};

const InvokeUiElementActionInputSchema = z.object({
  windowTitle: z.string().min(1, "Window title must be provided"),
  action: z.enum(["Click", "SetValue", "Focus"]),
  elementName: z.string().optional(),
  automationId: z.string().optional(),
  className: z.string().optional(),
  valueToSet: z.string().optional(),
});

export type InvokeUiElementActionInput = z.infer<typeof InvokeUiElementActionInputSchema>;

export const invokeUiElementActionTool = {
  name: "invoke_ui_element_action",
  description: "Performs an action (Click, SetValue, Focus) on a specified UI element found via UI Automation. Requires window title, action, and at least one element identifier. Requires valueToSet for the SetValue action.",
  inputSchema: InvokeUiElementActionInputSchema,

  execute: async (input: InvokeUiElementActionInput): Promise<string> => {
    return new Promise((resolve, reject) => {
      const args = [
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", invokeActionScriptPath,
        "-WindowTitle", input.windowTitle,
        "-Action", input.action,
      ];
      if (input.elementName) args.push("-ElementName", input.elementName);
      if (input.automationId) args.push("-AutomationId", input.automationId);
      if (input.className) args.push("-ClassName", input.className);
      if (input.action === "SetValue" && input.valueToSet !== undefined) {
          args.push("-ValueToSet", input.valueToSet);
      }

      const ps = spawn("powershell.exe", args);

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
          } else {
            console.error("PowerShell Error Output:", stderrData);
            const errorMessage = stderrData.trim() || stdoutData.trim() || `PowerShell script exited with code ${code}`;
            reject(new McpError(ErrorCode.InternalError, `Failed to invoke UI element action: ${errorMessage}`));
          }
      });

       ps.on("error", (err) => {
         reject(new McpError(ErrorCode.InternalError, `Failed to start PowerShell process: ${err.message}`));
       });
    });
  },
};

export const uiAutomationTools = [
  getUiElementInfoTool,
  invokeUiElementActionTool
];
