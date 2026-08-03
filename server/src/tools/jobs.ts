import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { buildStage, runStage } from "./rimworldDev";
import { resolveModLoadOrder } from "./testing";
import { loadConfig } from "../config";

/**
 * In-process async job broker. Test runs are submitted without blocking (submit returns a
 * job_id immediately), and a single background worker drains them **serially** — because only
 * one RimWorld instance can run at a time (GPU/VRAM, one game window). Each job gets its own
 * pinned savedatafolder so configs and logs never collide (the isolation the shared-global
 * bugs came from). runTestCycle is already config-explicit, so the worker just hands it a
 * per-job folder.
 *
 * Embedded in the MCP server (long-lived per session) rather than a standalone daemon: the
 * single-modder product has one client, so a shared cross-client queue isn't needed. If
 * multi-session sharing is ever required, promote this to a daemon behind the same tools.
 */

// pending → building → (build fail ⇒ failed) → queued → running → done|failed ; cancelled from
// pending/queued. Two lanes: builds run concurrently (a pool), game runs strictly serially.
type JobStatus = "pending" | "building" | "queued" | "running" | "done" | "failed" | "cancelled";

interface Job {
    id: string;
    status: JobStatus;
    request: { repo?: string; mods?: string[]; timeoutSec?: number };
    pinned: { savedatafolder: string; activeMods?: string[] };
    build?: any;      // build-stage result, carried into the run stage
    result?: any;
    error?: string;
    cancelRequested?: boolean;   // set by cancel_job while running; the run worker honors it
    submittedAt: number;
    startedAt?: number;   // build start
    finishedAt?: number;
}

const jobs = new Map<string, Job>();
const buildQueue: string[] = [];   // waiting to build
const runQueue: string[] = [];     // built OK, waiting for the one game (serial lane)
let buildWorkerRunning = false;
let runWorkerRunning = false;
let counter = 0;

// Two independent serial workers form a PIPELINE: builds serialize (build.ps1 builds in place
// in the shared workspace, and mods share dependencies like Core — concurrent builds would
// corrupt each other's obj/), and game runs serialize (one RimWorld at a time). Because the
// workers are independent, a build overlaps a game run — the real win, since the game run is
// the long pole. True parallel *independent* builds would need per-build source isolation
// (git worktree / copy), a future opt-in coupled to the build-in-place harness.

function jobsRoot(): string {
    const local = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local");
    return path.join(local, "RimAgentic", "jobs");
}

/** Atomically write the job's state to disk so get_job survives a server restart. */
function persist(job: Job): void {
    try {
        const dir = path.join(jobsRoot(), job.id);
        fs.mkdirSync(dir, { recursive: true });
        const tmp = path.join(dir, "job.json.tmp");
        fs.writeFileSync(tmp, JSON.stringify(job, null, 2), "utf8");
        fs.renameSync(tmp, path.join(dir, "job.json"));
    } catch { /* best effort — the in-memory record is authoritative while the server lives */ }
}

function summarize(job: Job) {
    return {
        job_id: job.id, status: job.status, repo: job.request.repo,
        submittedAt: job.submittedAt, finishedAt: job.finishedAt, error: job.error
    };
}

/** Write a pinned ModsConfig.xml into the job's savedatafolder (its exact modlist, in order). */
function writePinnedModsConfig(savedatafolder: string, activeMods: string[]): void {
    const dir = path.join(savedatafolder, "Config");
    fs.mkdirSync(dir, { recursive: true });
    const active = activeMods.map(m => `        <li>${m}</li>`).join("\n");
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<ModsConfigData>
    <activeMods>
${active}
    </activeMods>
    <knownExpansions>
        <li>ludeon.rimworld.royalty</li>
        <li>ludeon.rimworld.ideology</li>
        <li>ludeon.rimworld.biotech</li>
        <li>ludeon.rimworld.anomaly</li>
        <li>ludeon.rimworld.odyssey</li>
    </knownExpansions>
</ModsConfigData>`;
    fs.writeFileSync(path.join(dir, "ModsConfig.xml"), xml, "utf8");
}

/**
 * Assert a job's pinned config is intact right before launch — the verify half of the
 * #18/#19 structural fix. Guards against the folder vanishing (#19: a bad savedatafolder
 * launching vanilla) or the ModsConfig being changed out from under the job between submit
 * and run (#18). A mismatch fails the job loudly instead of running the wrong modlist.
 */
export function verifyPinnedConfig(job: Job): { ok: boolean; reason?: string; expected?: string[]; actual?: string[] } {
    const savedata = job.pinned.savedatafolder;
    if (!savedata || !fs.existsSync(savedata)) {
        return { ok: false, reason: `pinned savedatafolder does not exist: ${savedata}` };
    }
    if (job.pinned.activeMods && job.pinned.activeMods.length > 0) {
        const cfg = path.join(savedata, "Config", "ModsConfig.xml");
        if (!fs.existsSync(cfg)) return { ok: false, reason: `pinned ModsConfig.xml missing at ${cfg}` };
        let actual: string[] = [];
        try {
            const content = fs.readFileSync(cfg, "utf8");
            const m = content.match(/<activeMods>([\s\S]*?)<\/activeMods>/);
            if (m) for (const lm of m[1].matchAll(/<li>(.*?)<\/li>/g)) actual.push(lm[1].trim());
        } catch (e: any) {
            return { ok: false, reason: `could not read pinned ModsConfig.xml: ${e.message}` };
        }
        const exp = job.pinned.activeMods.map(s => s.toLowerCase());
        const act = actual.map(s => s.toLowerCase());
        if (exp.length !== act.length || exp.some((v, i) => v !== act[i])) {
            return { ok: false, reason: "ModsConfig.xml active mods do not match the pinned list", expected: job.pinned.activeMods, actual };
        }
    }
    return { ok: true };
}

/** Kill the RimWorld process a job launched, identified by its pinned savedatafolder on the
 *  command line. Runs are serial, so at most one game is live at a time. Best-effort. */
function killGameForSavedata(savedata: string): void {
    try {
        const esc = savedata.replace(/'/g, "''");
        execSync(
            `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name = 'RimWorldWin64.exe'\\" | ` +
            `Where-Object { $_.CommandLine -like '*${esc}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`,
            { stdio: "ignore" }
        );
    } catch { /* nothing to kill, or already gone */ }
}

