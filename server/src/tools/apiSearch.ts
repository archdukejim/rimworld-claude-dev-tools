import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { embed, embedBatch, cosine, EMBED_DIM } from "../embeddings";

function localAppData(): string {
    return process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local");
}
const rimAgenticDir = () => path.join(localAppData(), "RimAgentic");

/**
 * API corpus (from the in-game dump_game_api tool) + a local semantic index (built by
 * build_api_index using Transformers.js embeddings). search_game_api blends keyword relevance
 * (exact API names) with semantic similarity (concept queries whose words don't match RimWorld's
 * naming) so the agent finds the right API to write C#/Harmony against.
 */
function apiDir(): string {
    if (process.env.RIMAGENTIC_API_DIR) return process.env.RIMAGENTIC_API_DIR;
    return path.join(rimAgenticDir(), "api");
}
const corpusPath = () => process.env.RIMAGENTIC_API || path.join(apiDir(), "api-corpus.jsonl");
const indexBinPath = () => path.join(apiDir(), "api-index.f32");
const indexMetaPath = () => path.join(apiDir(), "api-index.json");

// --- Corpus (records) ---
let corpusCache: { path: string; mtime: number; records: any[] } | null = null;
function loadCorpus(): any[] | null {
    const p = corpusPath();
    if (!fs.existsSync(p)) return null;
    const mtime = fs.statSync(p).mtimeMs;
    if (corpusCache && corpusCache.path === p && corpusCache.mtime === mtime) return corpusCache.records;
    const records: any[] = [];
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try { records.push(JSON.parse(t)); } catch { /* skip */ }
    }
    corpusCache = { path: p, mtime, records };
    return records;
}

/**
 * The text embedded for a type: an optional frontier-model description (the strongest semantic
 * signal — see enrich_api_corpus) followed by name/kind/base + member names, so both the concept
 * and the concrete member surface are captured.
 */
function typeText(rec: any): string {
    const members = (rec.members || []).map((m: any) => m.name).slice(0, 60).join(" ");
    const head = rec.desc ? `${rec.desc} — ` : "";
    return `${head}${rec.full} (${rec.kind})${rec.baseType ? ` extends ${rec.baseType}` : ""}: ${members}`;
}

// --- Semantic index (vectors aligned to corpus row order) ---
let indexCache: { mtime: number; count: number; vecs: Float32Array[] } | null = null;
function loadIndex(recordCount: number, corpusMtime: number): Float32Array[] | null {
    if (!fs.existsSync(indexBinPath()) || !fs.existsSync(indexMetaPath())) return null;
    let meta: any;
    try { meta = JSON.parse(fs.readFileSync(indexMetaPath(), "utf8")); } catch { return null; }
    // Stale if the corpus changed or the row count no longer matches.
    if (meta.count !== recordCount || meta.corpusMtime !== corpusMtime || meta.dim !== EMBED_DIM) return null;
    if (indexCache && indexCache.count === recordCount && indexCache.mtime === corpusMtime) return indexCache.vecs;
    const buf = fs.readFileSync(indexBinPath());
    const flat = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    const vecs: Float32Array[] = [];
    for (let i = 0; i < recordCount; i++) vecs.push(flat.subarray(i * EMBED_DIM, (i + 1) * EMBED_DIM));
    indexCache = { mtime: corpusMtime, count: recordCount, vecs };
    return vecs;
}

const STOP = new Set(["a", "an", "the", "at", "in", "on", "to", "of", "for", "with", "and", "or", "is", "as", "by", "from", "into", "how", "do", "i", "get", "set"]);

