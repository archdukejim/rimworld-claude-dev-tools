import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
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
 *   peer MCP   --POST /call----> server   ({ method, args } — relay, see below)
 *
 * The extension holds a long-poll open; when a tool call arrives the server
 * answers that poll with the command, the extension runs it against window.SWH
 * and POSTs the result back, which resolves the waiting tool call.
 *
 * Multi-session: owner + proxies
 * ------------------------------
 * Every Claude session runs its own MCP server process, but only ONE process
 * can bind the bridge port — and the extension only ever talks to that one.
 * connectBridge() makes this cooperative instead of broken: the first process
 * to bind becomes the OWNER; every other process gets a PROXY bridge that
 * relays its calls to the owner over POST /call. The owner serialises all
 * sessions' commands through a single queue, so agents no longer step on each
 * other. If the owner process exits, the next proxy to place a call promotes
 * itself to owner by binding the freed port.
 *
 * Serialised dispatch, loss detection, and replay
 * -----------------------------------------------
 * Only one command is ever in-flight at a time; queued commands wait their
 * turn (queue grace QUEUE_GRACE_MS, then a per-command exec timeout that only
 * starts once the command is actually handed to the extension). If the
 * extension reconnects (a fresh /poll while a command is in-flight), the
 * delivery is treated as lost: idempotent commands are silently re-queued at
 * the front, but non-idempotent ones (postComment, deleteComment) are failed
 * immediately with a "may have executed" error — the extension's MV3 worker
 * can die AFTER the page-context call fired, so replaying those could
 * double-post to Steam.
 */

interface Command {
  id: string;
  method: string;
  args: any;
  // Delivery attempts that were lost to an extension reconnect and replayed.
  lostDeliveries?: number;
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

export interface BridgeStatus {
  connected: boolean;
  queued: number;
  pending: number;
  lastPollAt: number;
  mode: "owner" | "proxy";
}

export interface Bridge {
  call(method: string, args: any): Promise<any>;
  status(): Promise<BridgeStatus>;
  close(): Promise<void>;
}

// Methods safe to transparently re-deliver after a lost delivery: reads,
// navigation, and absolute writes that converge when run twice. Everything NOT
// on this list — postComment above all, plus any future method — fails fast
// instead, because the extension keeps no executed-command ledger and its MV3
// worker can die AFTER the page-context Steam call already fired.
const REPLAY_SAFE_METHODS = new Set([
  "getAuth",
  "getContext",
  "resolveMeta",
  "listComments",
  "getNotifications",
  "reviewNotifications",
  "getItem",
  "openItem",
  "tabsInventory",
  "tabsTidy",
  "updateDescription",
  "updateTitle",
]);

// How long a command may sit queued behind other sessions' commands before we
// give up (separate from the exec timeout, which starts at dispatch). The env
// override exists for the test suite; production uses the default.
const QUEUE_GRACE_MS = Number(process.env.SWH_MCP_QUEUE_GRACE_MS) > 0
  ? Number(process.env.SWH_MCP_QUEUE_GRACE_MS)
  : 60_000;

/*
 * /call authentication. The bridge deliberately serves permissive CORS on
 * /poll//result//health (the extension needs it), which means a malicious web
 * page in ANY local browser could pass a preflight and POST to this port. For
 * /poll//result the worst case is snooping/forging extension traffic, but
 * /call would be direct command injection into the user's logged-in Steam
 * session. So /call (and only /call): rejects any request carrying an Origin
 * header (browsers always attach one to cross-origin POSTs; our Node peers
 * never do), emits no CORS headers, and requires a shared secret that lives in
 * a file under %LOCALAPPDATA% — readable by peer MCP processes, unreachable
 * from a browser.
 */
function callSecretPath(): string {
  const local = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local");
  return path.join(local, "RimAgentic", "bridge-call-secret.txt");
}

/** Owner side: return the existing secret or mint one. */
function ensureCallSecret(): string {
  const p = callSecretPath();
  try {
    const existing = fs.readFileSync(p, "utf8").trim();
    if (existing) return existing;
  } catch {
    /* missing — mint below */
  }
  const secret = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, secret, { mode: 0o600 });
  } catch {
    /* if the write fails the proxy read will also fail and /call stays closed */
  }
  return secret;
}

/** Proxy side: read the secret the owner published, or null. */
function readCallSecret(): string | null {
  try {
    const s = fs.readFileSync(callSecretPath(), "utf8").trim();
    return s || null;
  } catch {
    return null;
  }
}

