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
const fs = __importStar(require("fs"));
const toolInputPath = "d:/github/rimsynapse/Core/tool_input.json";
const toolOutputPath = "d:/github/rimsynapse/Core/tool_output.json";
async function callInGameTool(name, args) {
    const startTime = Date.now();
    const requestPayload = {
        name,
        arguments: args
    };
    if (fs.existsSync(toolOutputPath)) {
        try {
            fs.unlinkSync(toolOutputPath);
        }
        catch (e) { }
    }
    fs.writeFileSync(toolInputPath, JSON.stringify(requestPayload, null, 2), "utf8");
    for (let i = 0; i < 100; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (fs.existsSync(toolOutputPath)) {
            try {
                const stats = fs.statSync(toolOutputPath);
                if (stats.mtimeMs < startTime) {
                    continue;
                }
                const outputContent = fs.readFileSync(toolOutputPath, "utf8");
                const parsed = JSON.parse(outputContent);
                fs.unlinkSync(toolOutputPath);
                return parsed;
            }
            catch (err) { }
        }
    }
    throw new Error(`Timeout calling tool: ${name}`);
}
async function runTest() {
    console.log("==================================================");
    console.log("  RIMSYNAPSE LEADER BACKSTORY: MCP INTEGRATION TEST");
    console.log("==================================================");
    try {
        // Step 1: Get all factions to locate a leader name
        console.log("1. Fetching all factions...");
        const factionsResult = await callInGameTool("get_all_factions", {});
        console.log("Available Factions list retrieved.");
        const candidate = factionsResult.factions?.find((f) => !f.isPlayer && f.leaderName && f.leaderName !== "None" && f.leaderName !== "Unknown");
        if (!candidate) {
            console.error("ERROR: No non-player faction with a valid leader was found. Factions response:");
            console.error(JSON.stringify(factionsResult, null, 2));
            process.exit(1);
        }
        const leaderName = candidate.leaderName;
        const factionName = candidate.name;
        console.log(`Target Leader to Test: "${leaderName}" (Faction: "${factionName}")`);
        // Step 1.5: Manually trigger leader backstory generation pipeline
        console.log("\n1.5. Manually triggering leader backstory generation...");
        let triggerRes = await callInGameTool("trigger_leader_backstory_generation", {});
        console.log("First trigger (queued Faction History):", JSON.stringify(triggerRes));
        console.log("Waiting 2 seconds for Faction History LLM callback processing...");
        await new Promise(resolve => setTimeout(resolve, 2000));
        triggerRes = await callInGameTool("trigger_leader_backstory_generation", {});
        console.log("Second trigger (queued Leader Childhood/Adulthood/Profile):", JSON.stringify(triggerRes));
        console.log("Waiting 3 seconds for Leader Backstory LLM callback processing...");
        await new Promise(resolve => setTimeout(resolve, 3000));
        // Step 2: Poll get_colonist_psychology_profile for any generated leader profile
        console.log("\n2. Polling leader psychology profile...");
        let profile = null;
        let success = false;
        let chosenLeaderName = leaderName;
        const candidateLeaders = factionsResult.factions
            ?.map((f) => f.leaderName)
            .filter((name) => name && name !== "None" && name !== "Unknown");
        // Poll for up to 30 seconds to allow the staggered background ticks to complete the 3-stage generation
        for (let attempt = 1; attempt <= 30; attempt++) {
            console.log(`Polling attempt ${attempt}/30...`);
            for (const name of candidateLeaders) {
                try {
                    profile = await callInGameTool("get_colonist_psychology_profile", { pawnName: name });
                    if (profile && profile.personalitySummary && profile.personalitySummary !== "No summary generated yet.") {
                        success = true;
                        chosenLeaderName = name;
                        break;
                    }
                }
                catch (e) { }
            }
            if (success)
                break;
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        if (!success) {
            console.log("\nTimed out waiting for personalitySummary. Let's dump current profile state:");
            console.log(JSON.stringify(profile, null, 2));
            throw new Error("Faction Leader Backstory pipeline did not complete or generate personalitySummary in time.");
        }
        console.log("\nProfile generation verified!");
        console.log("--------------------------------------------------");
        console.log(`ID: ${profile.pawnId}`);
        console.log(`Name: ${profile.name}`);
        console.log(`Gender: ${profile.gender}`);
        console.log(`Age: ${profile.age}`);
        console.log(`Faction: ${profile.faction}`);
        console.log(`Hometown: ${profile.hometown}`);
        console.log(`Personality Summary: ${profile.personalitySummary}`);
        console.log("LLM Traits:");
        profile.llmTraits?.forEach((t) => console.log(`  - ${t}`));
        console.log("\nRecent Backstory Memories:");
        profile.recentMemories?.forEach((m) => {
            console.log(`  * [${m.type}] weight: ${m.weight}`);
            console.log(`    Content: "${m.summary}"`);
        });
        console.log("--------------------------------------------------");
        // Validations
        if (!profile.hometown)
            throw new Error("Hometown was not generated!");
        if (profile.llmTraits.length === 0)
            throw new Error("LLM Traits list is empty!");
        const hasChildhood = profile.recentMemories?.some((m) => m.type === "BackstoryChildhood");
        const hasAdulthood = profile.recentMemories?.some((m) => m.type === "BackstoryAdulthood");
        if (!hasChildhood)
            throw new Error("Childhood memory was not generated!");
        if (!hasAdulthood)
            throw new Error("Adulthood memory was not generated!");
        console.log("\nSTATUS: ALL PIPELINE VERIFICATIONS PASSED SUCCESSFULLY!");
        console.log("==================================================");
    }
    catch (error) {
        console.error(`\nTEST FAILED: ${error.message}`);
        process.exit(1);
    }
}
runTest();