export const apiSearchTools = [
    {
        name: "build_api_index",
        description:
            "Build the local semantic embedding index over the API corpus (from dump_game_api) so " +
            "search_game_api can do concept/natural-language lookup, not just keyword. Uses a local " +
            "MiniLM model (no external service). Run once after dump_game_api; takes a minute or two " +
            "for ~9k types. Returns { ok, indexed, path }.",
        inputSchema: { type: "object", properties: {} }
    },
    {
        name: "set_anthropic_key",
        description:
            "Store your Anthropic API key so enrich_api_corpus can call a frontier model. With no argument this " +
            "opens a small window to paste your key into (get one from console.anthropic.com → API keys). The key " +
            "is saved locally, used immediately (no restart), and never shown in chat or committed to git. Pass " +
            "key:\"sk-ant-...\" to set it without the window — but that puts the key in the chat transcript, so " +
            "prefer the window. ANTHROPIC_API_KEY in the environment still takes precedence if set.",
        inputSchema: {
            type: "object",
            properties: {
                key: { type: "string", description: "Optional. If given, store this key directly instead of opening the paste window." }
            }
        }
    },
    {
        name: "enrich_api_corpus",
        description:
            "Enrich the API corpus (from dump_game_api) with a one-line semantic description per type, " +
            "generated by a frontier model that knows RimWorld/C#. This is what lifts semantic search from " +
            "bare-identifier matching to concept matching (e.g. 'make a pawn go berserk' → MentalStateHandler), " +
            "because the descriptions say what a type is FOR in plain language. Writes `desc` back into the " +
            "corpus in place; run build_api_index afterwards to embed the enriched text. Needs ANTHROPIC_API_KEY " +
            "(or an `ant auth login` profile). Idempotent — only enriches types missing a description unless " +
            "force:true. Packs many types per request and runs them concurrently, so ~9k types is a few hundred " +
            "requests. Returns { ok, enriched, skipped, requests, model }.",
        inputSchema: {
            type: "object",
            properties: {
                model: { type: "string", description: "Anthropic model id (default claude-opus-5). Use a cheaper model like claude-haiku-4-5 for a fast/cheap re-run." },
                batchSize: { type: "number", description: "Types described per model request (default 40)." },
                concurrency: { type: "number", description: "Max concurrent requests (default 6)." },
                limit: { type: "number", description: "Only enrich the first N un-enriched types (for a quick trial run)." },
                force: { type: "boolean", description: "Re-describe every type, even ones that already have a description." }
            }
        }
    },
    {
        name: "search_game_api",
        description:
            "Search the RimWorld C# API for a query — e.g. 'apply hediff', 'make a pawn go berserk', " +
            "'start a fire at a cell'. Blends semantic similarity (finds the right API even when your " +
            "words don't match RimWorld's naming) with keyword relevance (exact type/member names), and " +
            "returns matching types with member signatures for writing C#/Harmony. Run dump_game_api " +
            "(in-game) then build_api_index once; without the index this falls back to keyword-only.",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Keywords or a natural-language concept to find." },
                kind: { type: "string", description: "Optional filter by type kind: class, struct, enum, interface, static class, abstract class." },
                limit: { type: "number", description: "Max types to return (default 15)." }
            },
            required: ["query"]
        }
    }
];

