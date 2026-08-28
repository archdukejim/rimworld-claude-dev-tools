import * as fs from "fs";
import * as path from "path";

/*
 * Per-session identity + modlist cache (Layer 1.5).
 * -------------------------------------------------
 * Each Claude session runs its own MCP server process, but Claude Code exposes NO session id to
 * MCP servers (only CLAUDECODE=1 and CLAUDE_PROJECT_DIR, which is shared across sessions on one
 * repo — so a hook-written session_id.txt would race). The stable key we DO have is the session's
 * git worktree short-id (e.g. `d2029542`), and the agent hands it to us implicitly on every
 * path-bearing game call (deploy sources from `...\worktrees\<repo>\<id>\...`, its branch is
 * `agent/<id>`).
 *
 * So: infer the worktree id from tool-call paths, PIN it to this process, and persist the
 * session's cached modlist on disk keyed by that id. The cache therefore survives the MCP server
 * being killed and respawned (the rebuild gotcha) — the next path-bearing call re-infers the same
 * id and re-attaches. `use_session` lets the agent pin/override it explicitly. Two sessions =
 * two processes each inferring their own id: no shared file, no race.
 */

const HEX_ID = /[0-9a-f]{6,40}/i;

/** Root under which sessions/ and live-session.json live. Co-located with the lease (one env
 *  override moves both, and keeps tests isolated): the parent of RIMAGENTIC_LEASE_DIR when set,
 *  else %LOCALAPPDATA%\RimAgentic. */
function rootDir(): string {
  const env = process.env.RIMAGENTIC_LEASE_DIR;
  if (env) return path.dirname(env);
  return path.join(
    process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local"),
    "RimAgentic"
  );
}

function baseDir(): string {
  const sessions = path.join(rootDir(), "sessions");
  try { fs.mkdirSync(sessions, { recursive: true }); } catch { /* best effort */ }
  return sessions;
}

function liveMarkerPath(): string {
  return path.join(rootDir(), "live-session.json");
}

// ---- Identity ---------------------------------------------------------------
let pinned: string | null = null;

/** Explicitly pin this process's session id (the `use_session` tool). Normalised to hex. */
export function pinSession(id: string): string {
  const norm = String(id || "").trim().toLowerCase().replace(/[^0-9a-f]/g, "");
  if (!norm) throw new Error("use_session: a worktree/session id (hex, e.g. d2029542) is required.");
  pinned = norm;
  return pinned;
}

/** Every string value in an args object (shallow-recursive), so path patterns are tested against
 *  RAW strings — not a JSON.stringify, which would double Windows backslashes and break the match. */
function stringValues(v: any, out: string[] = [], depth = 0): string[] {
  if (depth > 5 || v == null) return out;
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringValues(x, out, depth + 1);
  else if (typeof v === "object") for (const k of Object.keys(v)) stringValues(v[k], out, depth + 1);
  return out;
}

/** Best-effort inference of the worktree short-id from any path-like values in a tool's args. */
export function inferSessionId(args: any): string | null {
  for (const s of stringValues(args)) {
    // `.../worktrees/<repo>/<id>/...` (the canonical worktree layout) or an `agent/<id>` branch ref.
    const wt = /worktrees[\\/][^\\/]+[\\/]([0-9a-f]{6,40})(?=[\\/]|$)/i.exec(s);
    if (wt) return wt[1].toLowerCase();
    const branch = /(?:^|[\s\\/])agent[\\/]([0-9a-f]{6,40})(?=[\s\\/]|$)/i.exec(s);
    if (branch) return branch[1].toLowerCase();
  }
  return null;
}

/**
 * Resolve this process's session id: an explicit `sessionId` arg wins, else the pinned id, else
 * inference from the args (which also pins it for later id-less calls). Returns null when
 * unresolvable and `required` is false; throws a guiding error when `required`.
 */
export function resolveSessionId(args: any, opts: { required?: boolean } = {}): string | null {
  if (args && typeof args.sessionId === "string" && args.sessionId.trim()) return pinSession(args.sessionId);
  if (pinned) return pinned;
  const inferred = inferSessionId(args);
  if (inferred) { pinned = inferred; return inferred; }
  if (opts.required) {
    throw new Error(
      "No session identity resolved. Call use_session with your worktree id first (the id in your " +
      "SessionStart worktree path, e.g. use_session { sessionId: \"d2029542\" }), or pass sessionId " +
      "in this call. It is inferred automatically from worktree paths on tools like deploy_rimworld_mods."
    );
  }
  return null;
}

/** The currently pinned id, or null. */
export function currentSessionId(): string | null {
  return pinned;
}

// ---- Modlist cache ----------------------------------------------------------
export interface SessionConfig {
  /** Content mods the session wants active (packageIds). The mandatory clean base is added by the builder. */
  mods: string[];
  /** DLC short names to enable (royalty, ideology, biotech, anomaly, odyssey). */
  dlcs: string[];
  updatedAt?: number;
}

function sessionFile(id: string): string {
  return path.join(baseDir(), `session-${id}.json`);
}

/** Read a session's cached modlist config, or null if it has never declared one. */
export function getSessionConfig(id: string): SessionConfig | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionFile(id), "utf8"));
    return {
      mods: Array.isArray(parsed.mods) ? parsed.mods : [],
      dlcs: Array.isArray(parsed.dlcs) ? parsed.dlcs : [],
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return null;
  }
}

/** Persist a session's cached modlist config (atomic write). */
export function setSessionConfig(id: string, cfg: { mods: string[]; dlcs?: string[] }): SessionConfig {
  const out: SessionConfig = {
    mods: Array.from(new Set((cfg.mods || []).map((m) => String(m).trim()).filter(Boolean))),
    dlcs: Array.from(new Set((cfg.dlcs || []).map((d) => String(d).trim().toLowerCase()).filter(Boolean))),
    updatedAt: Date.now(),
  };
  const file = sessionFile(id);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2), "utf8");
  fs.renameSync(tmp, file);
  return out;
}

// ---- Live-game marker (which session's modlist is currently launched) --------
export interface LiveMarker {
  sessionId: string;
  fingerprint: string;
  pid: number | null;
  at: number;
}

/** Which session's modlist the running game was launched with, or null. Shared across sessions. */
export function readLiveMarker(): LiveMarker | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(liveMarkerPath(), "utf8"));
    if (parsed && typeof parsed.sessionId === "string") return parsed as LiveMarker;
  } catch {
    /* none */
  }
  return null;
}

export function writeLiveMarker(m: LiveMarker): void {
  const file = liveMarkerPath();
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(m, null, 2), "utf8");
    fs.renameSync(tmp, file);
  } catch { /* best effort */ }
}

export function clearLiveMarker(): void {
  try { fs.unlinkSync(liveMarkerPath()); } catch { /* already gone */ }
}
