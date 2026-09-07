import * as fs from "fs";
import * as path from "path";
import { XMLParser } from "fast-xml-parser";
import { loadConfig } from "../config";
import { resolveInstalledMods, readModAbout } from "./testing";
import { handleCorpusRegistryTool } from "./corpusRegistry";
import { resolveRimWorldDir, walkXml, strVal, readGameVersion } from "./defXml";

/**
 * build_mod_def_corpus — a registered, graphable corpus over one or more MODS' Def XML (+ Patches),
 * optionally with the base game + DLC defs mixed in so mod→vanilla edges resolve.
 *
 * Where build_def_corpus is a flat game-only catalog, this produces corpus-registry records with
 * relationship fields already extracted, then registers + graphs them in one call:
 *
 *   extends          ParentName inheritance
 *   requiresResearch ResearchProjectDef.prerequisites, ThingDef.researchPrerequisites, RecipeDef.researchPrerequisite(s)
 *   produces         RecipeDef.products keys
 *   consumes         RecipeDef.ingredients thingDefs
 *   costs            ThingDef.costList keys
 *   craftedAt        RecipeDef.recipeUsers
 *   race             PawnKindDef.race
 *   patches          a PatchOperation record → every def its xpaths target
 *   references       every other def id mentioned anywhere in the def (element names and leaf values)
 *
 * Ids: RimWorld defNames are unique per DEF TYPE, not globally (ThingDef "Muffalo" and PawnKindDef "Muffalo"
 * both exist). The first record seen keeps the bare defName as its id; a later same-name record of a
 * DIFFERENT type gets `defName@DefType` (sameNameAs) and one of the SAME type from another mod gets
 * `defName@packageId` (overrides — a real override/conflict). Typed relations resolve to the exact typed
 * record; the generic `references` relation resolves by bare name (first wins).
 *
 * Load folders honour loadFolders.xml (version block ≤ the game version, IfModActive/IfModNotActive judged
 * against the corpus mods + installed DLCs + `activeMods`), else RimWorld's default of root + Common + the
 * best version folder. Defs added by PatchOperationAdd into /Defs become real def records (viaPatch:true).
 */

const IDENT = /^[A-Za-z_][A-Za-z0-9_.]*$/;
const MIN_REF_LEN = 3;
const LUDEON_MODULE_IDS: Record<string, string> = {
    core: "ludeon.rimworld", royalty: "ludeon.rimworld.royalty", ideology: "ludeon.rimworld.ideology",
    biotech: "ludeon.rimworld.biotech", anomaly: "ludeon.rimworld.anomaly", odyssey: "ludeon.rimworld.odyssey"
};

function localAppData(): string {
    return process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local");
}
const outFile = (name: string) => path.join(localAppData(), "RimAgentic", "defs", `mod-corpus-${name}.jsonl`);

export const buildModDefCorpusTool = {
    name: "build_mod_def_corpus",
    description:
        "Build a registered, graphable corpus over one or more MODS' Def XML and Patches (by default with the base " +
        "game + DLC defs mixed in so mod→vanilla edges resolve). Select mods by packageId, name, folder, or a " +
        "packageId regex (e.g. '^(oskarpotocki|vanillaexpanded)\\\\.' for every Vanilla Expanded mod). Honours " +
        "loadFolders.xml for the installed game version. One call registers the corpus AND builds its graph with " +
        "relations extends / requiresResearch / produces / consumes / costs / craftedAt / race / patches / references; " +
        "then search_corpus (filterField 'mod' scopes to one mod, 'source' = mod|game), query_corpus_graph, and " +
        "optionally index_corpus (semantic — slow on large corpora). Patch records (defType 'PatchOperation') link " +
        "to the defs they target. Ids are defNames; a same-name def of another type is 'defName@DefType', a " +
        "same-type override from another mod is 'defName@packageId'.",
    inputSchema: {
        type: "object",
        properties: {
            name: { type: "string", description: "Corpus name (a-z0-9-_). Overwrites an existing corpus of the same name." },
            mods: {
                type: "array", items: { type: "string" },
                description: "Mods to include: packageId (exact, case-insensitive), mod name (exact or substring), or an absolute mod folder."
            },
            packageIdPattern: { type: "string", description: "Regex over packageId (case-insensitive) selecting mods — alternative/addition to 'mods'." },
            modRoots: {
                type: "array", items: { type: "string" },
                description: "Folders to scan for mod checkouts (e.g. a directory of cloned GitHub repos): every subfolder with About/About.xml at its root or one level down is a candidate, and wins over an installed mod with the same packageId. With no 'mods'/'packageIdPattern', every mod found under the roots is included."
            },
            includeGame: { type: "boolean", description: "Also include Core + installed DLC defs (default true) so mod→vanilla edges resolve. Filter them out of searches with filterField 'source' = 'mod'." },
            activeMods: { type: "array", items: { type: "string" }, description: "Extra packageIds to treat as active when judging loadFolders IfModActive/IfModNotActive conditions (corpus mods + installed DLCs are always active)." },
            gameVersion: { type: "string", description: "Override the game version used to pick loadFolders/version folders (default: read from Version.txt, e.g. '1.6')." },
            rimworldPath: { type: "string", description: "RimWorld install folder (auto-detected if omitted)." }
        },
        required: ["name"]
    }
};

