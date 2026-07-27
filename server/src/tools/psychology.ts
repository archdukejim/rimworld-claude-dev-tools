import * as fs from "fs";
import * as path from "path";

export const psychologyTools = [
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

export async function handlePsychologyTool(name: string, args: any) {
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
