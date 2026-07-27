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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const child_process_1 = require("child_process");
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const app = (0, express_1.default)();
app.use(express_1.default.json());
// Serve static assets from public folder
const publicDir = path.join(__dirname, "..", "public");
app.use(express_1.default.static(publicDir));
let mcpProcess = null;
let mcpPid = null;
let mcpPort = 3000;
let lastActivity = null;
let logs = [];
// Helper to log to both manager console and UI logs
function logMessage(msg) {
    const timestamp = new Date().toLocaleTimeString();
    const formatted = "[" + timestamp + "] " + msg;
    console.log(formatted);
    logs.push(formatted);
    if (logs.length > 1000) {
        logs.shift();
    }
}
// Check if a process is alive by PID on Windows
function isPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        return false;
    }
}
// Kill process tree on Windows using taskkill
function killProcessTree(pid) {
    logMessage("Attempting to terminate process tree for PID: " + pid);
    try {
        (0, child_process_1.exec)("taskkill /F /T /PID " + pid, (err, stdout, stderr) => {
            if (err) {
                logMessage("Taskkill error: " + err.message);
            }
            if (stdout) {
                logMessage("Taskkill stdout: " + stdout.trim());
            }
            if (stderr) {
                logMessage("Taskkill stderr: " + stderr.trim());
            }
        });
    }
    catch (e) {
        logMessage("Exception during taskkill: " + e.message);
    }
}
// Find and kill any process using the specified port
function killPortOwner(port) {
    logMessage("Checking for existing processes on port: " + port);
    try {
        (0, child_process_1.exec)("netstat -ano", (err, stdout) => {
            if (err) {
                return;
            }
            const lines = stdout.split("\n");
            for (const line of lines) {
                if (line.includes(":" + port)) {
                    const parts = line.trim().split(/\s+/);
                    const pidStr = parts[parts.length - 1];
                    const pid = parseInt(pidStr, 10);
                    if (pid > 0) {
                        if (pid !== process.pid) {
                            logMessage("Found process " + pid + " using port " + port + ". Killing it...");
                            killProcessTree(pid);
                        }
                    }
                }
            }
        });
    }
    catch (e) {
        logMessage("Exception finding port owner: " + e.message);
    }
}
// Attempt to recover PID from saved file on startup
const pidFile = path.join(__dirname, "..", "mcp_server_pid.txt");
if (fs.existsSync(pidFile)) {
    try {
        const savedPidStr = fs.readFileSync(pidFile, "utf-8").trim();
        const savedPid = parseInt(savedPidStr, 10);
        if (savedPid > 0) {
            if (isPidAlive(savedPid)) {
                mcpPid = savedPid;
                logMessage("Recovered running server process on PID " + mcpPid);
            }
        }
    }
    catch (e) {
        // Ignore parsing errors
    }
}
// CORS headers
app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    next();
});
// GET status endpoint
app.get("/api/manager/status", (req, res) => {
    let running = false;
    if (mcpPid !== null) {
        if (isPidAlive(mcpPid)) {
            running = true;
        }
    }
    res.json({
        running: running,
        pid: mcpPid,
        port: mcpPort,
        lastActivity: lastActivity,
        logsCount: logs.length
    });
});
// POST activity endpoint (called by MCP server)
app.post("/api/manager/activity", (req, res) => {
    lastActivity = Date.now();
    res.json({ success: true });
});
// GET logs endpoint
app.get("/api/manager/logs", (req, res) => {
    res.json({ logs: logs });
});
// POST launch endpoint
app.post("/api/manager/launch", async (req, res) => {
    const requestedPort = parseInt(req.body.port, 10) || 3000;
    mcpPort = requestedPort;
    // Check if already running
    if (mcpPid !== null) {
        if (isPidAlive(mcpPid)) {
            res.json({ success: true, message: "Already running", pid: mcpPid });
            return;
        }
    }
    logMessage("Starting build and launch sequence...");
    // Ensure node_modules exists, compile files
    const serverDir = path.join(__dirname, "..");
    // Copy node.exe to localMCP.exe to show custom name in Windows Task Manager
    const localExePath = path.join(serverDir, "localMCP.exe");
    if (!fs.existsSync(localExePath)) {
        try {
            logMessage("Copying node executable to custom localMCP.exe...");
            fs.copyFileSync(process.execPath, localExePath);
            logMessage("Copy successful.");
        }
        catch (e) {
            logMessage("Warning: Failed to copy node executable: " + e.message);
        }
    }
    // Force terminate anything on target port first
    killPortOwner(mcpPort);
    // Compile TypeScript
    (0, child_process_1.exec)("npm run build", {
        cwd: serverDir,
        env: {
            ...process.env,
            PATH: "C:\\Program Files\\nodejs;" + process.env.PATH
        }
    }, (buildErr, buildStdout, buildStderr) => {
        if (buildErr) {
            logMessage("Compilation FAILED:\n" + buildStderr);
            res.status(500).json({ success: false, error: "Compilation failed: " + buildStderr });
            return;
        }
        logMessage("Compilation completed successfully.");
        // Spawn localMCP.exe
        const exeToRun = fs.existsSync(localExePath) ? localExePath : process.execPath;
        logMessage("Spawning MCP Server using: " + path.basename(exeToRun));
        const child = (0, child_process_1.spawn)(exeToRun, ["build/index.js", "--sse", "--port", mcpPort.toString()], {
            cwd: serverDir,
            env: {
                ...process.env,
                PATH: "C:\\Program Files\\nodejs;" + process.env.PATH,
                PORT: mcpPort.toString()
            }
        });
        mcpProcess = child;
        mcpPid = child.pid || null;
        if (mcpPid !== null) {
            fs.writeFileSync(pidFile, mcpPid.toString(), "utf-8");
            logMessage("MCP Server spawned with PID: " + mcpPid);
        }
        // Stream output to logs
        child.stdout?.on("data", (data) => {
            const lines = data.toString().split("\n");
            for (const line of lines) {
                if (line.trim()) {
                    logMessage("[STDOUT] " + line.trim());
                }
            }
        });
        child.stderr?.on("data", (data) => {
            const lines = data.toString().split("\n");
            for (const line of lines) {
                if (line.trim()) {
                    logMessage("[STDERR] " + line.trim());
                }
            }
        });
        child.on("close", (code) => {
            logMessage("MCP Server exited with code: " + code);
            mcpPid = null;
            mcpProcess = null;
            try {
                if (fs.existsSync(pidFile)) {
                    fs.unlinkSync(pidFile);
                }
            }
            catch (e) { }
        });
        res.json({ success: true, pid: mcpPid });
    });
});
// POST stop endpoint
app.post("/api/manager/stop", (req, res) => {
    logMessage("Force stopping MCP Server...");
    // Kill child if running
    if (mcpPid !== null) {
        killProcessTree(mcpPid);
        mcpPid = null;
    }
    // Force kill port owner just in case
    killPortOwner(mcpPort);
    // Remove pid file
    try {
        if (fs.existsSync(pidFile)) {
            fs.unlinkSync(pidFile);
        }
    }
    catch (e) { }
    mcpProcess = null;
    logMessage("MCP Server force stop sequence completed.");
    res.json({ success: true });
});
// Start the Manager on port 4001
const managerPort = 4001;
app.listen(managerPort, () => {
    console.log("Local MCP Manager running on http://localhost:" + managerPort);
});