type ModPick = { packageId: string; name: string; folder: string; source: string };
type Ctx = { mod: string; modName: string; source: string; file: string; viaPatch?: boolean; compat?: boolean };

function versionKey(v: string): number {
    const m = v.match(/(\d+)\.(\d+)/); return m ? Number(m[1]) * 1000 + Number(m[2]) : -1;
}

/** Which subfolders of a mod load for `gameVersion`, per loadFolders.xml or RimWorld's defaults. */
function resolveLoadFolders(modRoot: string, gameVersion: string, active: Set<string>, parser: XMLParser)
    : { folders: string[]; skipped: string[]; conditional: Set<string>; via: string } {
    const gv = versionKey(gameVersion);
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(modRoot, { withFileTypes: true }); } catch { /* empty */ }
    const lf = entries.find(e => e.isFile() && e.name.toLowerCase() === "loadfolders.xml");
    if (lf) {
        try {
            const tree = parser.parse(fs.readFileSync(path.join(modRoot, lf.name), "utf8"));
            const rootKey = Object.keys(tree).find(k => k.toLowerCase() === "loadfolders");
            const root = rootKey ? tree[rootKey] : null;
            if (root && typeof root === "object") {
                const blocks = Object.keys(root).filter(k => /^v\d+\.\d+$/i.test(k)).sort((a, b) => versionKey(a) - versionKey(b));
                const eligible = blocks.filter(b => versionKey(b) <= gv);
                const pick = eligible.length ? eligible[eligible.length - 1] : (blocks.length ? blocks[0] : null);
                if (pick) {
                    // A version tag repeated in the file (a real-world mod typo) parses as an array of blocks — merge them.
                    const blockList = Array.isArray(root[pick]) ? root[pick] : [root[pick]];
                    const items: any[] = [];
                    for (const b of blockList) {
                        const li = b?.li;
                        if (li !== undefined) items.push(...(Array.isArray(li) ? li : [li]));
                    }
                    const folders: string[] = []; const skipped: string[] = []; const conditional = new Set<string>();
                    for (const it of items) {
                        const text = strVal(it) ?? "";
                        const ifActive = it && typeof it === "object" ? strVal(it["@_IfModActive"]) : null;
                        const ifNot = it && typeof it === "object" ? strVal(it["@_IfModNotActive"]) : null;
                        const isActive = (ids: string) => ids.split(",").map(s => s.trim().toLowerCase()).filter(Boolean).some(id => active.has(id));
                        let ok = true;
                        if (ifActive && !isActive(ifActive)) ok = false;
                        if (ifNot && isActive(ifNot)) ok = false;
                        const rel = text.replace(/^[\\/]+/, "").replace(/[\\/]+$/, "");
                        const folder = rel === "" ? "/" : rel;
                        (ok ? folders : skipped).push(folder);
                        if (ok && (ifActive || ifNot)) conditional.add(folder);
                    }
                    return { folders: [...new Set(folders)], skipped: [...new Set(skipped)], conditional, via: `${lf.name}:${pick}` };
                }
            }
        } catch { /* fall through to defaults */ }
    }
    // RimWorld default: root, Common, and the best matching version folder.
    const folders = ["/"];
    if (entries.some(e => e.isDirectory() && e.name.toLowerCase() === "common")) folders.push("Common");
    const versions = entries.filter(e => e.isDirectory() && /^\d+\.\d+$/.test(e.name)).map(e => e.name)
        .filter(v => versionKey(v) <= gv).sort((a, b) => versionKey(a) - versionKey(b));
    if (versions.length) folders.push(versions[versions.length - 1]);
    return { folders, skipped: [], conditional: new Set<string>(), via: "default" };
}

