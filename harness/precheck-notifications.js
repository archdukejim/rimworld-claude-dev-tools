/*
 * Cheap, no-LLM precheck for the comment-triage runner.
 * ----------------------------------------------------
 * Spends ZERO API tokens. Decides whether there's actually new comment activity
 * before the runner pays to invoke `claude`.
 *
 * How: spawn the merged MCP server (stdio), let the already-running dedicated
 * Chrome's extension connect to its 127.0.0.1 bridge, then call the read-only
 * tools swh_get_notifications + swh_list_comments to find the newest comment id
 * (from anyone other than the item owner) across the notification feed. Compare
 * that high-water mark to mcp-config/triage-lastseen.json.
 *
 * Exit codes (consumed by run-triage.ps1):
 *   0  -> NEW activity: run the agent
 *   10 -> nothing new: skip (no tokens spent)
 *   20 -> unavailable (Steam logged out / bridge down / error): skip
 *
 * Always writes the freshly-observed max to mcp-config/.triage-currentmax.json;
 * the runner promotes it to triage-lastseen.json only after a successful agent run.
 */
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const OWNER = process.env.SWH_OWNER_NAME || "archdukejim"; // comments by the owner don't count as "new"
const PORT = process.env.SWH_MCP_PORT || "8766";
const serverEntry = path.join(__dirname, "..", "server", "build", "index.js");
const mcpConfigDir = path.join(__dirname, "..", "mcp-config");
const lastSeenFile = path.join(mcpConfigDir, "triage-lastseen.json");
const currentMaxFile = path.join(mcpConfigDir, ".triage-currentmax.json");

function log(msg) { process.stderr.write(`[precheck] ${msg}\n`); }

const child = spawn(process.execPath, [serverEntry], {
  cwd: path.dirname(serverEntry),
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, SWH_MCP_PORT: PORT },
});
let buf = "";
const pending = new Map();
let nextId = 1;
child.stdout.on("data", (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line.startsWith("{")) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});
child.on("error", () => finish(20));

function rpc(method, params, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
    pending.set(id, { resolve: (m) => { clearTimeout(timer); resolve(m); } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
async function callTool(name, args) {
  const res = await rpc("tools/call", { name, arguments: args || {} });
  if (res.error) throw new Error(res.error.message || "tool error");
  const text = res.result && res.result.content && res.result.content[0] && res.result.content[0].text;
  return text ? JSON.parse(text) : null;
}

let done = false;
function finish(code) {
  if (done) return;
  done = true;
  try { child.kill(); } catch {}
  setTimeout(() => process.exit(code), 300); // give the port a moment to free
}

async function main() {
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "precheck", version: "1.0.0" },
  });

  let notif;
  try {
    notif = await callTool("swh_get_notifications", {});
  } catch (e) {
    log(`notifications unavailable: ${e.message}`);
    return finish(20);
  }
  const items = (notif && notif.notifications || []).filter((n) => n.fileId && n.isOwnItem);
  if (!items.length) {
    log("feed empty — nothing to triage");
    // still record a (null) max so we don't loop; treat as "none"
    return finish(10);
  }

  let maxId = 0n;
  for (const it of items) {
    let list;
    try {
      list = await callTool("swh_list_comments", { fileId: it.fileId, count: 10 });
    } catch (e) {
      log(`list_comments failed for ${it.fileId}: ${e.message}`);
      return finish(20);
    }
    for (const c of (list && list.comments) || []) {
      if (c.author === OWNER) continue;
      try { const id = BigInt(c.id); if (id > maxId) maxId = id; } catch {}
    }
  }

  let lastMax = 0n;
  try {
    if (fs.existsSync(lastSeenFile)) {
      const j = JSON.parse(fs.readFileSync(lastSeenFile, "utf-8"));
      if (j && j.maxCommentId) lastMax = BigInt(j.maxCommentId);
    }
  } catch {}

  try {
    if (!fs.existsSync(mcpConfigDir)) fs.mkdirSync(mcpConfigDir, { recursive: true });
    fs.writeFileSync(currentMaxFile, JSON.stringify({ maxCommentId: maxId.toString() }));
  } catch (e) { log(`could not write currentmax: ${e.message}`); }

  if (maxId > lastMax) {
    log(`NEW activity (max ${maxId} > last ${lastMax}) — running triage`);
    return finish(0);
  }
  log(`no new comments (max ${maxId} <= last ${lastMax}) — skipping`);
  return finish(10);
}

main().catch((e) => { log(`error: ${e.message}`); finish(20); });
// hard safety timeout
setTimeout(() => { log("hard timeout"); finish(20); }, 90000);
