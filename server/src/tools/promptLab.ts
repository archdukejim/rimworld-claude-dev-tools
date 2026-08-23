import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * promptLab — the universal, game-free RimSynapse prompt/response harness.
 *
 * Tuning any RimSynapse LLM call site (Conversations dialogue register, WorldNews newspaper voice, …) normally
 * costs a deploy -> launch RimWorld -> load save -> force a debug action -> read log round-trip. This tool
 * drives the PromptLab console (../promptlab, via harness/promptlab.ps1), which composes the EXACT prompt a
 * given "family" would send (by linking that mod's PURE, Verse-free composer), sends it to the same local
 * model the game uses, and returns the RAW response (+ the composed prompt, an optional family-specific parse,
 * and metadata) — with no game process.
 *
 * It deliberately does NOT judge: judging is the job of whatever specific tool is built on top of the raw
 * response, tuned to that tool's goal. Faithful by construction — the composer is authored once in the mod, so
 * the lab can't drift from the game.
 */

const familyInputsSchema = {
    type: "object",
    description:
        "Family-specific inputs. Call list_prompt_families to see each family's input contract (fields, types, " +
        "and where the game reads them). e.g. conversation: {initiatorName, recipientName, beat:{subject,...}, " +
        "initiator:{voiceProfile|backstory|traits}, recipient:{...}, continuation}; newspaper: {events:[...]}.",
    additionalProperties: true
};

const scenarioSchema = {
    type: "object",
    properties: {
        id: { type: "string", description: "Optional label for this scenario in the output." },
        inputs: familyInputsSchema
    },
    required: ["inputs"]
};

export const promptLabTools = [
    {
        name: "simulate_llm_prompt",
        description:
            "Universal game-free RimSynapse prompt/response harness. Composes the EXACT prompt a given LLM call " +
            "site (family) would send — via that mod's pure composer — and (unless dryRun) sends it to the same " +
            "local model the game uses (reading the live Core config), returning the RAW response plus the " +
            "composed system/user, an optional family parse, and metadata. Does NOT judge — parse/score the raw " +
            "yourself for your use case. mode 'suite' runs the family's built-in scenario catalog; 'scenario' " +
            "runs your own inputs. Families are discovered from whichever mod composers are present in the " +
            "workspace — call list_prompt_families first. Requires dotnet and (for real calls) the LLM reachable.",
        inputSchema: {
            type: "object",
            properties: {
                family: { type: "string", description: "Which prompt family, e.g. 'conversation' or 'newspaper' (see list_prompt_families)." },
                mode: { type: "string", enum: ["suite", "scenario"], description: "Default 'suite'." },
                inputs: { ...familyInputsSchema, description: "Single-scenario convenience (scenario mode): the family inputs directly." },
                scenarios: { type: "array", items: scenarioSchema, description: "Multiple scenarios (scenario mode), each with its own family inputs." },
                suiteFilter: { type: "object", additionalProperties: true, description: "Suite mode: family-specific narrowing, e.g. conversation {beats:[],identities:[]}, newspaper {scenarios:[]}." },
                runs: { type: "number", description: "Repeat each scenario N times to see model variance (default 1)." },
                dryRun: { type: "boolean", description: "Build the prompts only; do NOT call the model (no LLM needed)." },
                provider: { type: "string", description: "Override provider (Local_LMStudio | OpenAI | Anthropic_Claude | Google_Gemini | Jan | Custom)." },
                endpoint: { type: "string", description: "Override base URL, e.g. http://127.0.0.1:1234." },
                model: { type: "string", description: "Override model id (skips auto-map)." },
                apiKey: { type: "string", description: "Override API key." },
                temperature: { type: "number", description: "Send this temperature (the game's non-agentic prompt path sends none)." },
                configDir: { type: "string", description: "RimWorld Config dir to read Core settings from (tracks -savedatafolder)." },
                timeoutSeconds: { type: "number", description: "Per-call timeout (default 120)." },
                rebuild: { type: "boolean", description: "Force a clean rebuild of the PromptLab console first." }
            },
            required: ["family"]
        }
    },
    {
        name: "list_prompt_families",
        description:
            "List the registered PromptLab families (the LLM call sites made testable) with each family's " +
            "description, built-in catalog size, and input contract (field names, types, and where the game " +
            "reads them). A family only appears if its mod's pure composer is present in the workspace. No LLM call.",
        inputSchema: { type: "object", properties: {} }
    }
];

/** Locate a harness script, mirroring rimworldDev.ts (build/tools vs packaged tools layout). */
function harnessScript(scriptName: string): string {
    const candidates = [
        process.env.RIMAGENTIC_HARNESS,
        process.env.RIMSYNAPSE_HARNESS,
        path.join(__dirname, "..", "..", "..", "harness"),
        path.join(__dirname, "..", "..", "harness"),
        path.join(__dirname, "..", "harness")
    ].filter(Boolean) as string[];
    for (const dir of candidates) {
        const p = path.join(dir, scriptName);
        if (fs.existsSync(p)) return p;
    }
    throw new Error(
        `Harness script "${scriptName}" not found. Looked in: ${candidates.join(", ")}. ` +
        `Set RIMSYNAPSE_HARNESS to the folder containing the harness .ps1 scripts.`
    );
}

/** Run promptlab.ps1 and return the parsed JSON object it prints. Never rejects. */
function runPromptLab(scriptArgs: string[], timeoutMs: number): Promise<any> {
    return new Promise((resolve) => {
        let script: string;
        try {
            script = harnessScript("promptlab.ps1");
        } catch (err: any) {
            resolve({ ok: false, error: String(err.message) });
            return;
        }
        const child = spawn(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...scriptArgs],
            { windowsHide: true }
        );
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => child.kill(), timeoutMs);
        child.stdout.on("data", d => (stdout += d.toString()));
        child.stderr.on("data", d => (stderr += d.toString()));
        child.on("close", () => {
            clearTimeout(timer);
            const start = stdout.indexOf("{");
            if (start === -1) {
                resolve({ ok: false, error: "no JSON in promptlab output", stdout: stdout.slice(-2000), stderr: stderr.slice(-1000) });
                return;
            }
            const candidate = stdout.slice(start);
            try {
                resolve(JSON.parse(candidate));
            } catch {
                const lastClose = candidate.lastIndexOf("}");
                try {
                    resolve(JSON.parse(candidate.slice(0, lastClose + 1)));
                } catch {
                    resolve({ ok: false, error: "could not parse promptlab output", stdout: stdout.slice(-2000) });
                }
            }
        });
        child.on("error", err => {
            clearTimeout(timer);
            resolve({ ok: false, error: String(err) });
        });
    });
}