/**
 * Mod checkouts under the given roots: a subfolder is a mod if About/About.xml sits at its root or one
 * level down (repos that keep the mod in a nested folder). Reads the mod's OWN packageId, not a dependency's.
 */
function scanModRoots(roots: string[]): Array<{ packageId: string; name: string; folder: string; source: string }> {
    const out: Array<{ packageId: string; name: string; folder: string; source: string }> = [];
    const tryMod = (folder: string): boolean => {
        if (!fs.existsSync(path.join(folder, "About", "About.xml"))) return false;
        try {
            const about = readModAbout(folder);
            const packageId = String(about.packageId || "").trim();
            if (!packageId) return false;
            out.push({ packageId, name: String(about.name || path.basename(folder)), folder, source: "folder" });
            return true;
        } catch { return false; }
    };
    for (const root of roots) {
        let entries: fs.Dirent[] = [];
        try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            if (!e.isDirectory() || e.name.startsWith(".")) continue;
            const folder = path.join(root, e.name);
            if (tryMod(folder)) continue;
            let subs: fs.Dirent[] = [];
            try { subs = fs.readdirSync(folder, { withFileTypes: true }); } catch { continue; }
            for (const s of subs) if (s.isDirectory() && !s.name.startsWith(".")) tryMod(path.join(folder, s.name));
        }
    }
    return out;
}

// ---- def extraction -------------------------------------------------------------------------

function lis(v: any): string[] {
    if (v === undefined || v === null) return [];
    const li = (v && typeof v === "object" && !Array.isArray(v)) ? v.li : v;
    if (li === undefined) { const s = strVal(v); return s ? [s] : []; }
    return (Array.isArray(li) ? li : [li]).map(strVal).filter((s): s is string => !!s);
}
function keysOf(v: any): string[] {
    if (!v || typeof v !== "object" || Array.isArray(v)) return [];
    return Object.keys(v).filter(k => !k.startsWith("@_") && k !== "#text");
}
function nonEmpty(a: string[]): string[] | undefined { return a.length ? a : undefined; }

/** Every element name, leaf string, and Class reference inside a def subtree. */
function harvest(node: any, refs: Set<string>, classes: Set<string>, depth = 0) {
    if (depth > 40 || node === null || node === undefined) return;
    if (Array.isArray(node)) { for (const n of node) harvest(n, refs, classes, depth + 1); return; }
    if (typeof node !== "object") {
        const s = strVal(node); if (s && s.length >= MIN_REF_LEN && IDENT.test(s)) refs.add(s);
        return;
    }
    for (const k of Object.keys(node)) {
        const v = node[k];
        if (k === "#text") { harvest(v, refs, classes, depth + 1); continue; }
        if (k.startsWith("@_")) {
            const s = strVal(v);
            if (s && k.toLowerCase() === "@_class") classes.add(s);
            else if (s && k === "@_ParentName" && IDENT.test(s)) refs.add(s);
            continue;
        }
        if (/class$/i.test(k)) { const s = strVal(v); if (s) classes.add(s); continue; }
        if (k !== "li" && k.length >= MIN_REF_LEN && IDENT.test(k)) refs.add(k);
        harvest(v, refs, classes, depth + 1);
    }
}

