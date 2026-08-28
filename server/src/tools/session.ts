import * as fs from "fs";
import * as path from "path";
import { loadConfig, getSaveDataFolder } from "../config";
import { resolveModLoadOrder, fingerprintModlist } from "./testing";
import { handleTestingTool } from "./testing";
import { handleRimworldDevTool } from "./rimworldDev";
import { rimworldRunning } from "../gameWatchdog";
import {
  resolveSessionId,
  pinSession,
  getSessionConfig,
  setSessionConfig,
  readLiveMarker,
  writeLiveMarker,
  SessionConfig,
} from "../sessionContext";

/*
 * Session-stateful, modlist-aware game front door (Layer 1.5).
 * -----------------------------------------------------------
 * Sits on top of Layer 1's FIFO lease. A session declares the modlist it wants (cached per session,
 * ungated), and `ensure_game` — gated, so it runs one session at a time in FIFO order — guarantees
 * the game is up with THAT modlist, dynamically REBUILT every time from a known clean template
 * (mandatory base + the session's mods) so it can never drift. If the running game already has this
 * session's modlist, it is reused; otherwise the game is brought down, ModsConfig scrubbed and
 * rewritten from the clean build, and the game relaunched — the takeover the owner described.
 */

// The mandatory clean base every modlist is regenerated on top of. Base game + Harmony + the toolkit
// bridge (which force-loads last). Their presence is what the launch gate and the in-game tool
// channel depend on, so they are never optional. configure_active_mods also injects the base game,
// but stating the whole template here is what makes "built from a known clean template" true.
const CLEAN_BASE = ["brrainz.harmony", "ludeon.rimworld", "archdukejim.rimagentic"];
const DLC_IDS: Record<string, string> = {
  royalty: "ludeon.rimworld.royalty",
  ideology: "ludeon.rimworld.ideology",
  biotech: "ludeon.rimworld.biotech",
  anomaly: "ludeon.rimworld.anomaly",
  odyssey: "ludeon.rimworld.odyssey",
};

/** The pid file launch_rimworld writes the spawned game's PID to (server root, shared across sessions). */
function pidFilePath(): string {
  return path.join(__dirname, "..", "..", "dev_instance_pid.txt");
}
function readLaunchedPid(): number | null {
  try {
    const n = parseInt(fs.readFileSync(pidFilePath(), "utf8").trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Regenerate a session's full active-mod list from the clean template. Pure: reads About.xml via the
 * shared resolver, writes nothing. Returns the resolved load order plus what's wrong with it
 * (uninstalled ids, missing hard deps) so callers can preview before launching.
 */
export function buildSessionActiveMods(cfg: SessionConfig, config: { rimworldModsDir?: string }) {
  const set = new Set<string>(CLEAN_BASE.map((m) => m.toLowerCase()));
  for (const d of cfg.dlcs) {
    const id = DLC_IDS[d.toLowerCase()];
    if (id) set.add(id);
  }
  for (const m of cfg.mods) set.add(m.trim().toLowerCase());
  const { resolved, uninstalled, missingDependencies, cycles } = resolveModLoadOrder([...set], config);
  return { activeMods: resolved, uninstalled, missingDependencies, cycles };
}

export const sessionTools = [
  {
    name: "use_session",
    description:
      "Pin this MCP server process to a Claude session/worktree id (the hex id in your SessionStart " +
      "worktree path, e.g. 'd2029542'). This keys your cached modlist so it survives the server being " +
      "rebuilt/respawned. Usually inferred automatically from worktree paths on game tools, but call " +
      "this once at the start (or after a rebuild) to be explicit. Ungated.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string", description: "Your worktree/session id (hex, e.g. d2029542)." } },
      required: ["sessionId"],
    },
  },
  {
    name: "set_session_modlist",
    description:
      "Declare the modlist THIS session wants, cached per session. Does NOT touch the game — it only " +
      "records intent; ensure_game applies it under the FIFO lease. The mandatory clean base (base " +
      "game, Harmony, the RimAgentic toolkit bridge) is always added, so pass only your content mods " +
      "in `mods` and any DLC in `dlcs`. Returns the full active list this will build, in load order, " +
      "flagging any uninstalled ids or missing hard dependencies. Ungated.",
    inputSchema: {
      type: "object",
      properties: {
        mods: { type: "array", items: { type: "string" }, description: "Content-mod packageIds to activate (clean base is added automatically)." },
        dlcs: { type: "array", items: { type: "string" }, description: "DLC short names to enable: royalty, ideology, biotech, anomaly, odyssey." },
        sessionId: { type: "string", description: "Override the resolved session id (normally inferred/pinned)." },
      },
      required: ["mods"],
    },
  },
  {
    name: "get_session_modlist",
    description:
      "Show this session's cached modlist and the full active list it would build (from the clean " +
      "template), in load order. Ungated, read-only.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string", description: "Override the resolved session id." } },
    },
  },
  {
    name: "ensure_game",
    description:
      "Guarantee RimWorld is running with THIS session's cached modlist, rebuilt from the clean " +
      "template. Gated by the FIFO game lease. If the live game already has this session's modlist it " +
      "is reused (no restart); otherwise the running game is closed, ModsConfig scrubbed and rewritten " +
      "from the clean build, and the game relaunched. Call it before driving the game with " +
      "execute_game_tool. Set dryRun to preview the plan without touching the game.",
    inputSchema: {
      type: "object",
      properties: {
        quicktest: { type: "boolean", description: "Launch straight into a quicktest map (default true unless loadSave is given)." },
        loadSave: { type: ["string", "boolean"], description: "Resume a save slot by name, or true for the newest save." },
        forceRelaunch: { type: "boolean", description: "Relaunch even if the live game already matches this session's modlist. Default false." },
        dryRun: { type: "boolean", description: "Return the plan (built modlist + reuse/relaunch decision) without touching the game." },
        sessionId: { type: "string", description: "Override the resolved session id." },
      },
    },
  },
];