// --- Build lane: one build at a time (shared workspace); hands each build off to the run lane ---
async function drainBuilds(): Promise<void> {
    if (buildWorkerRunning) return;
    buildWorkerRunning = true;
    try {
        while (buildQueue.length > 0) {
            const id = buildQueue.shift()!;
            const job = jobs.get(id);
            if (!job || job.status !== "pending") continue;

            job.status = "building";
            job.startedAt = Date.now();
            persist(job);
            try {
                const build = await buildStage(job.request.repo);
                if (build && build.ok === true) {
                    job.build = build;
                    job.status = "queued";       // built; hand to the serial game lane (runs in parallel)
                    persist(job);
                    runQueue.push(job.id);
                    void drainRuns();            // a game run may now start while the NEXT build proceeds
                } else {
                    job.result = { ok: false, stage: "build", build };
                    job.status = "failed";
                    job.finishedAt = Date.now();
                    persist(job);
                }
            } catch (err: any) {
                job.status = "failed";
                job.error = String(err?.message || err);
                job.finishedAt = Date.now();
                persist(job);
            }
        }
    } finally {
        buildWorkerRunning = false;
    }
}

// --- Run lane: strictly one game at a time; overlaps the build lane ---
async function drainRuns(): Promise<void> {
    if (runWorkerRunning) return;
    runWorkerRunning = true;
    try {
        while (runQueue.length > 0) {
            const id = runQueue.shift()!;
            const job = jobs.get(id);
            if (!job || job.status !== "queued") continue;

            // Verify the pinned config still holds before spending a game launch on it.
            const verify = verifyPinnedConfig(job);
            if (!verify.ok) {
                job.result = { ok: false, stage: "verify", verify, build: job.build };
                job.status = "failed";
                job.finishedAt = Date.now();
                persist(job);
                continue;
            }

            job.status = "running";
            persist(job);
            try {
                const { launch, log } = await runStage(job.pinned.savedatafolder, job.request.timeoutSec || 420);
                if (job.cancelRequested) {
                    // The game was killed by cancel_job; the run "ended" but the result is void.
                    job.status = "cancelled";
                } else {
                    const ok = job.build?.ok === true && launch?.ok === true && log?.ok === true;
                    job.result = { ok, stage: "complete", build: job.build, launch, log };
                    job.status = ok ? "done" : "failed";
                }
            } catch (err: any) {
                job.status = job.cancelRequested ? "cancelled" : "failed";
                if (!job.cancelRequested) job.error = String(err?.message || err);
            }
            job.finishedAt = Date.now();
            persist(job);
        }
    } finally {
        runWorkerRunning = false;
    }
}