export function startBridge(config: MCPConfig): Promise<Bridge> {
  const queue: Command[] = [];
  const pending = new Map<string, Pending>();
  const callSecret = ensureCallSecret();
  // The command currently sent to the extension, awaiting /result.
  let inflight: Command | null = null;
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

  // Hand the next queued command to a waiting poll, if both exist and nothing is in-flight.
  function pump() {
    if (inflight) return;           // stay serial: one command at a time
    if (!waitingPoll) return;       // no open poll to deliver on
    if (queue.length === 0) return; // nothing to send
    const cmd = queue.shift()!;
    const p = pending.get(cmd.id);
    if (!p) return pump(); // caller already timed out in the queue — skip it
    inflight = cmd;
    // Swap the queue-grace timer for the real exec timeout now that the
    // command is actually on its way to the extension.
    clearTimeout(p.timer);
    p.timer = setTimeout(() => {
      pending.delete(cmd.id);
      if (inflight && inflight.id === cmd.id) {
        inflight = null;
        pump();
      }
      p.reject(
        new Error(
          `Timed out after ${config.callTimeoutMs}ms waiting for the extension to run SWH.${cmd.method}. ` +
            `Is a steamcommunity.com tab open and logged in?`
        )
      );
    }, config.callTimeoutMs);
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

  function statusBody(): BridgeStatus {
    return {
      connected: Date.now() - lastPollAt < config.pollTimeoutMs + 5000,
      queued: queue.length,
      pending: pending.size,
      lastPollAt,
      mode: "owner",
    };
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
        // Capability marker: pre-relay builds don't send this, which is how
        // connectBridge detects a stale server owning the port.
        relay: true,
        ...statusBody(),
        inflight: inflight?.id ?? null,
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
      // A fresh poll while a command is in-flight means the extension's worker
      // restarted and the delivery (or its result) was lost. Idempotent
      // commands are replayed at the front of the queue; non-idempotent ones
      // fail fast — the side effect may already have happened.
      if (inflight) {
        const lost = inflight;
        inflight = null;
        lost.lostDeliveries = (lost.lostDeliveries || 0) + 1;
        // Cap replays: an extension that crash-loops on a command must not keep
        // it in flight forever (each re-dispatch resets the exec timer).
        if (!REPLAY_SAFE_METHODS.has(lost.method) || lost.lostDeliveries > 3) {
          const p = pending.get(lost.id);
          if (p) {
            clearTimeout(p.timer);
            pending.delete(lost.id);
            p.reject(
              new Error(
                !REPLAY_SAFE_METHODS.has(lost.method)
                  ? `The extension reconnected while SWH.${lost.method} was in flight, so its outcome is unknown — ` +
                    `it MAY have executed. Verify (e.g. listComments) before retrying; do not blindly re-send.`
                  : `SWH.${lost.method} was delivered ${lost.lostDeliveries} times but the extension reconnected ` +
                    `each time without answering — it may be crash-looping on this command.`
              )
            );
          }
        } else {
          queue.unshift(lost);
        }
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
        // Clear inflight before resolving so pump() can dispatch the next command.
        if (inflight && inflight.id === parsed.id) {
          inflight = null;
        }
        const p = pending.get(parsed.id);
        if (p) {
          clearTimeout(p.timer);
          pending.delete(parsed.id);
          if (parsed.ok) p.resolve(parsed.result);
          else p.reject(new Error(parsed.error || "extension reported an error"));
        }
        sendJson(res, 200, { ok: true });
        pump(); // dispatch the next queued command if any
      } catch (err) {
        sendJson(res, 400, { ok: false, error: String(err instanceof Error ? err.message : err) });
      }
      return;
    }

    // Relay endpoint for peer MCP server processes that lost the bind race:
    // they forward their swh_*/tab calls here and share this owner's queue.
    // Locked down against browsers — see the callSecret block above.
    if (req.method === "POST" && url.startsWith("/call")) {
      const plain = (code: number, bodyObj: any) => {
        // Deliberately NO CORS headers on this route.
        const payload = JSON.stringify(bodyObj);
        res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(payload);
      };
      if (req.headers.origin !== undefined) {
        plain(403, { ok: false, error: "browser-originated /call rejected" });
        return;
      }
      if (!callSecret || req.headers["x-bridge-secret"] !== callSecret) {
        plain(403, { ok: false, error: "missing or wrong x-bridge-secret" });
        return;
      }
      try {
        const body = await readBody(req);
        const parsed = JSON.parse(body || "{}");
        if (!parsed || typeof parsed.method !== "string") {
          plain(400, { ok: false, error: "expected { method, args }" });
          return;
        }
        try {
          const result = await call(parsed.method, parsed.args || {});
          plain(200, { ok: true, result });
        } catch (err) {
          plain(200, { ok: false, error: String(err instanceof Error ? err.message : err) });
        }
      } catch (err) {
        plain(400, { ok: false, error: String(err instanceof Error ? err.message : err) });
      }
      return;
    }

    sendJson(res, 404, { ok: false, error: "not found" });
  });

  // /call requests can legitimately be held open for queue-grace + exec time;
  // keep Node's per-request timeout above that so relays aren't cut off early.
  server.requestTimeout = QUEUE_GRACE_MS + config.callTimeoutMs + 30_000;

  function call(method: string, args: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = nextId();
      const entry: Pending = {
        resolve,
        reject,
        method,
        // Queue-grace timer: fires only if the command never got dispatched
        // (pump() swaps it for the exec timeout at dispatch).
        timer: setTimeout(() => {
          pending.delete(id);
          const idx = queue.findIndex((c) => c.id === id);
          if (idx >= 0) queue.splice(idx, 1);
          const connected = Date.now() - lastPollAt < config.pollTimeoutMs + 5000;
          reject(
            new Error(
              connected
                ? `Gave up after ${Math.round(QUEUE_GRACE_MS / 1000)}s queued behind other bridge commands ` +
                  `(other agent sessions share this extension bridge; commands run one at a time).`
                : `The Steam Workshop Helper extension is not connected to the local bridge ` +
                  `(no poll seen on ${config.bridgeHost}:${config.bridgePort}). ` +
                  `Load/reload the extension and open a steamcommunity.com tab.`
            )
          );
        }, QUEUE_GRACE_MS),
      };
      pending.set(id, entry);
      queue.push({ id, method, args: args || {} });
      pump();
    });
  }

  function status(): Promise<BridgeStatus> {
    return Promise.resolve(statusBody());
  }

  function close(): Promise<void> {
    return new Promise((resolve) => {
      inflight = null;
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new Error("bridge closing"));
      }
      pending.clear();
      queue.length = 0;
      // Release the extension's open long-poll so the server can actually close.
      if (waitingPoll) {
        clearTimeout(waitingPoll.timer);
        try {
          sendJson(waitingPoll.res, 204, {});
        } catch {
          /* ignore */
        }
        waitingPoll = null;
      }
      server.close(() => resolve());
      // Keep-alive sockets (extension fetch / proxy relays) would otherwise
      // hold the port for minutes and stall a successor's promotion.
      if (typeof (server as any).closeIdleConnections === "function") {
        (server as any).closeIdleConnections();
      }
    });
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.bridgePort, config.bridgeHost, () => {
      server.removeListener("error", reject);
      console.error(
        `[swh-mcp] loopback bridge listening on http://${config.bridgeHost}:${config.bridgePort} (owner)`
      );
      resolve({ call, status, close });
    });
  });
}

