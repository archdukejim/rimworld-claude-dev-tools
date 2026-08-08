import * as fs from "fs";
import * as path from "path";
import { embed, embedBatch, cosine, EMBED_DIM } from "../embeddings";

/**
 * Generic corpus/graph registry — the "easy method for the agent to do more".
 *
 * The API corpus and Def corpus proved a pattern: records → (optional) local embeddings → (optional)
 * structural graph → search. This generalizes it so the agent can register ANY structured knowledge
 * as a named corpus and get the same capabilities for free: register_corpus (from inline records or a
 * JSONL/JSON file), index_corpus (local MiniLM embeddings — no API key), graph_corpus (edges from
 * fields that reference other records' ids), search_corpus (keyword, blended with semantic when
 * indexed), and query_corpus_graph (relationship traversal). Each corpus lives under
 * %LOCALAPPDATA%/RimAgentic/corpora/<name>/.
 */
function localAppData(): string {
    return process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local");
}
const corporaRoot = () => path.join(localAppData(), "RimAgentic", "corpora");
function safeName(name: string): string {
    return String(name || "").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}
const corpusDir = (name: string) => path.join(corporaRoot(), safeName(name));
const recordsFile = (name: string) => path.join(corpusDir(name), "records.jsonl");
const metaFile = (name: string) => path.join(corpusDir(name), "meta.json");
const indexBin = (name: string) => path.join(corpusDir(name), "index.f32");
const indexMeta = (name: string) => path.join(corpusDir(name), "index.json");
const graphFile = (name: string) => path.join(corpusDir(name), "graph.json");

const ID_CANDIDATES = ["id", "defName", "name", "full", "key"];
const TEXT_PREFERRED = ["label", "description", "desc", "name", "defName", "full", "title", "text", "summary"];

function readRecords(name: string): any[] | null {
    const p = recordsFile(name);
    if (!fs.existsSync(p)) return null;
    const out: any[] = [];
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
        const t = line.trim(); if (!t) continue;
        try { out.push(JSON.parse(t)); } catch { /* skip */ }
    }
    return out;
}
function readMeta(name: string): any | null {
    try { return JSON.parse(fs.readFileSync(metaFile(name), "utf8")); } catch { return null; }
}

/** Build the searchable/embeddable text for a record from its configured text fields. */
function recordText(rec: any, textFields: string[]): string {
    const parts: string[] = [];
    for (const f of textFields) {
        const v = rec[f];
        if (typeof v === "string") parts.push(v);
        else if (Array.isArray(v)) parts.push(v.filter(x => typeof x === "string").join(" "));
    }
    return parts.join(" ");
}

const STOP = new Set(["a", "an", "the", "of", "for", "to", "and", "or", "is", "in", "on", "how", "do"]);

export const corpusRegistryTools = [
    {
        name: "register_corpus",
        description:
            "Register a named corpus of structured records so the agent can search and graph it like the built-in " +
            "API/Def corpora. Provide records inline (array of objects) OR recordsPath (a .jsonl or .json array file). " +
            "idField is the unique key per record (auto-detected: id/defName/name/full/key); textFields are the fields " +
            "concatenated for search/embedding (auto-detected from string fields if omitted). Overwrites an existing " +
            "corpus of the same name. Then optionally index_corpus (semantic) and graph_corpus (relationships).",
        inputSchema: {
            type: "object",
            properties: {
                name: { type: "string", description: "Corpus name (a-z0-9-_)." },
                records: { type: "array", description: "Inline records (array of objects). Use this OR recordsPath.", items: { type: "object" } },
                recordsPath: { type: "string", description: "Path to a .jsonl (one object per line) or .json (array) file of records." },
                idField: { type: "string", description: "Unique key field per record. Auto-detected if omitted." },
                textFields: { type: "array", description: "Fields to concatenate for search/embedding. Auto-detected if omitted.", items: { type: "string" } }
            },
            required: ["name"]
        }
    },
    {
        name: "list_corpora",
        description: "List registered corpora with their record count, idField, textFields, and whether they've been indexed (semantic) or graphed. Read-only.",
        inputSchema: { type: "object", properties: {} }
    },
    {
        name: "index_corpus",
        description:
            "Build a local semantic embedding index over a registered corpus (MiniLM, no external service, no API " +
            "key) so search_corpus can match by concept, not just keyword. Run once after register_corpus.",
        inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }
    },
    {
        name: "search_corpus",
        description:
            "Search a registered corpus by keyword — blended with semantic similarity when the corpus has been " +
            "indexed (index_corpus). Returns matching records with their id and text. Optionally filter by an exact " +
            "field match (filterField + filterValue).",
        inputSchema: {
            type: "object",
            properties: {
                name: { type: "string" },
                query: { type: "string", description: "Keywords or a concept." },
                filterField: { type: "string", description: "Optional exact-match filter field." },
                filterValue: { type: "string", description: "Value the filterField must equal." },
                limit: { type: "number", description: "Max results (default 20)." }
            },
            required: ["name", "query"]
        }
    },
    {
        name: "graph_corpus",
        description:
            "Build a relationship graph over a registered corpus. `edges` is a list of { relation, field, split? }: " +
            "for each record, the value(s) of `field` that match another record's id become edges under `relation` " +
            "(split:true splits a string field on whitespace/commas into multiple ids). Forward and reverse edges are " +
            "both stored, so query_corpus_graph can traverse either way. Example (def inheritance): " +
            "edges=[{relation:'extends', field:'parent'}].",
        inputSchema: {
            type: "object",
            properties: {
                name: { type: "string" },
                edges: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            relation: { type: "string", description: "Edge name, e.g. 'extends'." },
                            field: { type: "string", description: "Record field whose value(s) reference other records' ids." },
                            split: { type: "boolean", description: "Split a string field on whitespace/commas into multiple ids." }
                        },
                        required: ["relation", "field"]
                    }
                }
            },
            required: ["name", "edges"]
        }
    },
    {
        name: "query_corpus_graph",
        description:
            "Traverse a corpus graph (graph_corpus first): given a node id and a relation, return its neighbors. " +
            "direction 'forward' (default) follows the edge as defined; 'reverse' follows it backward (e.g. relation " +
            "'extends' forward = a type's parents, reverse = its subclasses). transitive:true walks the whole chain.",
        inputSchema: {
            type: "object",
            properties: {
                name: { type: "string" },
                node: { type: "string", description: "The record id to start from." },
                relation: { type: "string" },
                direction: { type: "string", description: "forward (default) | reverse." },
                transitive: { type: "boolean", description: "Walk the relation transitively (default false = direct neighbors)." },
                limit: { type: "number", description: "Max nodes returned (default 100)." }
            },
            required: ["name", "node", "relation"]
        }
    }
];