export async function handlePromptLabTool(name: string, args: any) {
    if (name === "list_prompt_families") {
        const result = await runPromptLab(["-ListFamilies"], 5 * 60 * 1000);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (name === "simulate_llm_prompt") {
        const a = args || {};
        if (!a.family) {
            return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "family is required (call list_prompt_families)" }) }] };
        }
        const scenarios = Array.isArray(a.scenarios)
            ? a.scenarios
            : (a.inputs ? [{ inputs: a.inputs }] : []);
        const job: any = {
            family: a.family,
            mode: a.mode || "suite",
            scenarios,
            suiteFilter: a.suiteFilter,
            runs: typeof a.runs === "number" ? a.runs : 1,
            dryRun: !!a.dryRun,
            config: {
                provider: a.provider,
                endpoint: a.endpoint,
                model: a.model,
                apiKey: a.apiKey,
                temperature: typeof a.temperature === "number" ? a.temperature : undefined,
                configDir: a.configDir,
                timeoutSeconds: typeof a.timeoutSeconds === "number" ? a.timeoutSeconds : 120
            }
        };

        const tmp = path.join(os.tmpdir(), `promptlab-job-${process.pid}-${Date.now()}.json`);
        try {
            fs.writeFileSync(tmp, JSON.stringify(job), "utf8");
        } catch (err: any) {
            return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `could not write job file: ${err.message}` }) }] };
        }

        const scriptArgs = ["-JobFile", tmp];
        if (a.rebuild) scriptArgs.push("-Rebuild");

        // Generous cap: a suite is many calls (newspaper issues can be multi-second each), plus a build.
        const result = await runPromptLab(scriptArgs, 30 * 60 * 1000);
        try { fs.unlinkSync(tmp); } catch { /* best effort */ }
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    throw new Error(`Unknown promptLab tool: ${name}`);
}