function text(payload: any) {
  return { content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) }] };
}

export async function handleSessionTool(name: string, args: any) {
  const config = loadConfig();

  if (name === "use_session") {
    const id = pinSession(args.sessionId);
    return text(`Session pinned: ${id}. Your cached modlist and live-game checks now key off this id.`);
  }

  if (name === "set_session_modlist") {
    const id = resolveSessionId(args, { required: true })!;
    const saved = setSessionConfig(id, { mods: args.mods || [], dlcs: args.dlcs || [] });
    const built = buildSessionActiveMods(saved, config);
    return text({
      session: id,
      cached: { mods: saved.mods, dlcs: saved.dlcs },
      builtActiveMods: built.activeMods,
      uninstalled: built.uninstalled,
      missingDependencies: built.missingDependencies,
      note: "Cached only — nothing launched. Call ensure_game to apply it under the FIFO lease.",
    });
  }

  if (name === "get_session_modlist") {
    const id = resolveSessionId(args, { required: true })!;
    const cfg = getSessionConfig(id);
    if (!cfg) return text({ session: id, cached: null, note: "No modlist declared yet — set one with set_session_modlist." });
    const built = buildSessionActiveMods(cfg, config);
    return text({ session: id, cached: { mods: cfg.mods, dlcs: cfg.dlcs, updatedAt: cfg.updatedAt }, builtActiveMods: built.activeMods, uninstalled: built.uninstalled, missingDependencies: built.missingDependencies });
  }

  if (name === "ensure_game") {
    const id = resolveSessionId(args, { required: true })!;
    const cfg = getSessionConfig(id) || { mods: [], dlcs: [] };
    const built = buildSessionActiveMods(cfg, config);
    const fp = fingerprintModlist(built.activeMods);
    const savedata = config.savedatafolder || getSaveDataFolder();
    const live = readLiveMarker();
    const running = rimworldRunning();

    const canReuse = running && !!live && live.sessionId === id && live.fingerprint === fp && !args.forceRelaunch;
    const decision = canReuse ? "reuse" : running ? "takeover-relaunch" : "cold-launch";

    if (args.dryRun) {
      return text({
        session: id, decision, forceRelaunch: !!args.forceRelaunch,
        gameRunning: running, live: live ? { sessionId: live.sessionId, fingerprint: live.fingerprint } : null,
        targetFingerprint: fp, builtActiveMods: built.activeMods,
        uninstalled: built.uninstalled, missingDependencies: built.missingDependencies,
      });
    }

    if (canReuse) {
      return text(`Game already up for session ${id} with the current modlist (${built.activeMods.length} mods) — reused, no relaunch.`);
    }

    // Takeover: scrub + rewrite ModsConfig from the clean build (overwrite is a full replace, not a
    // drift-prone merge), then launch — killExisting brings down whatever game was running.
    // configure_active_mods is not GitHub-backed, so the octokit/token/projectId params are unused
    // here — pass placeholders (cast because the shared handler types octokit as non-optional).
    const cfgRes: any = await handleTestingTool(
      "configure_active_mods",
      { activeMods: built.activeMods, savedatafolder: savedata },
      undefined as any, config.organization, undefined as any, undefined as any
    );
    if (cfgRes?.isError) {
      return { isError: true, content: [{ type: "text", text: `ensure_game: modlist is not sound, nothing launched.\n${cfgRes.content?.[0]?.text || ""}` }] };
    }

    const launchRes: any = await handleRimworldDevTool("launch_rimworld", {
      quicktest: args.quicktest,
      loadSave: args.loadSave,
      savedatafolder: savedata,
    });

    writeLiveMarker({ sessionId: id, fingerprint: fp, pid: readLaunchedPid(), at: Date.now() });

    const launchText = launchRes?.content?.[0]?.text || "";
    return {
      isError: !!launchRes?.isError,
      content: [{
        type: "text",
        text: `ensure_game for session ${id}: ${decision} with ${built.activeMods.length} mods (rebuilt from clean template).\n\n${launchText}`,
      }],
    };
  }

  throw new Error(`Unknown session tool: ${name}`);
}

/** ensure_game holds the game lease (takeover relaunch); the others are ungated cache ops. */
export const SESSION_LEASE_TOOLS = new Set<string>(["ensure_game"]);
