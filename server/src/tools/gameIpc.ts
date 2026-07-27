import * as fs from "fs";
import * as path from "path";
import { workspaceRoot } from "./rimworldDev";

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

// Both ends of this channel must agree on the directory. The C# side
// (SynapseGameComponent.PollScriptInputFile) resolves it from the Core mod's own folder, so
// these follow the same workspace root instead of a hardcoded drive; RIMSYNAPSE_ROOT
// overrides both.
function coreDir(): string {
    return path.join(workspaceRoot(), "Core");
}

function toolInputFile(): string {
    return path.join(coreDir(), "tool_input.json");
}

function toolOutputFile(): string {
    return path.join(coreDir(), "tool_output.json");
}

async function callInGameTool(name: string, args: any): Promise<any> {
    const requestPayload = {
        name,
        arguments: args
    };
    
    // Clean old output file if it exists
    if (fs.existsSync(toolOutputFile())) {
        try { fs.unlinkSync(toolOutputFile()); } catch (e) {}
    }
    
    fs.writeFileSync(toolInputFile(), JSON.stringify(requestPayload, null, 2), "utf8");
    
    // Poll for tool_output.json for up to 10 seconds (100 iterations * 100ms)
    for (let i = 0; i < 100; i++) {
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
    
    throw new Error("Timeout waiting for in-game tool execution response. Is the game running and unpaused?");
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
