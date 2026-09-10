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
 *   sibling    --POST /call----> server   ({ method, args } -> { ok, result|error })
 *
 * The extension holds a long-poll open; when a tool call arrives the server
 * answers that poll with the command, the extension runs it against window.SWH
 * and POSTs the result back, which resolves the waiting tool call.
 *
 * ONE PORT, MANY SERVERS. Every Claude session runs its own MCP server, and the extension
 * polls exactly one port (8766). Only the first server to start can bind it — the OWNER.
 * Every later server used to fail `listen` with EADDRINUSE, leave `bridge` null, and report
 * "bridge not started" for the rest of its life, so the swh_* tools looked permanently broken
 * even though the extension was happily connected to a sibling process. Now a later server
 * becomes a PROXY: it forwards `call()` to the owner's POST /call and mirrors the owner's
 * /health. If the port is held by something that is not one of ours, the bridge is
 * UNAVAILABLE and says so — and the swh_* tools take the DevTools route (steamCdp.ts).
 */

export const BRIDGE_SERVER_NAME = "steam-workshop-helper-mcp";

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

export type BridgeMode = "owner" | "proxy" | "unavailable";

export interface BridgeStatus {
  mode: BridgeMode;
  /** True when the extension has polled the OWNER recently (whichever process that is). */
  connected: boolean;
  queued: number;
  pending: number;
  lastPollAt: number;
  endpoint: string;
  /** Human explanation of the mode — this is what chrome_status shows. */
  note: string;
}

export interface Bridge {
  readonly mode: BridgeMode;
  call(method: string, args: any): Promise<any>;
  status(): BridgeStatus;
  /** Re-read the owner's /health (proxy) — owner/unavailable resolve immediately. */
  refresh(): Promise<BridgeStatus>;
  close(): Promise<void>;
}

/** How the extension is meant to reach us — the doc string every "not connected" error points at. */
export const BRIDGE_HOWTO =
  "The extension's service worker long-polls http://127.0.0.1:8766/poll on its own (no toggle needed unless " +
  "it was switched off in the extension popup). It reaches the FIRST MCP server that bound the port; later " +
  "servers proxy to it. If nothing is connected: run launch_chrome (it re-installs the extension), then " +
  "chrome_status — and if the owner is a stale build, kill the old `node server/build/index.js` processes.";

const endpointOf = (config: MCPConfig) => `http://${config.bridgeHost}:${config.bridgePort}`;

async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = 2500): Promise<{ status: number; body: any } | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    const txt = await res.text();
    let body: any = null;
    try { body = JSON.parse(txt); } catch { body = { raw: txt }; }
    return { status: res.status, body };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Never throws: returns an owner, a proxy to the owner, or an "unavailable" bridge that explains why. */
export async function startBridge(config: MCPConfig): Promise<Bridge> {
  const endpoint = endpointOf(config);
  try {
    return await listenAsOwner(config);
  } catch (err: any) {
    if (err?.code !== "EADDRINUSE") {
      return unavailableBridge(endpoint, `failed to listen on ${endpoint}: ${err?.message || err}`);
    }
    const health = await fetchJson(`${endpoint}/health`);
    if (health?.body?.server === BRIDGE_SERVER_NAME) return proxyBridge(config, health.body);
    return unavailableBridge(
      endpoint,
      `port ${endpoint} is held by something that is not a RimAgentic bridge ` +
        (health ? `(its /health answered ${JSON.stringify(health.body).slice(0, 120)})` : "(no /health answer)") +
        ". Free the port or set SWH_MCP_BRIDGE_PORT."
    );
  }
}

// ---------------------------------------------------------------------------- owner

