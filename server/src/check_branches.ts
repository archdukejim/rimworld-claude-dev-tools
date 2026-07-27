import { execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";

const workspaceRoot = "d:\\github\\rimsynapse";
const repos = [
    "Core",
    "Conversations",
    "Psychology",
    "Factions",
    "NVIDIA-Tool",
    "WorldNews",
    "AuraAlgorithm",
    "LLM-Trainer",
    "Repo-MCP"
];

async function checkBranches() {
    console.log("Checking current branches for all repositories...\n");
    for (const repo of repos) {
        const repoPath = path.join(workspaceRoot, repo);
        if (!fs.existsSync(repoPath)) continue;
        
        try {
            const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: repoPath, stdio: "pipe" }).toString().trim();
            const localBranches = execSync("git branch", { cwd: repoPath, stdio: "pipe" }).toString().split("\n").map(b => b.replace("*", "").trim()).filter(Boolean);
            
            console.log(`Repository: ${repo}`);
            console.log(`  - Current Branch: "${currentBranch}"`);
            console.log(`  - Local Branches: [${localBranches.join(", ")}]`);
        } catch (err: any) {
            console.error(`  - Error reading git status for ${repo}:`, err.message);
        }
    }
}

checkBranches().catch(console.error);
