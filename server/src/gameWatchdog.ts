import { execSync } from "child_process";
import { requestInGameSave } from "./tools/gameIpc";

/**
 * Idle watchdog for launched RimWorld dev instances.
 *
 * The launch tools (`launch_rimworld`, `launch_quicktest`) spawn RimWorld detached and never stop
 * it. Once the driving agent goes idle — no more tool calls, no more telemetry reads — the game
 * keeps running unattended. Left overnight the colony starves and every pawn dies, and the box
 * burns CPU/GPU the whole time.
 *
 * This arms an in-process timer when the game is launched. Every MCP tool call counts as activity
 * (the agent is still working the loop). If no tool call arrives for the idle window, the watchdog
 * closes RimWorld. A tool call is the right liveness signal: the game is only useful while
 * something is driving it, and when the session ends the calls simply stop.
 *
 * The MCP server process is long-lived and shared across every tool call, so a single in-process
 * `setInterval` is all this needs — no cross-process bookkeeping.
 */

const IMAGE = "RimWorldWin64.exe";

function envInt(name: string, def: number): number {
    const v = process.env[name]?.trim();
    if (v && /^\d+$/.test(v)) return parseInt(v, 10);
    return def;
}

// Minutes of no-tool-call inactivity before the game is closed. 0 disables the idle guard.
const DEFAULT_IDLE_MIN = envInt("RIMAGENTIC_GAME_IDLE_TIMEOUT_MIN", 30);
// Absolute lifetime backstop regardless of activity. 0 disables it (default: off).
const DEFAULT_MAX_LIFETIME_MIN = envInt("RIMAGENTIC_GAME_MAX_LIFETIME_MIN", 0);
// Save slot the watchdog checkpoints to before closing an idle game, so the session can be resumed
// (launch_rimworld loadSave: "<name>"). Empty disables autosave — the game is then just closed.
const DEFAULT_AUTOSAVE_NAME =
    (process.env.RIMAGENTIC_IDLE_AUTOSAVE_NAME ?? "RimAgentic_idle_autosave").trim();
const POLL_MS = 60_000;

interface WatchState {
    timer: NodeJS.Timeout;
    pid: number | null;
    launchedAt: number;
    idleMs: number;
    maxLifetimeMs: number;
    autosaveName: string;
    closing: boolean;
}

let state: WatchState | null = null;
let lastActivity = Date.now();

/** Bump the activity clock. Called on every MCP tool call. Cheap and always safe to call. */
export function noteGameActivity(): void {
    lastActivity = Date.now();
}

function rimworldRunning(): boolean {
    try {
        const out = execSync(
            `powershell -NoProfile -Command "(Get-Process -Name RimWorldWin64 -ErrorAction SilentlyContinue | Measure-Object).Count"`,
            { encoding: "utf8" }
        );
        return (parseInt(String(out).trim(), 10) || 0) > 0;
    } catch { return false; }
}

function killGame(pid: number | null): void {
    try {
        if (pid && pid > 0) execSync(`taskkill /f /pid ${pid}`, { stdio: "ignore" });
    } catch { /* already gone */ }
    // Backstop: close any instance by image name too (orphans, or an unresolved pid).
    try { execSync(`taskkill /f /im ${IMAGE}`, { stdio: "ignore" }); } catch { /* none running */ }
}

/** Stand down: clear the timer and forget the tracked game. Safe to call when not armed. */
export function disarmGameWatchdog(): void {
    if (state) {
        clearInterval(state.timer);
        state = null;
    }
}

export interface ArmOptions {
    pid?: number | null;
    /** Minutes of inactivity before the game is closed. Omit to use the configured default; 0 disables. */
    idleTimeoutMin?: number;
    /** Absolute lifetime cap regardless of activity. Omit to use the configured default; 0 disables. */
    maxLifetimeMin?: number;
    /** Save slot to checkpoint to before closing. Omit for the configured default; "" disables autosave. */
    autosaveName?: string;
}

/**
 * Checkpoint (best-effort) then close the game. The autosave goes through the in-game bridge, so it
 * only lands when a live colony is up — a game idling at the menu simply times out and is closed.
 */
async function closeGame(reason: string, st: WatchState): Promise<void> {
    if (st.autosaveName) {
        const saved = await requestInGameSave(st.autosaveName, 15_000);
        console.error(saved
            ? `[rwdt] Idle watchdog: autosaved '${st.autosaveName}' before closing (resume with loadSave: "${st.autosaveName}").`
            : `[rwdt] Idle watchdog: autosave did not confirm (game may be at the menu) — closing anyway.`);
    }
    console.error(`[rwdt] Idle watchdog: ${reason} — closing RimWorld.`);
    killGame(st.pid);
    disarmGameWatchdog();
}

/**
 * Arm (or re-arm) the watchdog for a freshly launched game. The launch itself counts as activity,
 * so the idle clock starts now. Re-arming replaces any previous guard — the launch tools enforce a
 * single dev instance at a time, so there is only ever one game to watch.
 *
 * Returns a one-line summary for the launch log (empty guidance included when disabled).
 */
export function armGameWatchdog(opts: ArmOptions = {}): string {
    const idleMin = opts.idleTimeoutMin ?? DEFAULT_IDLE_MIN;
    const maxMin = opts.maxLifetimeMin ?? DEFAULT_MAX_LIFETIME_MIN;

    disarmGameWatchdog();
    noteGameActivity();

    if (idleMin <= 0 && maxMin <= 0) {
        return "Idle watchdog disabled — the game will run until closed manually.\n";
    }

    const idleMs = idleMin > 0 ? idleMin * 60_000 : Infinity;
    const maxLifetimeMs = maxMin > 0 ? maxMin * 60_000 : Infinity;
    const launchedAt = Date.now();
    const autosaveName = (opts.autosaveName ?? DEFAULT_AUTOSAVE_NAME).trim();

    const timer = setInterval(() => {
        const st = state;
        // Not armed, already closing, or the game is gone — nothing to do (stand down if it's gone).
        if (!st || st.closing) return;
        if (!rimworldRunning()) { disarmGameWatchdog(); return; }

        const now = Date.now();
        const idleFor = now - lastActivity;
        const aliveFor = now - launchedAt;

        let reason: string | null = null;
        if (idleFor >= idleMs) reason = `no activity for ${Math.round(idleFor / 60000)} min`;
        else if (aliveFor >= maxLifetimeMs) reason = `max lifetime ${Math.round(aliveFor / 60000)} min reached`;

        if (reason) {
            // Guard against a second tick firing during the async autosave (save budget < poll interval).
            st.closing = true;
            void closeGame(reason, st);
        }
    }, POLL_MS);
    // The watchdog must never be the sole reason the process stays alive.
    timer.unref?.();

    state = { timer, pid: opts.pid ?? null, launchedAt, idleMs, maxLifetimeMs, autosaveName, closing: false };

    const parts: string[] = [];
    if (idleMin > 0) parts.push(`closes after ${idleMin} min idle`);
    if (maxMin > 0) parts.push(`hard cap ${maxMin} min`);
    if (autosaveName) parts.push(`autosaves to '${autosaveName}' first`);
    return `Idle watchdog armed (${parts.join(", ")}) so the game won't run unattended overnight.\n`;
}
