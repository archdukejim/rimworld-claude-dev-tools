import * as fs from "fs";
import * as path from "path";
import { handleCorpusRegistryTool, corpusMeta } from "./corpusRegistry";

/**
 * Harmony RAG — a curated, semantically-searchable knowledge base of the HarmonyLib patching API
 * (core classes, patch attributes, injection parameters, prefix/postfix/finalizer/transpiler
 * semantics, IL/CodeMatcher, RimWorld patterns and the recurring gotchas).
 *
 * Harmony is the one library every C# RimWorld mod patches through, yet the API corpus only covers
 * the game's own Assembly-CSharp. This family ships a hand-authored corpus (harmony-knowledge/) and
 * bootstraps it into the generic corpus registry — register → local MiniLM index → relationship
 * graph — so search_harmony blends keyword + semantic retrieval and harmony_graph traverses the
 * "related" links between records. The build is automatic on first use; nothing to set up.
 */

const CORPUS = "harmony";
const ID_FIELD = "id";
const TEXT_FIELDS = ["title", "text", "signature", "category", "kind"];
const CATEGORIES = ["core", "attributes", "injection", "semantics", "il", "patterns", "gotcha", "rimworld", "release-notes"];

/** Locate the harmony-knowledge folder. Overridable with RIMAGENTIC_HARMONY (pointing at the folder
 *  OR the curated .jsonl). Compiles to build/tools/, so the repo root is three levels up; a couple of
 *  fallbacks cover packaged layouts. */
function harmonyDir(): string {
    const envDir = process.env.RIMAGENTIC_HARMONY;
    const candidates = [
        envDir && (envDir.toLowerCase().endsWith(".jsonl") ? path.dirname(envDir) : envDir),
        path.resolve(__dirname, "../../../harmony-knowledge"),
        path.resolve(__dirname, "../../harmony-knowledge"),
        path.resolve(process.cwd(), "harmony-knowledge")
    ].filter(Boolean) as string[];
    for (const c of candidates) if (fs.existsSync(c)) return c;
    return candidates[1];
}
/** Curated, hand-authored records (stable, git-tracked). */
function harmonyDataFile(): string { return path.join(harmonyDir(), "harmony-corpus.jsonl"); }
/** Auto-generated release records, refreshed from the GitHub API by refresh-harmony-releases.cjs.
 *  Kept separate so machine churn never touches the curated file. Optional — absent is fine. */
function harmonyAutoFile(): string { return path.join(harmonyDir(), "harmony-releases.auto.jsonl"); }

function readJsonl(p: string): any[] {
    const out: any[] = [];
    if (!fs.existsSync(p)) return out;
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
        const t = line.trim(); if (!t) continue;
        try { out.push(JSON.parse(t)); } catch { /* skip malformed */ }
    }
    return out;
}

function textOf(res: any): string {
    try { return res?.content?.[0]?.text ?? ""; } catch { return ""; }
}
/** register/index/graph return okText({ok:true,...}); errText returns a plain (non-JSON) string. */
function parsedOk(res: any): boolean {
    try { return JSON.parse(textOf(res))?.ok === true; } catch { return false; }
}

/**
 * Ensure the Harmony corpus is registered, indexed and graphed. Idempotent: skips when meta already
 * shows an index + graph, unless force. Indexing (embeddings) is best-effort — if the local model
 * can't load, keyword search still works, so a failed index never blocks retrieval.
 */
async function ensureHarmonyCorpus(force: boolean): Promise<{ built: boolean; indexed: boolean; graphed: boolean; note: string }> {
    const meta = corpusMeta(CORPUS);
    if (!force && meta && meta.hasIndex && meta.hasGraph) {
        return { built: false, indexed: true, graphed: true, note: "already built" };
    }

    const dataPath = harmonyDataFile();
    if (!fs.existsSync(dataPath)) {
        throw new Error(`Harmony corpus data not found at ${dataPath}. Set RIMAGENTIC_HARMONY to point at harmony-knowledge (or harmony-corpus.jsonl).`);
    }

    // Curated (stable) + auto-generated release records (refreshed from GitHub), merged.
    const records = [...readJsonl(dataPath), ...readJsonl(harmonyAutoFile())];
    const reg = await handleCorpusRegistryTool("register_corpus", {
        name: CORPUS, records, idField: ID_FIELD, textFields: TEXT_FIELDS
    });
    if (!parsedOk(reg)) throw new Error(`Failed to register Harmony corpus: ${textOf(reg)}`);

    let indexed = false;
    try { indexed = parsedOk(await handleCorpusRegistryTool("index_corpus", { name: CORPUS })); }
    catch { indexed = false; }

    let graphed = false;
    try {
        graphed = parsedOk(await handleCorpusRegistryTool("graph_corpus", {
            name: CORPUS, edges: [{ relation: "related", field: "related" }]
        }));
    } catch { graphed = false; }

    return { built: true, indexed, graphed, note: force ? "rebuilt" : "built" };
}

