import * as fs from "fs";
import * as path from "path";
import { XMLParser } from "fast-xml-parser";

/**
 * Offline Def corpus — the "content" half of RimWorld mechanics, available WITHOUT launching.
 *
 * build_def_corpus parses the game's + DLCs' Def XML (<RimWorldPath>/Data/<module>/Defs/**) into a
 * flat catalog (defType, defName, label, description, inheritance, module), and search_defs keyword-
 * searches it. This complements search_game_api (the C# "behavior" half): together the agent knows
 * both what content exists and the code behind it, before the first launch. Game + DLC only — mod
 * Defs are out of scope here (a later extensible "corpus" mechanism will add more).
 */
function localAppData(): string {
    return process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local");
}
const defsDir = () => path.join(localAppData(), "RimAgentic", "defs");
const defCorpusPath = () => path.join(defsDir(), "def-corpus.jsonl");

/** Resolve the RimWorld install directory (the folder containing Data/) from an arg or common locations. */
function resolveRimWorldDir(arg?: string): string | null {
    const cands: string[] = [];
    if (arg) cands.push(arg.replace(/[\\/]?RimWorldWin64\.exe$/i, "").replace(/[\\/]+$/, ""));
    if (process.env.RIMWORLD_PATH) cands.push(process.env.RIMWORLD_PATH.replace(/[\\/]?RimWorldWin64\.exe$/i, ""));
    cands.push("C:\\Program Files (x86)\\Steam\\steamapps\\common\\RimWorld");
    cands.push("C:\\GOG Games\\RimWorld");
    for (const c of cands) { if (c && fs.existsSync(path.join(c, "Data"))) return c; }
    return null;
}

function walkXml(root: string, cap: number): string[] {
    const out: string[] = [];
    const stack = [root];
    while (stack.length && out.length < cap) {
        const dir = stack.pop() as string;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) stack.push(full);
            else if (e.isFile() && e.name.toLowerCase().endsWith(".xml")) { out.push(full); if (out.length >= cap) break; }
        }
    }
    return out;
}

function strVal(v: any): string | null {
    if (typeof v === "string") return v.trim();
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (v && typeof v === "object" && v["#text"] !== undefined) return String(v["#text"]).trim();
    return null;
}

// --- corpus cache ---
let cache: { mtime: number; records: any[] } | null = null;
function loadDefCorpus(): any[] | null {
    const p = defCorpusPath();
    if (!fs.existsSync(p)) return null;
    const mtime = fs.statSync(p).mtimeMs;
    if (cache && cache.mtime === mtime) return cache.records;
    const records: any[] = [];
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
        const t = line.trim(); if (!t) continue;
        try { records.push(JSON.parse(t)); } catch { /* skip */ }
    }
    cache = { mtime, records };
    return records;
}

const STOP = new Set(["a", "an", "the", "of", "for", "to", "and", "or", "is", "in", "on", "def", "how", "do", "make"]);

export const defCorpusTools = [
    {
        name: "build_def_corpus",
        description:
            "Parse the game's and DLCs' Def XML (<RimWorldPath>/Data/<module>/Defs) into an offline, searchable " +
            "catalog of every def — defType, defName, label, description, parent/abstract inheritance, and which " +
            "module (Core, Royalty, Ideology, Biotech, Anomaly) it's from. This gives the agent the whole content " +
            "database WITHOUT launching (the counterpart to search_game_api's code side). Auto-detects installed " +
            "DLCs. Run once (re-run after a game update). Returns totals by module and top def types.",
        inputSchema: {
            type: "object",
            properties: {
                rimworldPath: { type: "string", description: "RimWorld install folder (or the exe). Auto-detected from Steam/GOG defaults if omitted." }
            }
        }
    },
    {
        name: "search_defs",
        description:
            "Search the offline Def corpus (build_def_corpus first) by concept/keyword across defName, label, and " +
            "description — e.g. 'bed', 'go berserk', 'mechanoid raid', 'luciferium'. Optionally filter by defType " +
            "(ThingDef, HediffDef, IncidentDef, MentalStateDef, RecipeDef, …). Returns matching defs with their " +
            "type, label, description, and module. Pair with search_game_api: find the def here, the C# behind it there.",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Keywords or a concept to find." },
                defType: { type: "string", description: "Optional exact defType filter, e.g. ThingDef or HediffDef." },
                limit: { type: "number", description: "Max results (default 20)." }
            },
            required: ["query"]
        }
    }
];

export async function handleDefCorpusTool(name: string, args: any) {
    if (name === "build_def_corpus") return buildDefCorpus(args);
    if (name === "search_defs") return searchDefs(args);
    throw new Error(`Unknown def-corpus tool: ${name}`);
}

