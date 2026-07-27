"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("./tools/testing");
async function testToggle() {
    console.log("Configuring active mods: disabling all DLCs for base mod testing...");
    const configRes = await (0, testing_1.handleTestingTool)("configure_active_mods", {
        disableDlc: ["royalty", "ideology", "biotech", "anomaly", "odyssey"]
    }, null, "RimSynapse");
    console.log("Result:", configRes.content[0].text);
    console.log("\nRestarting RimWorld in quicktest mode...");
    const restartRes = await (0, testing_1.handleTestingTool)("restart_game", { quicktest: true }, null, "RimSynapse");
    console.log("Result:", restartRes.content[0].text);
}
testToggle().catch(console.error);