export const jobsTools = [
    {
        name: "submit_test_job",
        description:
            "Submit a RimWorld test-cycle job and return immediately with a job_id — non-blocking, so " +
            "you can queue several and keep working. Jobs execute SERIALLY (only one RimWorld can run at " +
            "a time), each in its own pinned, isolated savedatafolder. Poll with get_job. Optionally pass " +
            "'mods' to pin an exact modlist (resolved into load order, RimAgentic forced last) for the run.",
        inputSchema: {
            type: "object",
            properties: {
                repo: { type: "string", description: "Build only this repo and its dependencies. Omit to build everything." },
                mods: { type: "array", items: { type: "string" }, description: "packageIds to pin as the run's active modlist (written into the job's own ModsConfig)." },
                savedatafolder: { type: "string", description: "Override the job's savedatafolder. Default: an isolated per-job folder under %LOCALAPPDATA%\\RimAgentic\\jobs." },
                timeoutSec: { type: "number", description: "Max seconds to wait for the TestRunner (default 420)." }
            }
        }
    },
    {
        name: "get_job",
        description: "Get a submitted job's status and result by job_id: { status, request, pinned, result?, error? }. Survives a server restart (persisted to disk).",
        inputSchema: {
            type: "object",
            properties: { job_id: { type: "string", description: "The job_id returned by submit_test_job." } },
            required: ["job_id"]
        }
    },
    {
        name: "list_jobs",
        description: "List submitted jobs (this session) with their status. Optionally filter by status.",
        inputSchema: {
            type: "object",
            properties: { status: { type: "string", enum: ["pending", "running", "done", "failed", "cancelled"], description: "Optional status filter." } }
        }
    },
    {
        name: "cancel_job",
        description: "Cancel a pending job (removes it from the queue). A job already running cannot be cancelled mid-cycle.",
        inputSchema: {
            type: "object",
            properties: { job_id: { type: "string", description: "The job_id to cancel." } },
            required: ["job_id"]
        }
    }
];

export async function handleJobsTool(name: string, args: any) {
    if (name === "submit_test_job") {
        const config = loadConfig();
        counter += 1;
        const id = `job_${Date.now()}_${counter}`;
        const savedata = args.savedatafolder || path.join(jobsRoot(), id, "savedata");

        let activeMods: string[] | undefined;
        if (Array.isArray(args.mods) && args.mods.length > 0) {
            activeMods = resolveModLoadOrder(args.mods.map((m: string) => String(m)), config).resolved;
            try { writePinnedModsConfig(savedata, activeMods); } catch { /* launch verify will catch a bad folder */ }
        }

        const job: Job = {
            id,
            status: "pending",
            request: { repo: args.repo, mods: args.mods, timeoutSec: args.timeoutSec },
            pinned: { savedatafolder: savedata, activeMods },
            submittedAt: Date.now()
        };
        jobs.set(id, job);
        buildQueue.push(id);
        persist(job);
        void drainBuilds();   // build lane picks it up; a game run of an earlier job may overlap

        return { content: [{ type: "text", text: JSON.stringify({ job_id: id, status: "pending", savedatafolder: savedata }, null, 2) }] };
    }

    if (name === "get_job") {
        const id = String(args.job_id || "");
        let job = jobs.get(id);
        if (!job) {
            try { job = JSON.parse(fs.readFileSync(path.join(jobsRoot(), id, "job.json"), "utf8")); } catch { /* not found */ }
        }
        if (!job) return { isError: true, content: [{ type: "text", text: JSON.stringify({ found: false, job_id: id }, null, 2) }] };
        return { content: [{ type: "text", text: JSON.stringify(job, null, 2) }] };
    }

    if (name === "list_jobs") {
        const all = Array.from(jobs.values());
        const filtered = args.status ? all.filter(j => j.status === args.status) : all;
        return { content: [{ type: "text", text: JSON.stringify({ count: filtered.length, jobs: filtered.map(summarize) }, null, 2) }] };
    }

    if (name === "cancel_job") {
        const id = String(args.job_id || "");
        const job = jobs.get(id);
        if (!job) return { isError: true, content: [{ type: "text", text: JSON.stringify({ found: false, job_id: id }, null, 2) }] };
        // Cancellable while still queued in either lane; a build/run already in flight can't be pulled back.
        if (job.status === "pending" || job.status === "queued") {
            job.status = "cancelled";
            job.finishedAt = Date.now();
            for (const q of [buildQueue, runQueue]) {
                const qi = q.indexOf(id);
                if (qi !== -1) q.splice(qi, 1);
            }
            persist(job);
            return { content: [{ type: "text", text: JSON.stringify({ job_id: id, status: "cancelled" }, null, 2) }] };
        }
        // Running: kill the live game; the run worker marks it cancelled when the launch returns.
        if (job.status === "running") {
            job.cancelRequested = true;
            persist(job);
            killGameForSavedata(job.pinned.savedatafolder);
            return { content: [{ type: "text", text: JSON.stringify({ job_id: id, status: "cancelling", note: "killed the running game; job will settle to cancelled" }, null, 2) }] };
        }
        const note = job.status === "building" ? "a build in flight cannot be cancelled" : "job already finished";
        return { content: [{ type: "text", text: JSON.stringify({ job_id: id, status: job.status, note }, null, 2) }] };
    }

    throw new Error(`Unknown jobs tool: ${name}`);
}