export async function handleCorpusRegistryTool(name: string, args: any) {
    if (name === "register_corpus") return registerCorpus(args);
    if (name === "list_corpora") return listCorpora();
    if (name === "index_corpus") return await indexCorpus(args);
    if (name === "search_corpus") return await searchCorpus(args);
    if (name === "graph_corpus") return graphCorpus(args);
    if (name === "query_corpus_graph") return queryCorpusGraph(args);
    throw new Error(`Unknown corpus-registry tool: ${name}`);
}

function loadRecordsFromArg(args: any): { records: any[]; error?: string } {
    if (Array.isArray(args?.records)) return { records: args.records };
    if (args?.recordsPath) {
        const p = String(args.recordsPath);
        if (!fs.existsSync(p)) return { records: [], error: `recordsPath not found: ${p}` };
        const raw = fs.readFileSync(p, "utf8");
        const trimmed = raw.trim();
        if (trimmed.startsWith("[")) {
            try { const arr = JSON.parse(trimmed); return { records: Array.isArray(arr) ? arr : [] }; }
            catch (e: any) { return { records: [], error: `Failed to parse JSON array: ${e?.message || e}` }; }
        }
        const out: any[] = [];
        for (const line of raw.split("\n")) { const t = line.trim(); if (!t) continue; try { out.push(JSON.parse(t)); } catch { /* skip */ } }
        return { records: out };
    }
    return { records: [], error: "Provide 'records' (array) or 'recordsPath'." };
}

function registerCorpus(args: any) {
    const name = safeName(args?.name);
    if (!name) return errText("A valid 'name' (a-z0-9-_) is required.");
    const { records, error } = loadRecordsFromArg(args);
    if (error) return errText(error);
    if (records.length === 0) return errText("No records to register.");

    const sample = records.slice(0, 50);
    let idField = args?.idField ? String(args.idField) : "";
    if (!idField) {
        for (const c of ID_CANDIDATES) if (sample.some(r => typeof r?.[c] === "string" && r[c])) { idField = c; break; }
        if (!idField) {
            const firstStr = Object.keys(records[0] || {}).find(k => typeof records[0][k] === "string");
            idField = firstStr || "id";
        }
    }
    let textFields: string[] = Array.isArray(args?.textFields) ? args.textFields.map(String) : [];
    if (textFields.length === 0) {
        const keys = new Set<string>();
        for (const r of sample) for (const k of Object.keys(r || {})) {
            if (typeof r[k] === "string" || (Array.isArray(r[k]) && r[k].every((x: any) => typeof x === "string"))) keys.add(k);
        }
        // Prefer the human-readable fields, then any remaining string fields.
        textFields = [...TEXT_PREFERRED.filter(f => keys.has(f)), ...[...keys].filter(k => !TEXT_PREFERRED.includes(k))];
        if (textFields.length === 0) textFields = [idField];
    }

    try {
        fs.mkdirSync(corpusDir(name), { recursive: true });
        fs.writeFileSync(recordsFile(name), records.map(r => JSON.stringify(r)).join("\n") + "\n");
        const meta = { name, idField, textFields, count: records.length, createdAt: new Date().toISOString(), hasIndex: false, hasGraph: false, relations: [] as string[] };
        fs.writeFileSync(metaFile(name), JSON.stringify(meta, null, 2));
        // Registering fresh records invalidates any prior index/graph.
        for (const f of [indexBin(name), indexMeta(name), graphFile(name)]) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
    } catch (e: any) { return errText(`Failed to write corpus: ${e?.message || e}`); }

    return okText({ ok: true, name, count: records.length, idField, textFields, dir: corpusDir(name) });
}

