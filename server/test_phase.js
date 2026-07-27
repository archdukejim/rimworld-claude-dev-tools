const { handleTestingTool } = require('./build/tools/testing');
const fs = require('fs');
const path = require('path');

const baseMods = [
    "brrainz.harmony",
    "ludeon.rimworld",
    "nozome.mapmodeframework",
    "rimsynapse.conversations",
    "rimsynapse.core",
    "rimsynapse.factions",
    "rimsynapse.nvidiatool",
    "rimsynapse.psychology",
    "rimsynapse.regionsandterritories"
];

const phases = {
    1: [], // No DLCs
    2: ["ludeon.rimworld.royalty"],
    3: ["ludeon.rimworld.ideology"],
    4: ["ludeon.rimworld.biotech"],
    5: ["ludeon.rimworld.anomaly"],
    6: ["ludeon.rimworld.odyssey"],
    7: ["ludeon.rimworld.royalty", "ludeon.rimworld.ideology", "ludeon.rimworld.biotech", "ludeon.rimworld.anomaly", "ludeon.rimworld.odyssey"]
};

async function main() {
    const phaseNum = parseInt(process.argv[2], 10);
    if (!phases[phaseNum]) {
        console.error("Invalid phase number. Choose 1 to 7.");
        process.exit(1);
    }

    // Determine active mods list
    const dlcs = phases[phaseNum];
    const activeMods = [
        "brrainz.harmony",
        "ludeon.rimworld",
        ...dlcs,
        "nozome.mapmodeframework",
        "rimsynapse.conversations",
        "rimsynapse.core",
        "rimsynapse.factions",
        "rimsynapse.nvidiatool",
        "rimsynapse.psychology",
        "rimsynapse.regionsandterritories"
    ];

    console.log(`--- RUNNING PHASE ${phaseNum} ---`);
    console.log(`Setting active mods: ${JSON.stringify(activeMods)}`);

    try {
        // 1. Configure active mods
        let res = await handleTestingTool("configure_active_mods", { activeMods }, null, null);
        console.log(res.content[0].text);

        // 2. Restart game with quicktest: false (normal launch)
        console.log("Relaunching RimWorld (normal launch to main menu)...");
        res = await handleTestingTool("restart_game", { quicktest: false }, null, null);
        console.log(res.content[0].text);

        console.log("SUCCESS. The game should be loading. Wait for main menu.");
    } catch (err) {
        console.error("ERROR running phase setup:", err);
        process.exit(1);
    }
}

main();
