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
  status(): { connected: boolean; queued: number; pending: number; lastPollAt: number };
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
      const id = nextId();
      const timer = setTimeout(() => {
        pending.delete(id);
        const connected = Date.now() - lastPollAt < config.pollTimeoutMs + 5000;
        reject(
          new Error(
            connected
              ? `Timed out after ${config.callTimeoutMs}ms waiting for the extension to run SWH.${method}. ` +
                `Is a steamcommunity.com tab open and logged in?`
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
      connected: Date.now() - lastPollAt < config.pollTimeoutMs + 5000,
      queued: queue.length,
      pending: pending.size,
      lastPollAt,
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
      console.error(
        `[swh-mcp] loopback bridge listening on http://${config.bridgeHost}:${config.bridgePort}`
      );
      resolve({ call, status, close });
    });
  });
}