function listenAsOwner(config: MCPConfig): Promise<Bridge> {
  const endpoint = endpointOf(config);
  const queue: Command[] = [];
  const pending = new Map<string, Pending>();
  // A poll response waiting for the next command (at most one useful at a time).
  let waitingPoll: { res: http.ServerResponse; timer: NodeJS.Timeout } | null = null;
  let lastPollAt = 0;
  let seq = 0;

  const connected = () => Date.now() - lastPollAt < config.pollTimeoutMs + 5000;

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

  function call(method: string, args: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = nextId();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new Error(
            connected()
              ? `Timed out after ${config.callTimeoutMs}ms waiting for the extension to run SWH.${method}. ` +
                `Is a steamcommunity.com tab open and logged in?`
              : `The Steam Workshop Helper extension is not connected to the local bridge ` +
                `(no poll seen on ${endpoint}). ${BRIDGE_HOWTO}`
          )
        );
      }, config.callTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      queue.push({ id, method, args: args || {} });
      pump();
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
        server: BRIDGE_SERVER_NAME,
        mode: "owner",
        pid: process.pid,
        connected: connected(),
        queued: queue.length,
        pending: pending.size,
        lastPollAt,
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

    // A sibling MCP server (proxy mode) asking us to run a command on its behalf.
    if (req.method === "POST" && url.startsWith("/call")) {
      try {
        const body = await readBody(req);
        const parsed = JSON.parse(body || "{}");
        if (!parsed.method) throw new Error("`method` is required");
        const result = await call(String(parsed.method), parsed.args || {});
        sendJson(res, 200, { ok: true, result });
      } catch (err) {
        sendJson(res, 200, { ok: false, error: String(err instanceof Error ? err.message : err) });
      }
      return;
    }

    sendJson(res, 404, { ok: false, error: "not found" });
  });

  function status(): BridgeStatus {
    const c = connected();
    return {
      mode: "owner",
      connected: c,
      queued: queue.length,
      pending: pending.size,
      lastPollAt,
      endpoint,
      note: c
        ? `this server owns ${endpoint}; the extension is polling it`
        : `this server owns ${endpoint} but the extension has not polled it (last poll ${lastPollAt ? new Date(lastPollAt).toISOString() : "never"}). ${BRIDGE_HOWTO}`,
    };
  }

  function close(): Promise<void> {
    return new Promise((resolve) => {
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new Error("bridge closing"));
      }
      pending.clear();
      server.close(() => resolve());
    });
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.bridgePort, config.bridgeHost, () => {
      server.removeListener("error", reject);
      console.error(`[swh-mcp] loopback bridge listening on ${endpoint}`);
      resolve({ mode: "owner", call, status, refresh: async () => status(), close });
    });
  });
}

// ---------------------------------------------------------------------------- proxy

function proxyBridge(config: MCPConfig, initialHealth: any): Bridge {
  const endpoint = endpointOf(config);
  let last: BridgeStatus = fromHealth(initialHealth);
  let lastAt = Date.now();

  function fromHealth(h: any | null): BridgeStatus {
    if (!h) {
      return {
        mode: "proxy", connected: false, queued: 0, pending: 0, lastPollAt: 0, endpoint,
        note: `the MCP server that owned ${endpoint} stopped answering /health — restart this server so it can take the port over`,
      };
    }
    return {
      mode: "proxy",
      connected: !!h.connected,
      queued: Number(h.queued) || 0,
      pending: Number(h.pending) || 0,
      lastPollAt: Number(h.lastPollAt) || 0,
      endpoint,
      note:
        `proxying to the MCP server (pid ${h.pid ?? "unknown"}) that owns ${endpoint}; ` +
        (h.connected ? "the extension is polling it" : `the extension is NOT polling it. ${BRIDGE_HOWTO}`),
    };
  }

  async function refresh(): Promise<BridgeStatus> {
    const h = await fetchJson(`${endpoint}/health`);
    last = fromHealth(h?.body?.server === BRIDGE_SERVER_NAME ? h.body : null);
    lastAt = Date.now();
    return last;
  }

  function status(): BridgeStatus {
    if (Date.now() - lastAt > 5000) void refresh();
    return last;
  }

  async function call(method: string, args: any): Promise<any> {
    const r = await fetchJson(
      `${endpoint}/call`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method, args: args || {} }) },
      config.callTimeoutMs + 5000
    );
    if (!r) throw new Error(`The MCP server that owns ${endpoint} did not answer POST /call (gone, or the call timed out). ${BRIDGE_HOWTO}`);
    if (r.status === 404) {
      throw new Error(
        `The MCP server that owns ${endpoint} is an older build without POST /call. Kill the stale ` +
          `\`node server/build/index.js\` processes so a current build can take the port, or use the DevTools route.`
      );
    }
    if (!r.body?.ok) throw new Error(String(r.body?.error || `owner returned HTTP ${r.status}`));
    return r.body.result;
  }

  console.error(`[swh-mcp] ${endpoint} already owned by pid ${initialHealth?.pid ?? "?"}; proxying bridge calls to it`);
  return { mode: "proxy", call, status, refresh, close: async () => {} };
}

// ---------------------------------------------------------------------------- unavailable

function unavailableBridge(endpoint: string, why: string): Bridge {
  console.error(`[swh-mcp] loopback bridge unavailable: ${why}`);
  const st: BridgeStatus = { mode: "unavailable", connected: false, queued: 0, pending: 0, lastPollAt: 0, endpoint, note: why };
  return {
    mode: "unavailable",
    call: async () => { throw new Error(`Steam loopback bridge unavailable: ${why}`); },
    status: () => st,
    refresh: async () => st,
    close: async () => {},
  };
}
