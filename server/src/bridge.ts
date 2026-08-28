import * as http from "http";
import { MCPConfig } from "./config";

/*
 * Loopback bridge to the Steam Workshop Helper Chrome extension.
 * -------------------------------------------------------------
 * The extension is sandboxed and cannot read files off disk, so — unlike the
 * RimWorld game's file-drop IPC in rimsynapse — the local channel to a browser
 * has to be a socket. This binds to 127.0.0.1 only, so it is exactly as local
 * as a file: nothing is exposed to the network.
 *
 * Same request/response pattern as rimsynapse's gameIpc: a tool call enqueues
 * a command and waits for the matching result. Transport:
 *
 *   extension  --GET  /poll----> server   (long-poll; returns next command)
 *   extension  --POST /result--> server   ({ id, ok, result|error })
 *   extension  --GET  /health--> server   (liveness / connection state)
 *
 * The extension holds a long-poll open; when a tool call arrives the server
 * answers that poll with the command, the extension runs it against window.SWH
 * and POSTs the result back, which resolves the waiting tool call.
 */

interface Command {
  id: string;
  method: string;
  args: any;
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export interface Bridge {
  call(method: string, args: any): Promise<any>;
  status(): { owner: boolean; connected: boolean; queued: number; pending: number; lastPollAt: number };
  close(): Promise<void>;
}

export function startBridge(config: MCPConfig): Promise<Bridge> {
  const queue: Command[] = [];
  const pending = new Map<string, Pending>();
  // A poll response waiting for the next command (at most one useful at a time).
  let waitingPoll: { res: http.ServerResponse; timer: NodeJS.Timeout } | null = null;
  let lastPollAt = 0;
  let seq = 0;

  function nextId(): string {
    seq += 1;
    return `c${Date.now().toString(36)}_${seq}`;
  }

  function sendJson(res: http.ServerResponse, code: number, body: any) {
    const payload = JSON.stringify(body);
    res.writeHead(code, {
      "Content-Type": "application/json",
      // Extension host-permission already grants access; these are belt-and-braces.
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Cache-Control": "no-store",
    });
    res.end(payload);
  }

  // Hand the next queued command to a waiting poll, if both exist.
  function pump() {
    if (!waitingPoll || queue.length === 0) return;
    const cmd = queue.shift()!;
    const { res, timer } = waitingPoll;
    waitingPoll = null;
    clearTimeout(timer);
    sendJson(res, 200, { command: cmd });
  }

  function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk) => {
        data += chunk;
        if (data.length > 5_000_000) reject(new Error("body too large"));
      });
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = req.url || "/";

    if (req.method === "OPTIONS") {
      sendJson(res, 204, {});
      return;
    }

    if (req.method === "GET" && url.startsWith("/health")) {
      sendJson(res, 200, {
        ok: true,
        server: "steam-workshop-helper-mcp",
        connected: Date.now() - lastPollAt < config.pollTimeoutMs + 5000,
        queued: queue.length,
        pending: pending.size,
      });
      return;
    }

    if (req.method === "GET" && url.startsWith("/poll")) {
      lastPollAt = Date.now();
      // Only one outstanding poll is useful; release any previous one empty.
      if (waitingPoll) {
        clearTimeout(waitingPoll.timer);
        try {
          sendJson(waitingPoll.res, 204, {});
        } catch {
          /* ignore */
        }
        waitingPoll = null;
      }
      const timer = setTimeout(() => {
        if (waitingPoll && waitingPoll.res === res) waitingPoll = null;
        try {
          sendJson(res, 204, {});
        } catch {
          /* ignore */
        }
      }, config.pollTimeoutMs);
      waitingPoll = { res, timer };
      res.on("close", () => {
        if (waitingPoll && waitingPoll.res === res) {
          clearTimeout(waitingPoll.timer);
          waitingPoll = null;
        }
      });
      pump();
      return;
    }

    if (req.method === "POST" && url.startsWith("/result")) {
      try {
        const body = await readBody(req);
        const parsed = JSON.parse(body || "{}");
        const p = pending.get(parsed.id);
        if (p) {
          clearTimeout(p.timer);
          pending.delete(parsed.id);
          if (parsed.ok) p.resolve(parsed.result);
          else p.reject(new Error(parsed.error || "extension reported an error"));
        }
        sendJson(res, 200, { ok: true });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: String(err instanceof Error ? err.message : err) });
      }
      return;
    }

    sendJson(res, 404, { ok: false, error: "not found" });
  });

  function call(method: string, args: any): Promise<any> {
    return new Promise((resolve, reject) => {
      // We can only serve SWH calls if THIS process owns the shared bridge port. Every session runs
      // its own MCP server, but the extension long-polls one fixed port, so only one server owns it.
      // A non-owner used to fail with a misleading "bridge not started" (bridge was null); now the
      // bridge object always exists and keeps trying to take the port, so say what's actually true.
      if (!owner) {
        reject(new Error(
          `The Steam Workshop bridge (${config.bridgeHost}:${config.bridgePort}) is currently owned by ` +
          `another RimAgentic session (or a stale MCP server). Only one session drives Steam Workshop at ` +
          `a time. Run swh_* from that session, or close it — this session takes over the port ` +
          `automatically within a few seconds of it freeing.`
        ));
        return;
      }
      const id = nextId();
      const timer = setTimeout(() => {
        pending.delete(id);
        const connected = Date.now() - lastPollAt < config.pollTimeoutMs + 5000;
        reject(
          new Error(
            connected
              ? `Timed out after ${config.callTimeoutMs}ms waiting for the extension to run SWH.${method}. ` +
                `Is a steamcommunity.com tab open and logged in? If this was a WRITE (post/edit/delete), ` +
                `it may have already been applied to Steam — these calls are not idempotent, so verify ` +
                `on the page before retrying rather than re-sending.`
              : `The Steam Workshop Helper extension is not connected to the local bridge ` +
                `(no poll seen on ${config.bridgeHost}:${config.bridgePort}). ` +
                `Load/reload the extension and open a steamcommunity.com tab.`
          )
        );
      }, config.callTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      queue.push({ id, method, args: args || {} });
      pump();
    });
  }

  function status() {
    return {
      owner,
      connected: owner && Date.now() - lastPollAt < config.pollTimeoutMs + 5000,
      queued: queue.length,
      pending: pending.size,
      lastPollAt,
    };
  }

  function close(): Promise<void> {
    return new Promise((resolve) => {
      if (bindTimer) { clearInterval(bindTimer); bindTimer = null; }
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new Error("bridge closing"));
      }
      pending.clear();
      if (owner) server.close(() => resolve());
      else resolve();
    });
  }

  // ---- Resilient binding ---------------------------------------------------
  // The old code bound once and rejected on EADDRINUSE, which left `bridge` null for the whole
  // session — so a server that lost the race (another session, or a stale server, held the port)
  // could never serve SWH, even after the port later freed. Instead: keep the bridge object alive
  // and RETRY the bind. When the current owner exits, a waiting session grabs the port within one
  // retry interval and its swh_* tools start working with no restart.
  let owner = false;
  let bindTimer: NodeJS.Timeout | null = null;
  const REBIND_MS = Number(process.env.SWH_MCP_REBIND_MS) > 0 ? Number(process.env.SWH_MCP_REBIND_MS) : 5000;

  function scheduleRebind() {
    if (bindTimer || owner) return;
    bindTimer = setInterval(tryBind, REBIND_MS);
    bindTimer.unref?.(); // never keep the process alive just to poll for the port
  }

  function tryBind() {
    if (owner) return;
    try { server.listen(config.bridgePort, config.bridgeHost); } catch { /* 'error' event handles it */ }
  }

  server.on("listening", () => {
    owner = true;
    if (bindTimer) { clearInterval(bindTimer); bindTimer = null; }
    console.error(`[swh-mcp] loopback bridge listening on http://${config.bridgeHost}:${config.bridgePort}`);
  });
  server.on("error", (err: any) => {
    owner = false;
    if (err?.code !== "EADDRINUSE") {
      console.error(`[swh-mcp] bridge listen error (${err?.code || "unknown"}): ${err?.message || err}`);
    }
    scheduleRebind(); // another owner holds it (or a transient error) — keep trying to take over
  });

  return new Promise((resolve) => {
    tryBind();
    resolve({ call, status, close });
  });
}
