import * as fs from "fs";
import * as path from "path";
import { embed, embedBatch, cosine, EMBED_DIM } from "../embeddings";

/**
 * API corpus (from the in-game dump_game_api tool) + a local semantic index (built by
 * build_api_index using Transformers.js embeddings). search_game_api blends keyword relevance
 * (exact API names) with semantic similarity (concept queries whose words don't match RimWorld's
 * naming) so the agent finds the right API to write C#/Harmony against.
 */
function apiDir(): string {
    if (process.env.RIMAGENTIC_API_DIR) return process.env.RIMAGENTIC_API_DIR;
    const local = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local");
    return path.join(local, "RimAgentic", "api");
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

/** The text embedded for a type: its name/kind/base + member names, so member concepts are captured. */
function typeText(rec: any): string {
    const members = (rec.members || []).map((m: any) => m.name).slice(0, 60).join(" ");
    return `${rec.full} (${rec.kind})${rec.baseType ? ` extends ${rec.baseType}` : ""}: ${members}`;
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

function okText(obj: any) { return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] }; }
function errText(msg: string) { return { content: [{ type: "text", text: msg }] }; }