export async function handleApiSearchTool(name: string, args: any) {
    if (name === "build_api_index") {
        const records = loadCorpus();
        if (!records) return errText(`API corpus not found at ${corpusPath()}. Run the in-game 'dump_game_api' tool first.`);
        try {
            const flat = new Float32Array(records.length * EMBED_DIM);
            const batch = 64;
            for (let i = 0; i < records.length; i += batch) {
                const slice = records.slice(i, i + batch);
                const vecs = await embedBatch(slice.map(typeText));
                for (let j = 0; j < vecs.length; j++) flat.set(vecs[j], (i + j) * EMBED_DIM);
            }
            fs.mkdirSync(apiDir(), { recursive: true });
            fs.writeFileSync(indexBinPath(), Buffer.from(flat.buffer));
            fs.writeFileSync(indexMetaPath(), JSON.stringify({
                count: records.length, dim: EMBED_DIM, corpusMtime: fs.statSync(corpusPath()).mtimeMs, model: "Xenova/all-MiniLM-L6-v2"
            }));
            indexCache = null;
            return okText({ ok: true, indexed: records.length, path: indexBinPath() });
        } catch (e: any) {
            return errText(`Failed to build index: ${e?.message || e}`);
        }
    }

    if (name === "set_anthropic_key") return await setAnthropicKey(args);
    if (name === "enrich_api_corpus") return await enrichCorpus(args);

    if (name !== "search_game_api") throw new Error(`Unknown api-search tool: ${name}`);

    const records = loadCorpus();
    if (!records) return errText(`API corpus not found at ${corpusPath()}. Run the in-game 'dump_game_api' tool first.`);

    const terms = String(args.query || "").toLowerCase().split(/\s+/).filter(t => t.length >= 2 && !STOP.has(t));
    if (terms.length === 0) return errText("Provide a 'query' with at least one meaningful term.");
    const kind = args.kind ? String(args.kind).toLowerCase() : null;
    const limit = Math.max(1, Math.min(50, Number(args.limit) || 15));

    // Keyword score per row (+ which members matched, for display).
    const kw = new Float64Array(records.length);
    const kwMembers: any[][] = new Array(records.length);
    for (let i = 0; i < records.length; i++) {
        const rec = records[i];
        if (kind && String(rec.kind || "").toLowerCase() !== kind) { kw[i] = -1; continue; }
        const typeName = String(rec.name || "").toLowerCase();
        const full = String(rec.full || "").toLowerCase();
        let score = 0;
        for (const term of terms) {
            if (typeName === term) score += 20;
            else if (typeName.includes(term)) score += 8;
            if (full.includes(term)) score += 1;
        }
        const matched: any[] = [];
        let memberScore = 0;
        for (const m of rec.members || []) {
            const mn = String(m.name || "").toLowerCase();
            const sig = String(m.sig || "").toLowerCase();
            let ms = 0;
            for (const term of terms) {
                if (mn === term) ms += 10; else if (mn.includes(term)) ms += 4; else if (sig.includes(term)) ms += 1;
            }
            if (ms > 0) { matched.push({ ...m, _s: ms }); memberScore += ms; }
        }
        score += Math.min(memberScore, 30);
        kwMembers[i] = matched;
        kw[i] = score;
    }

    // Semantic score per row, if the index is present & fresh.
    const cMtime = fs.statSync(corpusPath()).mtimeMs;
    const index = loadIndex(records.length, cMtime);
    let sem: Float64Array | null = null;
    let usedSemantic = false;
    if (index) {
        try {
            const qv = await embed(String(args.query));
            sem = new Float64Array(records.length);
            for (let i = 0; i < records.length; i++) sem[i] = kw[i] === -1 ? -1 : cosine(qv, index[i]);
            usedSemantic = true;
        } catch { sem = null; }
    }

    // Blend (per-query normalized). Either a strong keyword or a strong semantic hit surfaces.
    let kwMax = 0, semMax = 0;
    for (let i = 0; i < records.length; i++) { if (kw[i] > kwMax) kwMax = kw[i]; if (sem && sem[i] > semMax) semMax = sem[i]; }
    const combined: Array<{ i: number; c: number }> = [];
    for (let i = 0; i < records.length; i++) {
        if (kw[i] === -1) continue;
        const nk = kwMax > 0 ? kw[i] / kwMax : 0;
        const ns = sem && semMax > 0 ? Math.max(0, sem[i]) / semMax : 0;
        // When semantic is available it leads; keyword only sharpens (an exact type/member-name
        // hit gets a bounded boost) so common words like "pawn"/"colonist" can't dominate.
        const c = sem ? (ns + 0.25 * nk) : nk;
        if (c > 0) combined.push({ i, c });
    }
    combined.sort((a, b) => b.c - a.c);

    const results = combined.slice(0, limit).map(({ i }) => {
        const rec = records[i];
        const matched = (kwMembers[i] || []);
        const members = (matched.length ? matched.sort((a, b) => b._s - a._s) : (rec.members || []).slice(0, 8))
            .slice(0, 15).map((m: any) => `${m.stat ? "static " : ""}${m.kind} ${m.sig}`);
        return { type: `${rec.kind} ${rec.full}${rec.baseType ? ` : ${rec.baseType}` : ""}`, members };
    });

    return okText({ query: args.query, retrieval: usedSemantic ? "hybrid (semantic+keyword)" : "keyword (no index — run build_api_index)", corpusTypes: records.length, matches: results.length, results });
}

// --- Frontier-model corpus enrichment ---

const keyFilePath = () => path.join(rimAgenticDir(), "anthropic.key");

/** ANTHROPIC_API_KEY (env) wins; otherwise the key stored by set_anthropic_key. Null if neither. */
function resolveAnthropicKey(): string | null {
    if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim()) return process.env.ANTHROPIC_API_KEY.trim();
    try { const k = fs.readFileSync(keyFilePath(), "utf8").trim(); if (k) return k; } catch { /* not stored */ }
    return null;
}