// ---------------------------------------------------------------------------
// Proxy mode: relay through whichever process owns the port, and promote
// ourselves to owner if that process goes away.
// ---------------------------------------------------------------------------

function httpJson(
  config: MCPConfig,
  method: "GET" | "POST",
  urlPath: string,
  body: any,
  timeoutMs: number
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string | number> = payload
      ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
      : {};
    if (urlPath.startsWith("/call")) {
      const secret = readCallSecret();
      if (secret) headers["x-bridge-secret"] = secret;
    }
    const req = http.request(
      {
        host: config.bridgeHost,
        port: config.bridgePort,
        path: urlPath,
        method,
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode || 0, json: data ? JSON.parse(data) : {} });
          } catch (err) {
            reject(new Error(`bridge relay: unparseable response (${String(err)})`));
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("bridge relay: request timed out")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Is this a "nobody is listening there" error (owner died), as opposed to an
 *  error the owner itself returned? */
function isConnectionError(err: any): boolean {
  const code = err?.code || "";
  return code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EPIPE";
}

/** ECONNREFUSED means the request NEVER reached the owner, so re-sending it is
 *  always safe. ECONNRESET/EPIPE can hit AFTER the dying owner already handed
 *  the command to the extension — re-sending those is only safe for
 *  replay-safe methods. */
function neverDelivered(err: any): boolean {
  return err?.code === "ECONNREFUSED";
}

function startProxyBridge(config: MCPConfig): Bridge {
  // When the owner dies we try to take over its role; after promotion this
  // proxy delegates everything to its own owned bridge.
  let promoted: Bridge | null = null;

  async function promoteOrRetry(): Promise<"promoted" | "retaken" | "gone"> {
    try {
      promoted = await startBridge(config);
      console.error("[swh-mcp] previous bridge owner exited — promoted this process to owner");
      return "promoted";
    } catch {
      // Lost the promotion race to another proxy — the port is served again.
      try {
        const h = await httpJson(config, "GET", "/health", undefined, 2000);
        if (h.json?.server === "steam-workshop-helper-mcp") return "retaken";
      } catch {
        /* fall through */
      }
      return "gone";
    }
  }

  async function call(method: string, args: any): Promise<any> {
    if (promoted) return promoted.call(method, args);
    const timeoutMs = QUEUE_GRACE_MS + config.callTimeoutMs + 15_000;
    try {
      const resp = await httpJson(config, "POST", "/call", { method, args }, timeoutMs);
      if (resp.json?.ok) return resp.json.result;
      throw new Error(resp.json?.error || `bridge relay failed (HTTP ${resp.status})`);
    } catch (err) {
      if (!isConnectionError(err)) throw err;
      // Restore service for future calls regardless of what we do with THIS one.
      const outcome = await promoteOrRetry();
      // A reset mid-request may have happened after the dying owner already
      // dispatched the command — auto re-send only when the request provably
      // never arrived (refused) or the method converges when run twice.
      const resendable = neverDelivered(err) || REPLAY_SAFE_METHODS.has(method);
      if (!resendable) {
        throw new Error(
          `The bridge owner exited while SWH.${method} was in flight, so its outcome is unknown — ` +
            `it MAY have executed. Verify (e.g. listComments) before retrying; do not blindly re-send.`
        );
      }
      if (outcome === "promoted") return promoted!.call(method, args);
      if (outcome === "retaken") {
        const resp = await httpJson(config, "POST", "/call", { method, args }, timeoutMs);
        if (resp.json?.ok) return resp.json.result;
        throw new Error(resp.json?.error || `bridge relay failed (HTTP ${resp.status})`);
      }
      throw new Error(
        `The bridge owner process exited and the port could not be re-bound. ` +
          `Retry the call; the next attempt will re-negotiate ownership.`
      );
    }
  }

  async function status(): Promise<BridgeStatus> {
    if (promoted) return promoted.status();
    try {
      const h = await httpJson(config, "GET", "/health", undefined, 2000);
      return {
        connected: !!h.json?.connected,
        queued: h.json?.queued ?? 0,
        pending: h.json?.pending ?? 0,
        lastPollAt: h.json?.lastPollAt ?? 0,
        mode: "proxy",
      };
    } catch {
      return { connected: false, queued: 0, pending: 0, lastPollAt: 0, mode: "proxy" };
    }
  }

  async function close(): Promise<void> {
    if (promoted) await promoted.close();
  }

  return { call, status, close };
}

/**
 * Bind the bridge port as owner, or — if another MCP server process already
 * owns it — return a proxy that relays through that owner. Throws only when
 * the port is held by something that is NOT one of ours.
 */
export async function connectBridge(config: MCPConfig): Promise<Bridge> {
  try {
    return await startBridge(config);
  } catch (err: any) {
    if (err?.code !== "EADDRINUSE") throw err;
    // Verify the squatter is actually a relay-capable peer before proxying to
    // it. Probe twice: an owner briefly wedged in a synchronous child process
    // (execSync taskkill etc.) can miss a single 3s probe.
    let h = await httpJson(config, "GET", "/health", undefined, 3000).catch(() => null);
    if (!h) {
      await new Promise((r) => setTimeout(r, 2000));
      h = await httpJson(config, "GET", "/health", undefined, 3000).catch(() => null);
    }
    if (h?.json?.server !== "steam-workshop-helper-mcp") {
      throw new Error(
        `Port ${config.bridgeHost}:${config.bridgePort} is in use by something that is not a ` +
          `RimAgentic bridge — swh_*/tab tools disabled in this session. (${err.message})`
      );
    }
    if (h.json?.relay !== true) {
      throw new Error(
        `Port ${config.bridgePort} is owned by a STALE server build with no relay support ` +
          `(pre-/call). Kill the old 'node server/build/index.js' process and restart this ` +
          `session so the new build can own or relay the bridge.`
      );
    }
    console.error(
      `[swh-mcp] bridge port ${config.bridgePort} owned by a peer MCP process — relaying via proxy`
    );
    return startProxyBridge(config);
  }
}
