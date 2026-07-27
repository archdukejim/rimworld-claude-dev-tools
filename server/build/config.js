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
exports.loadConfig = loadConfig;
exports.getGitHubToken = getGitHubToken;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
function loadConfig() {
    const configPath = path.join(__dirname, "..", "..", "..", "mcp-config", "config.json");
    if (fs.existsSync(configPath)) {
        const content = fs.readFileSync(configPath, "utf-8");
        return JSON.parse(content);
    }
    // Fallback defaults
    return {
        defaultProjectId: "PVT_kwDOEfI01s4Bdlhx",
        organization: "RimSynapse",
        rimworldPath: "C:\\Program Files (x86)\\Steam\\steamapps\\common\\RimWorld\\RimWorldWin64.exe",
        rimworldModsDir: "C:\\Program Files (x86)\\Steam\\steamapps\\common\\RimWorld\\Mods",
        savedatafolder: "D:\\RimWorldDevData"
    };
}
function getGitHubToken() {
    const tokenFilePath = path.join(__dirname, "..", "..", "github_token.txt");
    let githubToken;
    if (fs.existsSync(tokenFilePath)) {
        const fileContent = fs.readFileSync(tokenFilePath, "utf-8");
        const tokenLine = fileContent.split("\n").find(line => line.startsWith("TOKEN="));
        if (tokenLine) {
            githubToken = tokenLine.split("=")[1].trim();
        }
    }
    if (!githubToken) {
        githubToken = process.env.GITHUB_TOKEN;
    }
    if (!githubToken) {
        throw new Error("No GitHub token found. Please set GITHUB_TOKEN or ensure github_token.txt exists with TOKEN=...");
    }
    return githubToken;
}
