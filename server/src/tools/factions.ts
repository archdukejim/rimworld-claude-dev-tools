import * as fs from "fs";
import * as path from "path";

export const factionsTools = [
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

async function callInGameTool(name: string, args: any): Promise<any> {
    const requestPayload = {
        name,
        arguments: args
    };
    
    // Clean old output file if it exists
    if (fs.existsSync(toolOutputPath)) {
        try { fs.unlinkSync(toolOutputPath); } catch (e) {}
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
            } catch (err: any) {
                // If file is partially written or locked, let it poll again
            }
        }
    }
    
    throw new Error("Timeout waiting for in-game tool execution response. Is the game running and unpaused?");
}

export async function handleFactionsTool(name: string, args: any) {
    try {
        const result = await callInGameTool(name, args);
        return {
            content: [{
                type: "text",
                text: JSON.stringify(result, null, 2)
            }]
        };
    } catch (err: any) {
        return {
            content: [{
                type: "text",
                text: JSON.stringify({ error: err.message }, null, 2)
            }],
            isError: true
        };
    }
}
