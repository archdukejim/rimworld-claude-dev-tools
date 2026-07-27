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
const child_process_1 = require("child_process");
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
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
        if (!fs.existsSync(repoPath))
            continue;
        try {
            const currentBranch = (0, child_process_1.execSync)("git rev-parse --abbrev-ref HEAD", { cwd: repoPath, stdio: "pipe" }).toString().trim();
            const localBranches = (0, child_process_1.execSync)("git branch", { cwd: repoPath, stdio: "pipe" }).toString().split("\n").map(b => b.replace("*", "").trim()).filter(Boolean);
            console.log(`Repository: ${repo}`);
            console.log(`  - Current Branch: "${currentBranch}"`);
            console.log(`  - Local Branches: [${localBranches.join(", ")}]`);
        }
        catch (err) {
            console.error(`  - Error reading git status for ${repo}:`, err.message);
        }
    }
}
checkBranches().catch(console.error);
