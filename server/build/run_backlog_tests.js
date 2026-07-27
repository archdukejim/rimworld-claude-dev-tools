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
const testing_1 = require("./tools/testing");
const LOG_FILE = "d:\\github\\rimsynapse\\Core\\backlog_test_results.log";
function logResult(msg) {
    console.log(msg);
    fs.appendFileSync(LOG_FILE, msg + "\n", "utf8");
}
async function runTests() {
    if (fs.existsSync(LOG_FILE)) {
        fs.unlinkSync(LOG_FILE);
    }
    logResult("=================================================");
    logResult("Starting RimSynapse Modularity backlogs tests...");
    logResult("=================================================\n");
    const testCases = [
        {
            name: "MOD-01: Base Mod Independence (No DLCs)",
            activeMods: [
                "brrainz.harmony",
                "ludeon.rimworld",
                "nozome.mapmodeframework",
                "rimsynapse.core",
                "rimsynapse.nvidiatool",
                "rimsynapse.psychology",
                "rimsynapse.conversations",
                "rimsynapse.regionsandterritories",
                "rimsynapse.factions"
            ]
        },
        {
            name: "MOD-02: Royalty DLC Modularity",
            activeMods: [
                "brrainz.harmony",
                "ludeon.rimworld",
                "ludeon.rimworld.royalty",
                "nozome.mapmodeframework",
                "rimsynapse.core",
                "rimsynapse.nvidiatool",
                "rimsynapse.psychology",
                "rimsynapse.conversations",
                "rimsynapse.regionsandterritories",
                "rimsynapse.factions"
            ]
        },
        {
            name: "MOD-03: Ideology DLC Modularity",
            activeMods: [
                "brrainz.harmony",
                "ludeon.rimworld",
                "ludeon.rimworld.ideology",
                "nozome.mapmodeframework",
                "rimsynapse.core",
                "rimsynapse.nvidiatool",
                "rimsynapse.psychology",
                "rimsynapse.conversations",
                "rimsynapse.regionsandterritories",
                "rimsynapse.factions"
            ]
        },
        {
            name: "MOD-04: Biotech DLC Modularity",
            activeMods: [
                "brrainz.harmony",
                "ludeon.rimworld",
                "ludeon.rimworld.biotech",
                "nozome.mapmodeframework",
                "rimsynapse.core",
                "rimsynapse.nvidiatool",
                "rimsynapse.psychology",
                "rimsynapse.conversations",
                "rimsynapse.regionsandterritories",
                "rimsynapse.factions"
            ]
        },
        {
            name: "MOD-05: Anomaly DLC Modularity",
            activeMods: [
                "brrainz.harmony",
                "ludeon.rimworld",
                "ludeon.rimworld.anomaly",
                "nozome.mapmodeframework",
                "rimsynapse.core",
                "rimsynapse.nvidiatool",
                "rimsynapse.psychology",
                "rimsynapse.conversations",
                "rimsynapse.regionsandterritories",
                "rimsynapse.factions"
            ]
        }
    ];
    for (const tc of testCases) {
        logResult(`Running ${tc.name}...`);
        // 1. Configure mod list
        try {
            await (0, testing_1.handleTestingTool)("configure_active_mods", {
                activeMods: tc.activeMods
            }, null, "RimSynapse");
            logResult("-> Mod list configured successfully.");
        }
        catch (err) {
            logResult(`-> [ERROR] Failed to configure mods: ${err.message}`);
            continue;
        }
        // 2. Kill game if running
        try {
            const { execSync } = require("child_process");
            execSync('taskkill /f /im RimWorldWin64.exe', { stdio: 'ignore' });
            logResult("-> Killed active game process.");
        }
        catch (e) { }
        // 3. Restart game
        const testCaseStartTime = Date.now();
        try {
            await (0, testing_1.handleTestingTool)("restart_game", { quicktest: true }, null, "RimSynapse");
            logResult("-> Relaunched game. Waiting 20 seconds for startup logs...");
        }
        catch (err) {
            logResult(`-> [ERROR] Failed to relaunch game: ${err.message}`);
            continue;
        }
        // 4. Wait for game startup
        await new Promise(resolve => setTimeout(resolve, 20000));
        // 5. Inspect Player.log
        const logPath = "C:\\Users\\sealt\\AppData\\LocalLow\\Ludeon Studios\\RimWorld by Ludeon Studios\\Player.log";
        if (fs.existsSync(logPath)) {
            const stats = fs.statSync(logPath);
            if (stats.mtimeMs < testCaseStartTime - 3000) {
                logResult("-> [FAILED] Game did not start or failed to write to Player.log (log is stale).");
                continue;
            }
            const logContent = fs.readFileSync(logPath, "utf8");
            // Check for errors
            const lines = logContent.split("\n");
            const errors = lines.filter(l => (l.includes("[Error]") || l.includes("Exception:") || l.includes("error:")) &&
                !l.includes("ErrorCheckPatches") &&
                !l.includes("Error check all defs"));
            if (errors.length > 0) {
                logResult(`-> [FAILED] Detected ${errors.length} startup errors/exceptions:`);
                errors.slice(0, 5).forEach(e => logResult(`   * ${e.trim()}`));
            }
            else {
                logResult("-> [PASSED] Mod loaded cleanly with zero startup errors.");
            }
        }
        else {
            logResult("-> [WARNING] Player.log not found. Could not verify errors.");
        }
        logResult("");
    }
    logResult("================================================");
    logResult("Backlog testing completed.");
    logResult("================================================");
}
runTests().catch(console.error);