/** Lazily construct an Anthropic client using the resolved key (env or stored file). */
function getAnthropic(): any {
    const apiKey = resolveAnthropicKey();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Anthropic = require("@anthropic-ai/sdk");
    const Ctor = Anthropic.default || Anthropic;
    return apiKey ? new Ctor({ apiKey }) : new Ctor();
}

/** Open a native paste window (or store a directly-supplied key), then save it locally. */
async function setAnthropicKey(args: any) {
    let key = args.key ? String(args.key).trim() : "";
    let source = key ? "argument" : "window";
    if (!key) {
        try { key = promptForKeyWindow(); }
        catch (e: any) { return errText(`Couldn't open the paste window: ${e?.message || e}. Pass key:"sk-ant-..." instead, or set ANTHROPIC_API_KEY in the server env.`); }
    }
    if (!key) return okText({ ok: false, note: "No key entered (window cancelled). Nothing was saved." });
    if (!/^sk-ant-/.test(key)) return errText(`That doesn't look like an Anthropic key — it should start with "sk-ant-". Nothing was saved.`);
    try {
        fs.mkdirSync(rimAgenticDir(), { recursive: true });
        fs.writeFileSync(keyFilePath(), key, { mode: 0o600 });
    } catch (e: any) { return errText(`Failed to save the key: ${e?.message || e}`); }
    const masked = `${key.slice(0, 7)}…${key.slice(-4)}`;
    return okText({ ok: true, source, saved: keyFilePath(), key: masked, note: "Stored. enrich_api_corpus will use it right away — no restart needed." });
}

