import * as fs from "fs";
import * as path from "path";
import * as os from "os";
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
    submittedAt: number;
    startedAt?: number;   // build start
    finishedAt?: number;
}

const jobs = new Map<string, Job>();
const buildQueue: string[] = [];   // waiting to build (parallel lane)
const runQueue: string[] = [];     // built OK, waiting for the one game (serial lane)
let buildingCount = 0;
let runWorkerRunning = false;
let counter = 0;

// Build lane concurrency. Builds are independent and CPU-bound; game runs are the scarce
// serial resource, so only the run lane is capped to one.
const MAX_BUILDS = Math.max(1, Math.min(4, os.cpus().length - 1));

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

// --- Build lane: run up to MAX_BUILDS builds concurrently ---
function pumpBuilds(): void {
    while (buildingCount < MAX_BUILDS && buildQueue.length > 0) {
        const id = buildQueue.shift()!;
        const job = jobs.get(id);
        if (!job || job.status !== "pending") continue;
        buildingCount++;
        void buildOne(job);
    }
}

async function buildOne(job: Job): Promise<void> {
    job.status = "building";
    job.startedAt = Date.now();
    persist(job);
    try {
        const build = await buildStage(job.request.repo);
        if (build && build.ok === true) {
            job.build = build;
            job.status = "queued";       // built; hand to the serial game lane
            persist(job);
            runQueue.push(job.id);
            void drainRuns();
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
    } finally {
        buildingCount--;
        pumpBuilds();
    }
}

// --- Run lane: strictly one game at a time ---
async function drainRuns(): Promise<void> {
    if (runWorkerRunning) return;
    runWorkerRunning = true;
    try {
        while (runQueue.length > 0) {
            const id = runQueue.shift()!;
            const job = jobs.get(id);
            if (!job || job.status !== "queued") continue;

            job.status = "running";
            persist(job);
            try {
                const { launch, log } = await runStage(job.pinned.savedatafolder, job.request.timeoutSec || 420);
                const ok = job.build?.ok === true && launch?.ok === true && log?.ok === true;
                job.result = { ok, stage: "complete", build: job.build, launch, log };
                job.status = ok ? "done" : "failed";
            } catch (err: any) {
                job.status = "failed";
                job.error = String(err?.message || err);
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
        pumpBuilds();   // starts the build now if a build slot is free (up to MAX_BUILDS)

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
        return { content: [{ type: "text", text: JSON.stringify({ job_id: id, status: job.status, note: "only pending/queued jobs can be cancelled (a build/run in flight cannot)" }, null, 2) }] };
    }

    throw new Error(`Unknown jobs tool: ${name}`);
}
