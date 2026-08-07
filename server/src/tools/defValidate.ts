import * as fs from "fs";
import * as path from "path";
import { XMLParser, XMLValidator } from "fast-xml-parser";

/**
 * Pre-launch Def validation — catch two classes of error before spending a whole launch cycle:
 *   1. Malformed XML (well-formedness), reported with file + line.
 *   2. C# class references (Class="..." attributes and <*Class> elements) that don't resolve to a
 *      real type — validated against the api-corpus (core + DLC types from dump_game_api) AND this
 *      mod's own C# types (scanned from Source/*.cs), so your own classes aren't false-flagged.
 *
 * What it can't do without a running game: verify a defName exists in core/other mods (that stays a
 * post-launch read_rimworld_log job). Unresolved class refs are warnings, not hard errors, because a
 * ref could legitimately belong to a mod dependency not in the corpus.
 */
function localAppData(): string {
    return process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local");
}
function apiCorpusPath(): string {
    if (process.env.RIMAGENTIC_API) return process.env.RIMAGENTIC_API;
    const dir = process.env.RIMAGENTIC_API_DIR || path.join(localAppData(), "RimAgentic", "api");
    return path.join(dir, "api-corpus.jsonl");
}
function workspaceRoot(): string {
    return process.env.RIMAGENTIC_ROOT || process.env.RIMSYNAPSE_ROOT || process.cwd();
}

const SKIP_DIRS = new Set([".git", "node_modules", "obj", "bin", ".vs", "Assemblies"]);

function walk(root: string, ext: string, cap: number): string[] {
    const out: string[] = [];
    const stack = [root];
    while (stack.length && out.length < cap) {
        const dir = stack.pop() as string;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) stack.push(full); }
            else if (e.isFile() && e.name.toLowerCase().endsWith(ext)) { out.push(full); if (out.length >= cap) break; }
        }
    }
    return out;
}

interface TypeIndex { full: Set<string>; short: Set<string>; }

function loadCoreTypes(): TypeIndex | null {
    const p = apiCorpusPath();
    if (!fs.existsSync(p)) return null;
    const full = new Set<string>(), short = new Set<string>();
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
        const t = line.trim(); if (!t) continue;
        try { const r = JSON.parse(t); if (r.full) full.add(r.full); if (r.name) short.add(r.name); } catch { /* skip */ }
    }
    return { full, short };
}

/** Scan a mod's C# source for its own declared types, so references to them aren't flagged. */
function scanLocalTypes(root: string): TypeIndex {
    const full = new Set<string>(), short = new Set<string>();
    for (const f of walk(root, ".cs", 4000)) {
        let src: string;
        try { src = fs.readFileSync(f, "utf8"); } catch { continue; }
        const ns = (src.match(/\bnamespace\s+([A-Za-z0-9_.]+)/) || [])[1] || "";
        const re = /\b(?:class|struct|enum|interface)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(src))) { short.add(m[1]); if (ns) full.add(ns + "." + m[1]); }
    }
    return { full, short };
}

/** Pull the string value out of a parsed node value (handles `<x>Y</x>` and `<x attr=..>Y</x>`). */
function strVal(v: any): string | null {
    if (typeof v === "string") return v.trim();
    if (v && typeof v === "object" && typeof v["#text"] === "string") return String(v["#text"]).trim();
    return null;
}

interface ClassRef { type: string; via: string; file: string; }

function collectClassRefs(node: any, file: string, out: ClassRef[]) {
    if (node == null || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const x of node) collectClassRefs(x, file, out); return; }
    for (const key of Object.keys(node)) {
        const val = node[key];
        if (key === "@_Class") { const s = strVal(val); if (s) out.push({ type: s, via: "Class=", file }); continue; }
        if (/Class$/.test(key)) { const s = strVal(val); if (s) { out.push({ type: s, via: `<${key}>`, file }); continue; } }
        if (val && typeof val === "object") collectClassRefs(val, file, out);
    }
}

function resolveRef(type: string, core: TypeIndex | null, local: TypeIndex): "core" | "local" | null {
    const hasDot = type.includes(".");
    const shortN = hasDot ? (type.split(".").pop() || type) : type;
    if (hasDot) {
        if (core && core.full.has(type)) return "core";
        if (local.full.has(type) || local.short.has(shortN)) return "local"; // lenient for own types
    } else {
        if (core && core.short.has(shortN)) return "core";
        if (local.short.has(shortN)) return "local";
    }
    return null;
}

