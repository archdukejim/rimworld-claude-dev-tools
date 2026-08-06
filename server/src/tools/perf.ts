import * as fs from "fs";
import * as path from "path";

/**
 * Layer 3 of the performance harness: a host-side baseline store + impact verdict.
 *
 * The benchmark itself runs in-game (perf_benchmark_start/status, via execute_game_tool). The agent
 * captures a baseline ONCE per scenario+fingerprint (the mod-under-test OFF) and reuses it, then on
 * every playtest runs the same scenario with the mod ON and calls perf_impact to get the tick-time
 * delta and a plain verdict — so "how much does my mod cost the game" is answered without re-capturing
 * baselines each time. Baselines are hardware/version specific, so they live on this machine keyed by
 * a caller-supplied fingerprint (game version + the other active mods); perf_impact flags a mismatch.
 */
function localAppData(): string {
    return process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local");
}
const baselineFile = () => path.join(localAppData(), "RimAgentic", "perf", "baselines.json");

function loadStore(): Record<string, any> {
    try { return JSON.parse(fs.readFileSync(baselineFile(), "utf8")); } catch { return {}; }
}
function saveStore(store: Record<string, any>) {
    const f = baselineFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(store, null, 2));
}
const keyOf = (scenarioId: string, fingerprint: string) => `${scenarioId}::${fingerprint || "default"}`;
const round = (n: number, d: number) => { const p = Math.pow(10, d); return Math.round(n * p) / p; };

/** Pull the standardized tick metrics out of a perf_benchmark result (accepts the result or its status wrapper). */
function extractMetrics(result: any): any | null {
    if (!result || typeof result !== "object") return null;
    const r = result.tickMs ? result : (result.result && result.result.tickMs ? result.result : null);
    if (!r || !r.tickMs) return null;
    return {
        avgMs: r.tickMs.avg, p95Ms: r.tickMs.p95, maxMs: r.tickMs.max,
        tps: r.tps, measuredTicks: r.measuredTicks, map: r.map || null, gc: r.gc || null
    };
}

function verdict(baseAvg: number, testAvg: number) {
    const absMs = testAvg - baseAvg;
    const pct = baseAvg > 0 ? (absMs / baseAvg) * 100 : 0;
    let level: string;
    if (absMs <= 0.05) level = "none";              // faster or within noise
    else if (pct < 3 || absMs < 0.1) level = "negligible";
    else if (pct < 10) level = "minor";
    else if (pct < 25) level = "moderate";
    else level = "heavy";
    return { level, absMsPerTick: round(absMs, 3), pctSlower: round(pct, 1) };
}

export const perfTools = [
    {
        name: "perf_baseline_save",
        description:
            "Store an in-game benchmark result as the BASELINE for a scenario (capture this once, with the " +
            "mod-under-test OFF). Pass the scenarioId (from perf_scenario_build, e.g. 'TropicalRainforest_late'), " +
            "the benchmark result object (from perf_benchmark_status), and a fingerprint identifying the baseline " +
            "context (game version + the other active mods) so a later run can tell if the baseline is stale. " +
            "Reused by perf_impact so you don't recapture baselines every playtest.",
        inputSchema: {
            type: "object",
            properties: {
                scenarioId: { type: "string", description: "e.g. 'TemperateForest_early'." },
                result: { type: "object", description: "The perf_benchmark result (or its status wrapper)." },
                fingerprint: { type: "string", description: "Baseline context id: game version + other active mods (default 'default')." }
            },
            required: ["scenarioId", "result"]
        }
    },
    {
        name: "perf_baseline_list",
        description: "List stored performance baselines (scenarioId, fingerprint, avg ms/tick, when captured). Read-only.",
        inputSchema: { type: "object", properties: {} }
    },
    {
        name: "perf_impact",
        description:
            "Compare a fresh in-game benchmark result (mod-under-test ON) against the stored baseline for the same " +
            "scenarioId+fingerprint, and return the performance impact: the tick-time delta (absolute ms/tick and " +
            "percent slower) plus a plain verdict (none/negligible/minor/moderate/heavy). This is the 'how much does " +
            "my mod cost the game' answer. Flags a fingerprint mismatch (stale baseline) and tells you to recapture " +
            "if the game version or other mods changed. Errors if no baseline exists yet for the scenario.",
        inputSchema: {
            type: "object",
            properties: {
                scenarioId: { type: "string", description: "Must match the baseline's scenarioId." },
                result: { type: "object", description: "The mod-ON perf_benchmark result (or its status wrapper)." },
                fingerprint: { type: "string", description: "The current context id (default 'default'); compared to the baseline's." }
            },
            required: ["scenarioId", "result"]
        }
    }
];

export async function handlePerfTool(name: string, args: any) {
    if (name === "perf_baseline_save") {
        const scenarioId = String(args?.scenarioId || "").trim();
        const fingerprint = String(args?.fingerprint || "default");
        if (!scenarioId) return errText("scenarioId is required.");
        const metrics = extractMetrics(args?.result);
        if (!metrics) return errText("Could not read tick metrics from 'result' — pass the object returned by perf_benchmark_status (it must contain tickMs).");
        const store = loadStore();
        store[keyOf(scenarioId, fingerprint)] = { scenarioId, fingerprint, capturedAt: new Date().toISOString(), metrics };
        try { saveStore(store); } catch (e: any) { return errText(`Failed to save baseline: ${e?.message || e}`); }
        return okText({ ok: true, scenarioId, fingerprint, baseline: metrics, file: baselineFile() });
    }

    if (name === "perf_baseline_list") {
        const store = loadStore();
        const rows = Object.values(store).map((b: any) => ({
            scenarioId: b.scenarioId, fingerprint: b.fingerprint,
            avgMs: b.metrics?.avgMs, p95Ms: b.metrics?.p95Ms, capturedAt: b.capturedAt
        }));
        return okText({ count: rows.length, baselines: rows, file: baselineFile() });
    }

    if (name === "perf_impact") {
        const scenarioId = String(args?.scenarioId || "").trim();
        const fingerprint = String(args?.fingerprint || "default");
        if (!scenarioId) return errText("scenarioId is required.");
        const test = extractMetrics(args?.result);
        if (!test) return errText("Could not read tick metrics from 'result' — pass the perf_benchmark_status object (with tickMs).");
        const store = loadStore();
        const base = store[keyOf(scenarioId, fingerprint)] || Object.values(store).find((b: any) => b.scenarioId === scenarioId);
        if (!base) return errText(`No baseline for scenario '${scenarioId}'. Capture one first: run the same scenario with the mod OFF, then perf_baseline_save.`);

        const v = verdict(base.metrics.avgMs, test.avgMs);
        const fingerprintMatch = base.fingerprint === fingerprint;
        return okText({
            scenarioId,
            fingerprintMatch,
            baseline: { avgMs: base.metrics.avgMs, p95Ms: base.metrics.p95Ms, capturedAt: base.capturedAt, fingerprint: base.fingerprint },
            test: { avgMs: test.avgMs, p95Ms: test.p95Ms },
            impact: v,
            summary: `Mod impact on '${scenarioId}': ${v.level} (+${v.absMsPerTick} ms/tick, ${v.pctSlower}% slower than baseline).`,
            note: fingerprintMatch ? undefined
                : "Fingerprint differs from the baseline (game version or other mods changed) — the baseline may be stale; recapture with the mod OFF to be sure."
        });
    }

    throw new Error(`Unknown perf tool: ${name}`);
}

function okText(obj: any) { return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] }; }
function errText(msg: string) { return { content: [{ type: "text", text: msg }] }; }