function defRecord(defType: string, el: any, ctx: Ctx): any | null {
    const defName = strVal(el.defName);
    const nameAttr = strVal(el["@_Name"]);
    if (!defName && !nameAttr) return null;
    const refs = new Set<string>(); const classes = new Set<string>();
    harvest(el, refs, classes);
    const research = [
        ...lis(el.prerequisites), ...lis(el.hiddenPrerequisites),
        ...lis(el.researchPrerequisites), ...lis(el.researchPrerequisite)
    ];
    const consumes: string[] = [];
    const ingList = el.ingredients?.li;
    for (const ing of ingList === undefined ? [] : (Array.isArray(ingList) ? ingList : [ingList])) {
        consumes.push(...lis(ing?.filter?.thingDefs));
    }
    return {
        id: defName || nameAttr,
        defType,
        defName: defName || undefined,
        name: nameAttr || undefined,
        abstract: String(el["@_Abstract"] || "").toLowerCase() === "true" || undefined,
        parent: strVal(el["@_ParentName"]) || undefined,
        label: strVal(el.label) || undefined,
        description: strVal(el.description) || undefined,
        mod: ctx.mod,
        modName: ctx.modName,
        source: ctx.source,
        file: ctx.file,
        viaPatch: ctx.viaPatch || undefined,
        compat: ctx.compat || undefined,   // from a conditional (IfModActive) folder: a compat copy, never wins the bare id
        classes: classes.size ? [...classes] : undefined,
        research: nonEmpty(research),
        produces: nonEmpty(keysOf(el.products)),
        consumes: nonEmpty(consumes),
        costs: nonEmpty(keysOf(el.costList)),
        craftedAt: nonEmpty(lis(el.recipeUsers)),
        race: strVal(el.race) || undefined,
        refs: [...refs]
    };
}

function defsFromRoot(defsRoot: any, ctx: Ctx, out: any[]) {
    if (!defsRoot || typeof defsRoot !== "object") return;
    for (const defType of Object.keys(defsRoot)) {
        if (defType.startsWith("@_") || defType === "#text") continue;
        const val = defsRoot[defType];
        for (const el of Array.isArray(val) ? val : [val]) {
            if (!el || typeof el !== "object") continue;
            const r = defRecord(defType, el, ctx);
            if (r) out.push(r);
        }
    }
}

// ---- patch extraction -----------------------------------------------------------------------

/** `Defs/ThingDef[defName="X"]` → (ThingDef, X); a bare `[defName="X"]` → (undefined, X). */
const XPATH_TARGET = /(?:Defs\/([\w.]+)\s*\[[^\]]*?)?defName\s*=\s*["']([^"']+)["']/g;

type PatchAcc = { xpaths: string[]; classes: string[]; mods: string[]; addedDefs: any[] };

function walkPatchOp(op: any, acc: PatchAcc, depth = 0) {
    if (depth > 30 || !op || typeof op !== "object") return;
    if (Array.isArray(op)) { for (const o of op) walkPatchOp(o, acc, depth + 1); return; }
    const cls = strVal(op["@_Class"]);
    if (cls) acc.classes.push(cls);
    const xp = strVal(op.xpath);
    if (xp) acc.xpaths.push(xp);
    if (op.mods) acc.mods.push(...lis(op.mods));
    if (cls === "PatchOperationAdd" && xp && /^\/?Defs\/?$/.test(xp) && op.value && typeof op.value === "object") acc.addedDefs.push(op.value);
    for (const k of Object.keys(op)) {
        if (k.startsWith("@_") || k === "xpath" || k === "value" || k === "mods") continue;
        const v = op[k];
        if (v && typeof v === "object") walkPatchOp(v, acc, depth + 1);
    }
}