function listCorpora() {
    let names: string[] = [];
    try { names = fs.readdirSync(corporaRoot(), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { /* none */ }
    const corpora = names.map(n => {
        const m = readMeta(n);
        if (!m) return { name: n, error: "no meta" };
        return { name: m.name, count: m.count, idField: m.idField, textFields: m.textFields, indexed: !!m.hasIndex, graphed: !!m.hasGraph, relations: m.relations || [] };
    });
    return okText({ count: corpora.length, corpora, root: corporaRoot() });
}

async function indexCorpus(args: any) {
    const name = safeName(args?.name);
    const meta = readMeta(name);
    const records = readRecords(name);
    if (!meta || !records) return errText(`Corpus '${name}' not found. Register it first.`);
    try {
        const flat = new Float32Array(records.length * EMBED_DIM);
        const batch = 64;
        for (let i = 0; i < records.length; i += batch) {
            const slice = records.slice(i, i + batch).map(r => recordText(r, meta.textFields) || meta.idField);
            const vecs = await embedBatch(slice);
            for (let j = 0; j < vecs.length; j++) flat.set(vecs[j], (i + j) * EMBED_DIM);
        }
        fs.writeFileSync(indexBin(name), Buffer.from(flat.buffer));
        fs.writeFileSync(indexMeta(name), JSON.stringify({ count: records.length, dim: EMBED_DIM, recordsMtime: fs.statSync(recordsFile(name)).mtimeMs }));
        meta.hasIndex = true;
        fs.writeFileSync(metaFile(name), JSON.stringify(meta, null, 2));
    } catch (e: any) { return errText(`Failed to index corpus: ${e?.message || e}`); }
    return okText({ ok: true, name, indexed: records.length });
}

function loadIndex(name: string, recordCount: number): Float32Array[] | null {
    if (!fs.existsSync(indexBin(name)) || !fs.existsSync(indexMeta(name))) return null;
    let m: any; try { m = JSON.parse(fs.readFileSync(indexMeta(name), "utf8")); } catch { return null; }
    if (m.count !== recordCount || m.dim !== EMBED_DIM || m.recordsMtime !== fs.statSync(recordsFile(name)).mtimeMs) return null;
    const buf = fs.readFileSync(indexBin(name));
    const flat = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    const vecs: Float32Array[] = [];
    for (let i = 0; i < recordCount; i++) vecs.push(flat.subarray(i * EMBED_DIM, (i + 1) * EMBED_DIM));
    return vecs;
}

async function searchCorpus(args: any) {
    const name = safeName(args?.name);
    const meta = readMeta(name);
    const records = readRecords(name);
    if (!meta || !records) return errText(`Corpus '${name}' not found.`);
    const terms = String(args?.query || "").toLowerCase().split(/\s+/).filter(t => t.length >= 2 && !STOP.has(t));
    if (terms.length === 0) return errText("Provide a 'query' with at least one meaningful term.");
    const limit = Math.max(1, Math.min(100, Number(args?.limit) || 20));
    const filterField = args?.filterField ? String(args.filterField) : null;
    const filterValue = args?.filterValue !== undefined ? String(args.filterValue) : null;

    const kw = new Float64Array(records.length);
    for (let i = 0; i < records.length; i++) {
        const r = records[i];
        if (filterField && String(r[filterField] ?? "") !== filterValue) { kw[i] = -1; continue; }
        const id = String(r[meta.idField] ?? "").toLowerCase();
        const text = recordText(r, meta.textFields).toLowerCase();
        let s = 0;
        for (const term of terms) {
            if (id === term) s += 20; else if (id.includes(term)) s += 8;
            if (text.includes(term)) s += 3;
        }
        kw[i] = s;
    }

    const index = loadIndex(name, records.length);
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

    let kwMax = 0, semMax = 0;
    for (let i = 0; i < records.length; i++) { if (kw[i] > kwMax) kwMax = kw[i]; if (sem && sem[i] > semMax) semMax = sem[i]; }
    const scored: Array<{ i: number; c: number }> = [];
    for (let i = 0; i < records.length; i++) {
        if (kw[i] === -1) continue;
        const nk = kwMax > 0 ? kw[i] / kwMax : 0;
        const ns = sem && semMax > 0 ? Math.max(0, sem[i]) / semMax : 0;
        const c = sem ? (ns + 0.25 * nk) : nk;
        if (c > 0) scored.push({ i, c });
    }
    scored.sort((a, b) => b.c - a.c);
    const results = scored.slice(0, limit).map(({ i }) => {
        const r = records[i];
        const text = recordText(r, meta.textFields);
        return { id: r[meta.idField], text: text.length > 240 ? text.slice(0, 240) : text };
    });
    return okText({ corpus: name, query: args.query, retrieval: usedSemantic ? "hybrid (semantic+keyword)" : "keyword (index_corpus for semantic)", records: records.length, matches: results.length, results });
}

function graphCorpus(args: any) {
    const name = safeName(args?.name);
    const meta = readMeta(name);
    const records = readRecords(name);
    if (!meta || !records) return errText(`Corpus '${name}' not found.`);
    const edges = Array.isArray(args?.edges) ? args.edges : [];
    if (edges.length === 0) return errText("Provide 'edges': [{ relation, field, split? }].");

    const idSet = new Set<string>();
    for (const r of records) { const id = r[meta.idField]; if (id !== undefined && id !== null) idSet.add(String(id)); }

    const graph: any = { relations: {} };
    for (const e of edges) {
        const relation = String(e.relation);
        const field = String(e.field);
        const split = !!e.split;
        const forward: Record<string, string[]> = {};
        const reverse: Record<string, string[]> = {};
        for (const r of records) {
            const id = r[meta.idField]; if (id === undefined || id === null) continue;
            const from = String(id);
            let vals: string[] = [];
            const v = r[field];
            if (typeof v === "string") vals = split ? v.split(/[\s,]+/).filter(Boolean) : [v];
            else if (Array.isArray(v)) vals = v.map(String);
            for (const val of vals) {
                if (!idSet.has(val) || val === from) continue;
                (forward[from] || (forward[from] = [])).push(val);
                (reverse[val] || (reverse[val] = [])).push(from);
            }
        }
        graph.relations[relation] = { forward, reverse };
    }

    try {
        fs.writeFileSync(graphFile(name), JSON.stringify(graph));
        meta.hasGraph = true; meta.relations = Object.keys(graph.relations);
        fs.writeFileSync(metaFile(name), JSON.stringify(meta, null, 2));
    } catch (e: any) { return errText(`Failed to write graph: ${e?.message || e}`); }

    const counts = Object.fromEntries(Object.entries(graph.relations).map(([rel, g]: any) => [rel, Object.keys(g.forward).length]));
    return okText({ ok: true, name, relations: Object.keys(graph.relations), edgeSourceCounts: counts });
}

function queryCorpusGraph(args: any) {
    const name = safeName(args?.name);
    let graph: any; try { graph = JSON.parse(fs.readFileSync(graphFile(name), "utf8")); } catch { return errText(`No graph for corpus '${name}'. Run graph_corpus first.`); }
    const relation = String(args?.relation || "");
    const rel = graph.relations?.[relation];
    if (!rel) return errText(`Relation '${relation}' not in the graph. Available: ${Object.keys(graph.relations || {}).join(", ") || "(none)"}.`);
    const node = String(args?.node ?? "");
    const dir = String(args?.direction || "forward").toLowerCase() === "reverse" ? "reverse" : "forward";
    const adj: Record<string, string[]> = rel[dir] || {};
    const limit = Math.max(1, Math.min(1000, Number(args?.limit) || 100));

    if (!args?.transitive) {
        const neighbors = (adj[node] || []).slice(0, limit);
        return okText({ corpus: name, node, relation, direction: dir, neighbors, count: (adj[node] || []).length });
    }
    const all: string[] = []; const seen = new Set<string>([node]); const queue = [...(adj[node] || [])];
    let truncated = false;
    while (queue.length) {
        if (all.length >= limit) { truncated = true; break; }
        const x = queue.shift() as string;
        if (seen.has(x)) continue; seen.add(x); all.push(x);
        for (const n of (adj[x] || [])) queue.push(n);
    }
    return okText({ corpus: name, node, relation, direction: dir, transitive: true, nodes: all, count: all.length, truncated });
}

function okText(obj: any) { return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] }; }
function errText(msg: string) { return { content: [{ type: "text", text: msg }] }; }

/**
 * Read a corpus's meta (or null) by name — for other families that build ON TOP of the generic
 * registry (e.g. the Harmony corpus) and need to know whether it's been registered/indexed/graphed
 * before deciding to bootstrap. Same safeName normalization as the tools.
 */
export function corpusMeta(name: string): any | null {
    return readMeta(safeName(name));
}
