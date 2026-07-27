"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const factions_1 = require("./tools/factions");
async function runTest() {
    console.log("==================================================");
    console.log("  RIMSYNAPSE FACTIONS: MCP INTEGRATION TEST RUNNER");
    console.log("==================================================");
    try {
        console.log("1. Testing 'get_all_factions'...");
        const allRes = await (0, factions_1.handleFactionsTool)("get_all_factions", {});
        const allFactionsObj = JSON.parse(allRes.content[0].text);
        console.log("All Factions:\n", JSON.stringify(allFactionsObj, null, 2));
        // Find a hostile faction to test relations/crisis query
        const hostile = allFactionsObj.factions?.find((f) => f.hostile && !f.isPlayer);
        const testFactionName = hostile ? hostile.name : "Rough Outlander";
        console.log(`\nDetected Hostile Faction to Test: "${testFactionName}"`);
        console.log("\n2. Testing 'get_motivated_factions'...");
        const result = await (0, factions_1.handleFactionsTool)("get_motivated_factions", {});
        console.log("Result received:\n", result.content[0].text);
        console.log(`\n3. Testing 'get_faction_relations_history' for "${testFactionName}"...`);
        const resultHistory = await (0, factions_1.handleFactionsTool)("get_faction_relations_history", { factionName: testFactionName });
        console.log("Result received:\n", resultHistory.content[0].text);
        console.log(`\n4. Testing 'trigger_settlement_crisis' for "${testFactionName}" and "Blight"...`);
        const resultCrisis = await (0, factions_1.handleFactionsTool)("trigger_settlement_crisis", { factionName: testFactionName, crisisType: "Blight" });
        console.log("Result received:\n", resultCrisis.content[0].text);
        console.log("\nSTATUS: ALL INTEGRATION TESTS COMPLETE");
        console.log("==================================================");
    }
    catch (err) {
        console.error("Test failed with error:", err.message);
    }
}
runTest();