function patchRecords(tree: any, ctx: Ctx, out: any[]) {
    const patchKey = Object.keys(tree || {}).find(k => k.toLowerCase() === "patch");
    const root = patchKey ? tree[patchKey] : null;
    if (!root || typeof root !== "object") return;
    const ops = root.Operation === undefined ? [] : (Array.isArray(root.Operation) ? root.Operation : [root.Operation]);
    ops.forEach((op: any, i: number) => {
        const acc: PatchAcc = { xpaths: [], classes: [], mods: [], addedDefs: [] };
        walkPatchOp(op, acc);
        const targets: Array<{ type?: string; name: string }> = [];
        const seen = new Set<string>();
        for (const xp of acc.xpaths) for (const m of xp.matchAll(XPATH_TARGET)) {
            const key = `${m[1] || ""}:${m[2]}`; if (seen.has(key)) continue; seen.add(key);
            targets.push({ type: m[1] || undefined, name: m[2] });
        }
        const topClass = strVal(op["@_Class"]) || "PatchOperation";
        const names = targets.map(t => t.name);
        out.push({
            id: `patch:${ctx.mod}:${ctx.file.replace(/\\/g, "/")}#${i + 1}`,
            defType: "PatchOperation",
            operation: topClass,
            label: `${topClass}${names.length ? " → " + names.slice(0, 4).join(", ") + (names.length > 4 ? ", …" : "") : ""}`,
            description: acc.xpaths.slice(0, 6).join(" | "),
            mod: ctx.mod, modName: ctx.modName, source: ctx.source, file: ctx.file,
            compat: ctx.compat || undefined,
            classes: [...new Set(acc.classes)],
            conditionMods: acc.mods.length ? [...new Set(acc.mods)] : undefined,
            xpaths: acc.xpaths,
            targetRefs: targets,   // typed, resolved to ids below
            refs: names
        });
        for (const added of acc.addedDefs) defsFromRoot(added, { ...ctx, viaPatch: true }, out);
    });
}

// ---- the tool -------------------------------------------------------------------------------

function parseText(res: any): any {
    try { return JSON.parse(res?.content?.[0]?.text ?? ""); } catch { return { raw: res?.content?.[0]?.text }; }
}