/** Show a Windows input box and return the pasted text (empty string if cancelled). */
function promptForKeyWindow(): string {
    const ps =
        "Add-Type -AssemblyName Microsoft.VisualBasic; " +
        "$k=[Microsoft.VisualBasic.Interaction]::InputBox(" +
        "'Paste your Anthropic API key (console.anthropic.com -> API keys). It is saved locally and never shown in chat.'," +
        "'RimAgentic - Anthropic API key',''); " +
        "[Console]::Out.Write($k)";
    const out = execFileSync("powershell", ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", ps], { encoding: "utf8" });
    return String(out).trim();
}

/** Compact one-line descriptor of a type, fed to the model so it can say what the type is for. */
function recDescriptor(rec: any): string {
    const members = (rec.members || []).map((m: any) => m.name).filter(Boolean).slice(0, 24).join(", ");
    const base = rec.baseType ? ` : ${rec.baseType}` : "";
    return `${rec.full} (${rec.kind})${base}${members ? ` { ${members} }` : ""}`;
}

const ENRICH_SCHEMA = {
    type: "object",
    additionalProperties: false,
    properties: {
        descriptions: {
            type: "array",
            items: {
                type: "object",
                additionalProperties: false,
                properties: {
                    name: { type: "string", description: "The exact full type name from the input." },
                    desc: { type: "string", description: "One concise clause (<=15 words) saying what the type is for in RimWorld." }
                },
                required: ["name", "desc"]
            }
        }
    },
    required: ["descriptions"]
};

const ENRICH_SYSTEM =
    "You annotate a RimWorld C# API (the game's Assembly-CSharp: Verse.* and RimWorld.* types) for a " +
    "semantic search index used by modders. For each type given, write ONE concise clause (<=15 words, no " +
    "trailing period) describing what the type represents or does in RimWorld gameplay/modding terms — the " +
    "concept a modder would search for, not a restatement of the name. Use domain words a modder would type " +
    "(pawn, hediff, mental state, incident, job, thought, apparel, weather, colony). Do not invent members or " +
    "behavior you can't infer from the name and members. Echo each type's exact `name` from the input.";

/** Ask the model to describe one batch of types; returns a name→desc map (lowercased keys). */
async function enrichBatch(client: any, model: string, batch: any[]): Promise<Map<string, string>> {
    const list = batch.map((r, i) => `${i + 1}. ${recDescriptor(r)}`).join("\n");
    const resp = await client.messages.create({
        model,
        max_tokens: 8000,
        system: ENRICH_SYSTEM,
        // Mechanical one-liners: skip thinking (allowed at effort <= high) so each request is fast;
        // structured output keeps the response constrained to the schema.
        thinking: { type: "disabled" },
        output_config: { effort: "low", format: { type: "json_schema", schema: ENRICH_SCHEMA } },
        messages: [{ role: "user", content: `Describe each of these ${batch.length} types:\n\n${list}` }]
    });
    const text = (resp.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    const out = new Map<string, string>();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { return out; }
    for (const d of parsed?.descriptions || []) {
        if (d?.name && d?.desc) out.set(String(d.name).toLowerCase(), String(d.desc).trim());
    }
    return out;
}

async function enrichCorpus(args: any) {
    const records = loadCorpus();
    if (!records) return errText(`API corpus not found at ${corpusPath()}. Run the in-game 'dump_game_api' tool first.`);

    const model = args.model ? String(args.model) : "claude-opus-5";
    const batchSize = Math.max(1, Math.min(80, Number(args.batchSize) || 40));
    const concurrency = Math.max(1, Math.min(16, Number(args.concurrency) || 6));
    const force = !!args.force;

    if (!resolveAnthropicKey())
        return errText("No Anthropic API key found. Run set_anthropic_key first (it opens a window to paste your key), or set ANTHROPIC_API_KEY in the server env.");

    let client: any;
    try { client = getAnthropic(); }
    catch (e: any) { return errText(`Anthropic SDK unavailable: ${e?.message || e}.`); }

    // Pick the rows to enrich (keep original index so we can write desc back).
    let targets = records.map((r, i) => ({ r, i })).filter(({ r }) => force || !r.desc);
    const skipped = records.length - targets.length;
    if (args.limit) targets = targets.slice(0, Math.max(0, Number(args.limit)));
    if (targets.length === 0) return okText({ ok: true, enriched: 0, skipped, requests: 0, model, note: "Nothing to enrich (all types already have a description; pass force:true to redo)." });

    // Batch the targets, then run the batches through a fixed-size concurrency pool.
    const batches: Array<{ r: any; i: number }[]> = [];
    for (let i = 0; i < targets.length; i += batchSize) batches.push(targets.slice(i, i + batchSize));

    // Persist the whole corpus (with any new `desc` fields) and invalidate caches. Called as a
    // checkpoint during the run and once at the end, so an interrupted run is never wasted — a
    // re-run skips the records that already have a description and continues.
    const writeCorpus = () => {
        fs.writeFileSync(corpusPath(), records.map(r => JSON.stringify(r)).join("\n") + "\n");
        corpusCache = null;
        indexCache = null;
    };
    const CHECKPOINT_EVERY = 5;

    let enriched = 0;
    let failed = 0;
    let next = 0;
    let done = 0;
    const worker = async () => {
        while (true) {
            const b = next < batches.length ? batches[next++] : null;
            if (!b) break;
            try {
                const map = await enrichBatch(client, model, b.map(x => x.r));
                for (const { r, i } of b) {
                    const desc = map.get(String(r.full).toLowerCase()) || map.get(String(r.name).toLowerCase());
                    if (desc) { records[i].desc = desc; enriched++; } else { failed++; }
                }
            } catch (e: any) {
                failed += b.length;
                if (String(e?.status) === "401" || /credential|api[_ ]?key|authentication/i.test(String(e?.message)))
                    throw e; // auth errors won't fix themselves — abort the whole run
            }
            // Checkpoint periodically. Node is single-threaded, so this synchronous write can't
            // interleave with another worker's write.
            if (++done % CHECKPOINT_EVERY === 0) { try { writeCorpus(); } catch { /* keep going */ } }
        }
    };

    let aborted: string | null = null;
    try {
        await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, () => worker()));
    } catch (e: any) {
        aborted = e?.message || String(e);
    }

    // Final write captures whatever completed (including partial progress before an abort).
    try { writeCorpus(); }
    catch (e: any) { return errText(`Enriched ${enriched} types but failed to write the corpus: ${e?.message || e}`); }

    if (aborted)
        return errText(`Enrichment stopped early: ${aborted}. ${enriched} type(s) were enriched and saved — re-run to resume the rest.`);

    return okText({
        ok: true, enriched, skipped, failed, requests: batches.length, model,
        corpus: corpusPath(),
        note: "Descriptions written to the corpus. Run build_api_index to re-embed the enriched text."
    });
}

function okText(obj: any) { return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] }; }
function errText(msg: string) { return { content: [{ type: "text", text: msg }] }; }