export const defValidateTools = [
    {
        name: "validate_mod_defs",
        description:
            "Pre-launch check on a mod's Def XML — catch errors WITHOUT launching RimWorld. Reports (1) malformed " +
            "XML with file + line, and (2) C# class references (Class=\"...\" attributes and <*Class> elements) that " +
            "don't resolve to a real type, validated against the api-corpus (core+DLC types from dump_game_api) plus " +
            "this mod's own C# classes (so your own types aren't flagged). Unresolved refs are warnings (could be a " +
            "typo, or a dependency's type). Note: it can't verify a defName exists in core/other mods without a " +
            "running game — that stays a post-launch read_rimworld_log check. Run this after editing Defs, before a " +
            "launch, to skip a wasted test cycle.",
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string", description: "Mod folder (or any folder) to validate. Defaults to the workspace root (RIMAGENTIC_ROOT)." },
                maxFiles: { type: "number", description: "Max XML files to scan (default 3000)." }
            }
        }
    }
];

export async function handleDefValidateTool(name: string, args: any) {
    if (name !== "validate_mod_defs") throw new Error(`Unknown def-validate tool: ${name}`);

    const root = String(args?.path || workspaceRoot());
    if (!root || !fs.existsSync(root)) return errText(`Path not found: ${root || "(no workspace root set)"}. Pass 'path' to a mod folder.`);
    const cap = Math.max(1, Math.min(20000, Number(args?.maxFiles) || 3000));

    const core = loadCoreTypes();
    const local = scanLocalTypes(root);
    const xmlFiles = walk(root, ".xml", cap);

    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", allowBooleanAttributes: true });
    const xmlErrors: any[] = [];
    const refs: ClassRef[] = [];

    for (const file of xmlFiles) {
        let xml: string;
        try { xml = fs.readFileSync(file, "utf8"); } catch { continue; }
        const v: any = XMLValidator.validate(xml, { allowBooleanAttributes: true });
        if (v !== true) {
            xmlErrors.push({ file: path.relative(root, file), line: v?.err?.line, col: v?.err?.col, error: v?.err?.msg });
            continue;
        }
        let tree: any;
        try { tree = parser.parse(xml); } catch (e: any) { xmlErrors.push({ file: path.relative(root, file), error: e?.message || String(e) }); continue; }
        collectClassRefs(tree, file, refs);
    }

    let resolvedCore = 0, resolvedLocal = 0;
    const unresolved = new Map<string, { type: string; via: string; file: string; count: number }>();
    for (const r of refs) {
        const res = resolveRef(r.type, core, local);
        if (res === "core") resolvedCore++;
        else if (res === "local") resolvedLocal++;
        else {
            const key = r.type;
            const ex = unresolved.get(key);
            if (ex) ex.count++;
            else unresolved.set(key, { type: r.type, via: r.via, file: path.relative(root, r.file), count: 1 });
        }
    }

    const unresolvedList = Array.from(unresolved.values()).sort((a, b) => b.count - a.count);
    const okDefs = xmlErrors.length === 0;
    return okText({
        ok: okDefs,
        root,
        filesChecked: xmlFiles.length,
        corpusAvailable: !!core,
        xmlErrors,
        classRefs: {
            total: refs.length,
            resolvedCore,
            resolvedLocal,
            unresolvedCount: unresolvedList.length,
            unresolved: unresolvedList.map(u => ({
                ...u,
                note: "not a core/DLC type or one of this mod's C# classes — check for a typo, or verify it belongs to a mod dependency"
            }))
        },
        summary:
            `${xmlFiles.length} XML file(s): ${xmlErrors.length} malformed` +
            `; class refs ${resolvedCore + resolvedLocal}/${refs.length} resolved` +
            (unresolvedList.length ? `, ${unresolvedList.length} unresolved (warnings)` : "") +
            (core ? "" : ". NOTE: api-corpus not found — class refs checked against this mod's C# only; run dump_game_api for core-type validation.")
    });
}

function okText(obj: any) { return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] }; }
function errText(msg: string) { return { content: [{ type: "text", text: msg }] }; }