export const harmonyTools = [
    {
        name: "search_harmony",
        description:
            "Search the Harmony (HarmonyLib) patching knowledge base — how to write prefixes/postfixes/" +
            "transpilers/finalizers, the injection parameters (__instance, __result, __state, __args, " +
            "___privateField, __0), [HarmonyPatch] targeting and overload disambiguation, AccessTools/Traverse/" +
            "CodeMatcher, patch ordering, RimWorld startup patterns, and the common gotchas (namespace, " +
            "'Could not resolve type HarmonyLib.Harmony', JIT inlining, generic methods). Blends semantic + " +
            "keyword retrieval. USE THIS before writing or debugging a Harmony patch. Builds itself on first call.",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Keywords or a natural-language question, e.g. 'skip the original method', 'modify a private field', 'patch an overloaded method'." },
                category: { type: "string", description: `Optional filter: ${CATEGORIES.join(" | ")}.` },
                limit: { type: "number", description: "Max results (default 12)." }
            },
            required: ["query"]
        }
    },
    {
        name: "harmony_graph",
        description:
            "Traverse the Harmony knowledge graph: given a record id (from search_harmony results) and the " +
            "'related' relation, return linked records — the cluster of concepts around a topic (e.g. from " +
            "'sem-transpiler' to CodeMatcher, CodeInstruction, DEBUG). direction reverse and transitive:true " +
            "widen the walk. Builds itself on first call.",
        inputSchema: {
            type: "object",
            properties: {
                node: { type: "string", description: "Record id to start from (e.g. 'harmonyprefix-attr', 'inj-result')." },
                relation: { type: "string", description: "Relation to follow (default 'related')." },
                direction: { type: "string", description: "forward (default) | reverse." },
                transitive: { type: "boolean", description: "Walk the whole chain, not just direct neighbors (default false)." },
                limit: { type: "number", description: "Max nodes (default 50)." }
            },
            required: ["node"]
        }
    },
    {
        name: "rebuild_harmony_corpus",
        description:
            "Force a rebuild of the Harmony corpus (re-register from the bundled harmony-knowledge data, re-embed " +
            "the semantic index, rebuild the graph). Run after editing harmony-corpus.jsonl or to repair a partial " +
            "build. Normally unnecessary — search_harmony builds on first use.",
        inputSchema: { type: "object", properties: {} }
    }
];

export async function handleHarmonyTool(name: string, args: any) {
    if (name === "search_harmony") {
        await ensureHarmonyCorpus(false);
        const call: any = { name: CORPUS, query: args.query, limit: args.limit || 12 };
        if (args.category) { call.filterField = "category"; call.filterValue = String(args.category); }
        return await handleCorpusRegistryTool("search_corpus", call);
    }

    if (name === "harmony_graph") {
        await ensureHarmonyCorpus(false);
        return await handleCorpusRegistryTool("query_corpus_graph", {
            name: CORPUS,
            node: args.node,
            relation: args.relation || "related",
            direction: args.direction,
            transitive: args.transitive,
            limit: args.limit
        });
    }

    if (name === "rebuild_harmony_corpus") {
        const r = await ensureHarmonyCorpus(true);
        const meta = corpusMeta(CORPUS);
        return {
            content: [{
                type: "text",
                text: JSON.stringify({
                    ok: true, corpus: CORPUS, ...r,
                    records: meta?.count ?? null,
                    relations: meta?.relations ?? [],
                    source: { curated: harmonyDataFile(), auto: fs.existsSync(harmonyAutoFile()) ? harmonyAutoFile() : null },
                    note: r.indexed ? "Semantic + keyword search ready." : "Keyword search ready (semantic index unavailable — MiniLM model failed to load)."
                }, null, 2)
            }]
        };
    }

    throw new Error(`Unknown Harmony tool: ${name}`);
}
