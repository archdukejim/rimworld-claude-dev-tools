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
exports.getSaveDataFolder = getSaveDataFolder;
exports.loadConfig = loadConfig;
exports.getGitHubToken = getGitHubToken;
exports.requireGitHubToken = requireGitHubToken;
exports.loadRepoMap = loadRepoMap;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
/**
 * Where an isolated dev instance keeps its saves, prefs and logs.
 *
 * This is machine-specific: it was a hardcoded D:\ path, which silently produces a broken
 * -savedatafolder argument on any box without that drive. RIMSYNAPSE_SAVEDATA (wired to a
 * user_config field in manifest.json) lets each machine name its own, in the same style as
 * RIMSYNAPSE_ROOT and RIMSYNAPSE_HARNESS.
 */
function getSaveDataFolder() {
    return process.env.RIMSYNAPSE_SAVEDATA?.trim() || "C:\\RimWorldDevData";
}
const DEFAULT_CONFIG = {
    defaultProjectId: "PVT_kwDOEfI01s4Bdlhx",
    organization: "RimSynapse",
    rimworldPath: "C:\\Program Files (x86)\\Steam\\steamapps\\common\\RimWorld\\RimWorldWin64.exe",
    rimworldModsDir: "C:\\Program Files (x86)\\Steam\\steamapps\\common\\RimWorld\\Mods",
    savedatafolder: getSaveDataFolder(),
    bridgeHost: "127.0.0.1",
    bridgePort: 8766,
    pollTimeoutMs: 25000,
    callTimeoutMs: 30000
};
/** Apply Steam-bridge environment overrides on top of a config. */
function applyBridgeEnv(cfg) {
    const out = { ...cfg };
    const port = process.env.SWH_MCP_PORT?.trim();
    if (port && /^\d+$/.test(port))
        out.bridgePort = parseInt(port, 10);
    const host = process.env.SWH_MCP_HOST?.trim();
    if (host)
        out.bridgeHost = host;
    const callTimeout = process.env.SWH_MCP_CALL_TIMEOUT?.trim();
    if (callTimeout && /^\d+$/.test(callTimeout))
        out.callTimeoutMs = parseInt(callTimeout, 10);
    return out;
}
function loadConfig() {
    // The server runs from two different layouts and mcp-config sits at a different depth in each:
    // from source the entry is server/build/index.js (two levels down from the repo root), inside a
    // packed .mcpb it is server/index.js (one level down from the extension root). Checking both
    // is what makes the config.json that ships in the bundle actually get read - the previous
    // single hardcoded path resolved above the root in either layout, so this always fell through
    // to the defaults below and the packaged config was dead weight.
    const candidates = [
        path.join(__dirname, "..", "..", "mcp-config", "config.json"), // source: server/build -> repo root
        path.join(__dirname, "..", "mcp-config", "config.json"), // bundle: server -> extension root
        path.join(__dirname, "..", "..", "..", "mcp-config", "config.json"),
    ];
    for (const configPath of candidates) {
        if (!fs.existsSync(configPath)) {
            continue;
        }
        try {
            const fromFile = JSON.parse(fs.readFileSync(configPath, "utf-8"));
            // Merge rather than replace. The shipped mcp-config/config.json only carries the GitHub
            // identifiers, so returning it wholesale would leave rimworldPath, rimworldModsDir and
            // savedatafolder undefined and break the RimWorld tools.
            return applyBridgeEnv({ ...DEFAULT_CONFIG, ...fromFile });
        }
        catch (err) {
            // A malformed config should not stop the server from starting on the defaults.
            console.error(`Ignoring unreadable config at ${configPath}:`, err instanceof Error ? err.message : err);
        }
    }
    return applyBridgeEnv({ ...DEFAULT_CONFIG });
}
/**
 * The GitHub token, or an empty string when none is configured.
 *
 * This deliberately does not throw. The token is declared optional in manifest.json - the RimWorld
 * build, launch and log tools need nothing from GitHub - but this used to throw at module load,
 * which killed the entire server on any machine that had not set one up. A fresh install with the
 * token field left blank is the normal case, not an error, so the absence is reported per-call by
 * requireGitHubToken instead of at startup.
 */
function getGitHubToken() {
    // Env first: this is what manifest.json wires user_config.github_token into.
    const fromEnv = process.env.GITHUB_TOKEN?.trim();
    if (fromEnv) {
        return fromEnv;
    }
    const tokenFileCandidates = [
        path.join(__dirname, "..", "..", "github_token.txt"), // source: server/build -> repo root
        path.join(__dirname, "..", "github_token.txt"), // bundle: server -> extension root
    ];
    for (const tokenFilePath of tokenFileCandidates) {
        if (!fs.existsSync(tokenFilePath)) {
            continue;
        }
        try {
            const fileContent = fs.readFileSync(tokenFilePath, "utf-8");
            const tokenLine = fileContent.split("\n").find(line => line.startsWith("TOKEN="));
            if (tokenLine) {
                const token = tokenLine.slice("TOKEN=".length).trim();
                if (token) {
                    return token;
                }
            }
        }
        catch {
            // Fall through to the next candidate.
        }
    }
    // Last resort: reuse the gh CLI's authenticated token from the OS keyring, so
    // no plaintext token needs to be stored. No-op if gh is absent/not logged in.
    try {
        const out = (0, child_process_1.execSync)("gh auth token", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        if (out)
            return out;
    }
    catch {
        // gh not installed or not authenticated.
    }
    return "";
}
/** Throws a message the user can act on. Call this from tools that genuinely need GitHub. */
function requireGitHubToken(token, toolName) {
    if (!token) {
        throw new Error(`The '${toolName}' tool needs a GitHub token, and none is available. ` +
            `Log in with 'gh auth login' (reused from your keyring automatically), ` +
            `set the GITHUB_TOKEN environment variable, or add a PAT with 'repo' scope to github_token.txt. ` +
            `The RimWorld build, launch and log tools do not need one and will keep working without it.`);
    }
}
function loadRepoMap() {
    const candidates = [
        path.join(__dirname, "..", "..", "mcp-config", "repo-map.json"), // source: server/build -> repo root
        path.join(__dirname, "..", "mcp-config", "repo-map.json"), // bundle: server -> extension root
        path.join(__dirname, "..", "..", "..", "mcp-config", "repo-map.json"),
    ];
    for (const p of candidates) {
        if (!fs.existsSync(p))
            continue;
        try {
            const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
            return (parsed && parsed.items) || {};
        }
        catch (err) {
            console.error(`Ignoring unreadable repo-map at ${p}:`, err instanceof Error ? err.message : err);
        }
    }
    return {};
}
