import * as fs from "fs";
import * as path from "path";

/**
 * Small helpers shared by the Def-corpus builders (game-only build_def_corpus and the mod-aware
 * build_mod_def_corpus). Kept in their own module so the two builders don't import each other.
 */

/** Resolve the RimWorld install directory (the folder containing Data/) from an arg or common locations. */
export function resolveRimWorldDir(arg?: string): string | null {
    const cands: string[] = [];
    if (arg) cands.push(arg.replace(/[\\/]?RimWorldWin64\.exe$/i, "").replace(/[\\/]+$/, ""));
    if (process.env.RIMWORLD_PATH) cands.push(process.env.RIMWORLD_PATH.replace(/[\\/]?RimWorldWin64\.exe$/i, ""));
    cands.push("C:\\Program Files (x86)\\Steam\\steamapps\\common\\RimWorld");
    cands.push("C:\\GOG Games\\RimWorld");
    for (const c of cands) { if (c && fs.existsSync(path.join(c, "Data"))) return c; }
    return null;
}

/** Every .xml file under root (recursive), capped. */
export function walkXml(root: string, cap: number): string[] {
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

/** The scalar text of a parsed XML node (string / number / boolean / { "#text" }), or null. */
export function strVal(v: any): string | null {
    if (typeof v === "string") return v.trim();
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (v && typeof v === "object" && v["#text"] !== undefined) return String(v["#text"]).trim();
    return null;
}

/** The game's "major.minor" version (e.g. "1.6") from <RimWorld>/Version.txt, or null. */
export function readGameVersion(rimworldDir: string): string | null {
    try {
        const m = fs.readFileSync(path.join(rimworldDir, "Version.txt"), "utf8").match(/(\d+)\.(\d+)/);
        return m ? `${m[1]}.${m[2]}` : null;
    } catch { return null; }
}