export async function buildModDefCorpus(args: any) {
    const name = String(args?.name || "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (!name) return errText("A valid 'name' (a-z0-9-_) is required.");

    const rwDir = resolveRimWorldDir(args?.rimworldPath);
    const gameVersion = String(args?.gameVersion || (rwDir ? readGameVersion(rwDir) : "") || "1.6");
    const includeGame = args?.includeGame !== false;
    if (includeGame && !rwDir) return errText("RimWorld install not found (needed for includeGame). Pass 'rimworldPath' or set includeGame:false.");

    // --- select mods ---
    const cfg = loadConfig();
    const modRoots: string[] = Array.isArray(args?.modRoots) ? args.modRoots.map(String) : [];
    const scanned = scanModRoots(modRoots);
    const installed = [...resolveInstalledMods({ rimworldModsDir: cfg.rimworldModsDir }), ...scanned];
    const picks = new Map<string, ModPick>();
    const unmatched: string[] = [];
    const selectors: string[] = Array.isArray(args?.mods) ? args.mods.map(String) : [];
    const toPick = (m: { packageId: string; name: string; folder: string; source: any }): ModPick =>
        ({ packageId: m.packageId, name: m.name, folder: m.folder, source: String(m.source) });
    if (modRoots.length && selectors.length === 0 && !args?.packageIdPattern) {
        for (const m of scanned) picks.set(m.packageId.toLowerCase(), toPick(m));
    }
    for (const sel of selectors) {
        const s = sel.trim(); const sl = s.toLowerCase();
        let hit = installed.filter(m => m.packageId.toLowerCase() === sl);
        if (!hit.length) hit = installed.filter(m => m.name.toLowerCase() === sl);
        if (!hit.length && (s.includes("\\") || s.includes("/")) && fs.existsSync(s)) {
            const folder = path.resolve(s);
            const known = installed.find(m => path.resolve(m.folder) === folder);
            hit = [known || { packageId: path.basename(folder).toLowerCase(), name: path.basename(folder), folder, source: "folder" as any }];
        }
        if (!hit.length) hit = installed.filter(m => m.name.toLowerCase().includes(sl));
        if (!hit.length) { unmatched.push(s); continue; }
        for (const m of hit) picks.set(m.packageId.toLowerCase(), { packageId: m.packageId, name: m.name, folder: m.folder, source: String(m.source) });
    }
    if (args?.packageIdPattern) {
        let re: RegExp;
        try { re = new RegExp(String(args.packageIdPattern), "i"); } catch (e: any) { return errText(`Bad packageIdPattern: ${e?.message || e}`); }
        for (const m of installed) if (re.test(m.packageId)) picks.set(m.packageId.toLowerCase(), { packageId: m.packageId, name: m.name, folder: m.folder, source: String(m.source) });
    }
    if (picks.size === 0) return errText(`No mods matched. Unmatched selectors: ${JSON.stringify(unmatched)}. Use list_installed_mods to see packageIds/names.`);

    // --- active set for loadFolders conditions ---
    const active = new Set<string>([...picks.keys()]);
    const gameModules: string[] = [];
    if (rwDir) {
        try {
            for (const e of fs.readdirSync(path.join(rwDir, "Data"), { withFileTypes: true })) {
                if (e.isDirectory() && fs.existsSync(path.join(rwDir, "Data", e.name, "Defs"))) {
                    gameModules.push(e.name);
                    active.add(LUDEON_MODULE_IDS[e.name.toLowerCase()] || `ludeon.rimworld.${e.name.toLowerCase()}`);
                }
            }
        } catch { /* no modules */ }
    }
    for (const a of Array.isArray(args?.activeMods) ? args.activeMods : []) active.add(String(a).toLowerCase());

    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", allowBooleanAttributes: true });
    const records: any[] = [];
    const modReport: any[] = [];

    // --- mods ---
    for (const m of [...picks.values()].sort((a, b) => a.packageId.localeCompare(b.packageId))) {
        const lf = resolveLoadFolders(m.folder, gameVersion, active, parser);
        let defs = 0, patches = 0, files = 0;
        for (const rel of lf.folders) {
            const base = rel === "/" ? m.folder : path.join(m.folder, rel);
            for (const [sub, kind] of [["Defs", "def"], ["Patches", "patch"]] as const) {
                const dir = path.join(base, sub);
                if (!fs.existsSync(dir)) continue;
                for (const file of walkXml(dir, 100000)) {
                    files++;
                    let tree: any;
                    try { tree = parser.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
                    const ctx: Ctx = { mod: m.packageId, modName: m.name, source: "mod", file: path.relative(m.folder, file), compat: lf.conditional.has(rel) || undefined };
                    const before = records.length;
                    if (kind === "def") defsFromRoot(tree?.Defs, ctx, records);
                    else patchRecords(tree, ctx, records);
                    const added = records.length - before;
                    if (kind === "def") defs += added; else patches += added;
                }
            }
        }
        modReport.push({ packageId: m.packageId, name: m.name, source: m.source, folder: m.folder, loadFolders: lf.folders, skippedFolders: lf.skipped.length ? lf.skipped : undefined, via: lf.via, xmlFiles: files, defs, patchRecords: patches });
    }

    // --- game ---
    const gameCounts: Record<string, number> = {};
    if (includeGame && rwDir) {
        for (const module of gameModules) {
            const pid = LUDEON_MODULE_IDS[module.toLowerCase()] || `ludeon.rimworld.${module.toLowerCase()}`;
            const before = records.length;
            for (const file of walkXml(path.join(rwDir, "Data", module, "Defs"), 100000)) {
                let tree: any;
                try { tree = parser.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
                defsFromRoot(tree?.Defs, { mod: pid, modName: module, source: "game", file: path.relative(rwDir, file) }, records);
            }
            gameCounts[module] = records.length - before;
        }
    }
    if (records.length === 0) return errText("No defs or patches found in the selected mods.");

    // --- ids (see header): bare name first-wins; @DefType for cross-type namesakes; @mod for same-type overrides ---
    const idSet = new Set<string>();
    const firstByName = new Map<string, any>();
    const typed = new Map<string, string>();     // "DefType:defName|Name" -> id
    let crossType = 0, overrides = 0;
    // Compat copies (from IfModActive folders) are visited last so the owning mod keeps the bare id.
    const idOrder = [...records].sort((a, b) => Number(!!a.compat) - Number(!!b.compat));
    for (const r of idOrder) {
        if (r.defType === "PatchOperation") { idSet.add(r.id); continue; }
        const base = r.id as string;
        const first = firstByName.get(base);
        if (!first) { firstByName.set(base, r); }
        else if (first.defType !== r.defType) { r.id = `${base}@${r.defType}`; r.sameNameAs = base; crossType++; }
        else { r.id = `${base}@${r.mod}`; r.overrides = first.id; overrides++; }
        while (idSet.has(r.id)) r.id += "+";
        idSet.add(r.id);
        for (const k of [r.defName, r.name]) if (k) { const key = `${r.defType}:${k}`; if (!typed.has(key)) typed.set(key, r.id); }
    }
    const resolveTyped = (defType: string | undefined, v: string): string | null => {
        if (defType) { const t = typed.get(`${defType}:${v}`); if (t) return t; }
        return idSet.has(v) ? v : null;
    };
    const mapTyped = (defType: string, vals: string[] | undefined) =>
        vals ? nonEmpty([...new Set(vals.map(v => resolveTyped(defType, v)).filter((x): x is string => !!x))]) : undefined;

    // --- resolve relation fields against the corpus; drop noise + self ---
    let edgeCandidates = 0;
    for (const r of records) {
        if (r.defType === "PatchOperation") {
            r.targets = nonEmpty([...new Set((r.targetRefs as Array<{ type?: string; name: string }>)
                .map(t => resolveTyped(t.type, t.name)).filter((x): x is string => !!x))]);
            r.targetRefs = nonEmpty(r.targetRefs.map((t: any) => t.type ? `${t.type}:${t.name}` : t.name));
        } else {
            r.parent = r.parent ? (resolveTyped(r.defType, r.parent) || r.parent) : undefined;
            r.research = mapTyped("ResearchProjectDef", r.research);
            r.produces = mapTyped("ThingDef", r.produces);
            r.consumes = mapTyped("ThingDef", r.consumes);
            r.costs = mapTyped("ThingDef", r.costs);
            r.craftedAt = mapTyped("ThingDef", r.craftedAt);
            r.race = r.race ? (resolveTyped("ThingDef", r.race) || undefined) : undefined;
        }
        const own = r.defName || r.name || r.id;
        r.refs = nonEmpty([...new Set((r.refs as string[]).filter(x => x !== own && x !== r.id && idSet.has(x)))]);
        edgeCandidates += r.refs?.length || 0;
    }

    // --- write + register + graph ---
    const file = outFile(name);
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join("\n") + "\n");
    } catch (e: any) { return errText(`Failed to write ${file}: ${e?.message || e}`); }

    const reg = parseText(await handleCorpusRegistryTool("register_corpus", {
        name, recordsPath: file, idField: "id",
        textFields: ["defName", "name", "label", "description", "defType", "modName", "classes", "operation"]
    }));
    if (!reg?.ok) return errText(`register_corpus failed: ${reg?.raw || JSON.stringify(reg)}`);
    const graph = parseText(await handleCorpusRegistryTool("graph_corpus", {
        name,
        edges: [
            { relation: "extends", field: "parent" },
            { relation: "requiresResearch", field: "research" },
            { relation: "produces", field: "produces" },
            { relation: "consumes", field: "consumes" },
            { relation: "costs", field: "costs" },
            { relation: "craftedAt", field: "craftedAt" },
            { relation: "race", field: "race" },
            { relation: "patches", field: "targets" },
            { relation: "references", field: "refs" }
        ]
    }));

    const byType: Record<string, number> = {};
    for (const r of records) if (r.source === "mod") byType[r.defType] = (byType[r.defType] || 0) + 1;
    const topDefTypes = Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([defType, count]) => ({ defType, count }));
    const overrideList = records.filter(r => r.overrides && r.source === "mod").slice(0, 25)
        .map(r => ({ id: r.id, overrides: r.overrides, mod: r.mod, file: r.file }));

    return okText({
        ok: true,
        name,
        gameVersion,
        records: records.length,
        modRecords: records.filter(r => r.source === "mod").length,
        gameRecords: includeGame ? gameCounts : undefined,
        sameNameOtherType: crossType,
        sameTypeOverrides: overrides,
        overridesSample: overrideList.length ? overrideList : undefined,
        referenceEdges: edgeCandidates,
        mods: modReport,
        unmatchedSelectors: unmatched.length ? unmatched : undefined,
        topModDefTypes: topDefTypes,
        graph: graph?.ok ? graph.edgeSourceCounts : graph,
        corpusDir: reg.dir,
        recordsFile: file,
        next: `search_corpus { name: "${name}", query, filterField: "mod"|"defType"|"source", filterValue } · query_corpus_graph { name: "${name}", node, relation, direction, transitive } · index_corpus { name: "${name}" } for semantic search (slow on large corpora).`
    });
}

function okText(obj: any) { return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] }; }
function errText(msg: string) { return { content: [{ type: "text", text: msg }] }; }