function buildDefCorpus(args: any) {
    const dir = resolveRimWorldDir(args?.rimworldPath);
    if (!dir) return errText("RimWorld install not found. Pass 'rimworldPath' to the folder containing Data/ (or the RimWorldWin64.exe).");
    const dataDir = path.join(dir, "Data");

    // Modules = Data subfolders that contain a Defs/ directory (Core + whichever DLCs are installed).
    let modules: string[] = [];
    try {
        modules = fs.readdirSync(dataDir, { withFileTypes: true })
            .filter(e => e.isDirectory() && fs.existsSync(path.join(dataDir, e.name, "Defs")))
            .map(e => e.name);
    } catch (e: any) { return errText(`Could not read ${dataDir}: ${e?.message || e}`); }
    if (modules.length === 0) return errText(`No Def modules found under ${dataDir}.`);

    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", allowBooleanAttributes: true });
    const records: any[] = [];
    const byModule: Record<string, number> = {};
    const byType: Record<string, number> = {};

    for (const mod of modules) {
        const files = walkXml(path.join(dataDir, mod, "Defs"), 100000);
        for (const file of files) {
            let tree: any;
            try { tree = parser.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
            const defsRoot = tree && tree.Defs;
            if (!defsRoot || typeof defsRoot !== "object") continue;
            for (const defType of Object.keys(defsRoot)) {
                if (defType.startsWith("@_") || defType === "#text") continue;
                const val = defsRoot[defType];
                const list = Array.isArray(val) ? val : [val];
                for (const el of list) {
                    if (!el || typeof el !== "object") continue;
                    const defName = strVal(el.defName);
                    const nameAttr = strVal(el["@_Name"]);
                    if (!defName && !nameAttr) continue; // not a real def entry
                    const rec: any = {
                        defType,
                        id: defName || nameAttr, // stable key (concrete defName or an abstract base's Name) for the corpus registry
                        defName: defName || undefined,
                        name: nameAttr || undefined,
                        abstract: String(el["@_Abstract"] || "").toLowerCase() === "true" || undefined,
                        parent: strVal(el["@_ParentName"]) || undefined,
                        label: strVal(el.label) || undefined,
                        description: strVal(el.description) || undefined,
                        module: mod
                    };
                    records.push(rec);
                    byModule[mod] = (byModule[mod] || 0) + 1;
                    byType[defType] = (byType[defType] || 0) + 1;
                }
            }
        }
    }

    try {
        fs.mkdirSync(defsDir(), { recursive: true });
        fs.writeFileSync(defCorpusPath(), records.map(r => JSON.stringify(r)).join("\n") + "\n");
        cache = null;
    } catch (e: any) { return errText(`Failed to write def corpus: ${e?.message || e}`); }

    const topTypes = Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 15)
        .map(([t, n]) => ({ defType: t, count: n }));
    return okText({ ok: true, total: records.length, modules, byModule, topDefTypes: topTypes, path: defCorpusPath() });
}

function searchDefs(args: any) {
    const records = loadDefCorpus();
    if (!records) return errText(`Def corpus not found at ${defCorpusPath()}. Run build_def_corpus first.`);
    const terms = String(args?.query || "").toLowerCase().split(/\s+/).filter(t => t.length >= 2 && !STOP.has(t));
    if (terms.length === 0) return errText("Provide a 'query' with at least one meaningful term.");
    const defType = args?.defType ? String(args.defType).toLowerCase() : null;
    const limit = Math.max(1, Math.min(100, Number(args?.limit) || 20));

    const scored: Array<{ i: number; s: number }> = [];
    for (let i = 0; i < records.length; i++) {
        const r = records[i];
        if (defType && String(r.defType || "").toLowerCase() !== defType) continue;
        const dn = String(r.defName || r.name || "").toLowerCase();
        const label = String(r.label || "").toLowerCase();
        const desc = String(r.description || "").toLowerCase();
        const dt = String(r.defType || "").toLowerCase();
        let s = 0;
        for (const term of terms) {
            if (dn === term) s += 20;
            else if (dn.includes(term)) s += 8;
            if (label.includes(term)) s += 4;
            if (desc.includes(term)) s += 2;
            if (dt.includes(term)) s += 1;
        }
        if (s > 0) scored.push({ i, s });
    }
    scored.sort((a, b) => b.s - a.s);
    const results = scored.slice(0, limit).map(({ i }) => {
        const r = records[i];
        return {
            defType: r.defType, defName: r.defName || r.name, abstract: r.abstract || undefined,
            label: r.label, description: r.description ? String(r.description).slice(0, 240) : undefined, module: r.module
        };
    });
    return okText({ query: args.query, defType: defType || undefined, corpusDefs: records.length, matches: results.length, results });
}

function okText(obj: any) { return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] }; }
function errText(msg: string) { return { content: [{ type: "text", text: msg }] }; }
