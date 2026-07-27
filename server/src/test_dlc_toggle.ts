import { handleTestingTool } from "./tools/testing";

async function testToggle() {
    console.log("Configuring active mods: disabling all DLCs for base mod testing...");
    const configRes = await handleTestingTool("configure_active_mods", {
        disableDlc: ["royalty", "ideology", "biotech", "anomaly", "odyssey"]
    }, null as any, "RimSynapse");
    console.log("Result:", configRes.content[0].text);

    console.log("\nRestarting RimWorld in quicktest mode...");
    const restartRes = await handleTestingTool("restart_game", { quicktest: true }, null as any, "RimSynapse");
    console.log("Result:", restartRes.content[0].text);
}

testToggle().catch(console.error);
