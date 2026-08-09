import * as fs from "fs";
import * as path from "path";

/**
 * RimSort throws two startup dialogs that are pure noise for a mod DEVELOPER working with local /
 * unpublished mods: "Mods with Missing Properties" (fires for every local mod lacking a Steam
 * PublishedFileId) and "Duplicate mods". Both are RimSort-side nuisances, not defects in the mods,
 * so the correct fix is RimSort-side too — and RimSort exposes exactly the levers we need:
 *   - Duplicate warning: settings.json `duplicate_mods_warning: false`.
 *   - Missing-properties: an ignore list at <RimSort>/dbs/ignore.json ({"ignored_mods":[packageid,…]}),
 *     read live (no restart). We auto-populate it by scanning the configured local mods folder for
 *     mods that have no About/PublishedFileId.txt — i.e. exactly the ones RimSort flags — so a dev
 *     never has to click "add to ignore list" per mod again.
 */

function localAppData(): string {
    return process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local");
}
function rimsortDir(): string {
    return process.env.RIMSORT_DIR?.trim() || path.join(localAppData(), "RimSort");
}
const settingsPath = () => path.join(rimsortDir(), "settings.json");
const ignorePath = () => path.join(rimsortDir(), "dbs", "ignore.json");

function okText(obj: any) { return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] }; }
function errText(msg: string) { return { content: [{ type: "text" as const, text: msg }] }; }

export const rimsortTools = [
    {
        name: "suppress_rimsort_warnings",
        description:
            "Silence RimSort's noisy startup dialogs for a mod developer: the 'Mods with Missing Properties' popup " +
            "(fires for every local/unpublished mod that has no Steam PublishedFileId) and the 'Duplicate mods' popup. " +
            "Sets settings.json duplicate_mods_warning=false, and auto-adds every local mod missing " +
            "About/PublishedFileId.txt to RimSort's ignore list (<RimSort>/dbs/ignore.json) so you never click " +
            "'add to ignore list' per mod again. Read live by RimSort — no restart. Idempotent; safe to re-run after " +
            "adding new dev mods. Touches only RimSort's own config, never your mods.",
        inputSchema: {
            type: "object",
            properties: {
                suppressDuplicates: { type: "boolean", description: "Set duplicate_mods_warning=false (default true)." },
                suppressMissingProperties: { type: "boolean", description: "Ignore-list local mods missing PublishedFileId.txt (default true)." },
                extraPackageIds: { type: "array", items: { type: "string" }, description: "Additional packageIds to add to RimSort's ignore list." },
                localModsFolder: { type: "string", description: "Override the mods folder to scan (default: RimSort's current instance local_folder)." }
            }
        }
    }
];

export async function handleRimsortTool(name: string, args: any) {
    if (name !== "suppress_rimsort_warnings") throw new Error(`Unknown rimsort tool: ${name}`);

    const suppressDuplicates = args.suppressDuplicates !== false;
    const suppressMissing = args.suppressMissingProperties !== false;

    if (!fs.existsSync(settingsPath())) {
        return errText(
            `RimSort settings not found at ${settingsPath()}. Is RimSort installed for this user? ` +
            `Set RIMSORT_DIR to its data folder if it lives elsewhere.`
        );
    }

    let settings: any;
    try { settings = JSON.parse(fs.readFileSync(settingsPath(), "utf8")); }
    catch (e: any) { return errText(`Failed to read RimSort settings.json: ${e?.message || e}`); }

    const result: any = { settingsPath: settingsPath() };

    // 1) Duplicate-mods popup — a single settings toggle.
    if (suppressDuplicates) {
        if (settings.duplicate_mods_warning !== false) {
            settings.duplicate_mods_warning = false;
            try { fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 4)); }
            catch (e: any) { return errText(`Failed to write RimSort settings.json: ${e?.message || e}`); }
            result.duplicateMods = "disabled (was on)";
        } else {
            result.duplicateMods = "already disabled";
        }
    }

    // 2) Missing-properties popup — ignore-list every local mod without a PublishedFileId.txt.
    if (suppressMissing) {
        const folder = args.localModsFolder?.trim() || currentLocalFolder(settings);
        if (!folder) {
            result.missingProperties = "SKIPPED — could not resolve RimSort's local mods folder; pass localModsFolder.";
        } else if (!fs.existsSync(folder)) {
            result.missingProperties = `SKIPPED — local mods folder does not exist: ${folder}`;
        } else {
            const scanned = scanLocalModsMissingPfid(folder);
            const extra = Array.isArray(args.extraPackageIds) ? args.extraPackageIds.map(String) : [];
            const toIgnore = dedupe([...scanned.packageIds, ...extra].filter(Boolean));
            const merged = mergeIgnoreList(toIgnore);
            result.missingProperties = {
                localModsFolder: folder,
                ignoreFile: ignorePath(),
                scannedMods: scanned.total,
                missingPfid: scanned.packageIds.length,
                added: merged.added,
                totalIgnored: merged.total,
                ignoredPackageIds: merged.all,
                skippedNoPackageId: scanned.noPackageId
            };
        }
    }

    result.note = "RimSort reads these live — reopen the dialog or restart RimSort to confirm it's gone. Only RimSort config was changed; your mods were not touched.";
    return okText(result);
}

/** RimSort's active instance local mods folder from settings.json. */
function currentLocalFolder(settings: any): string | null {
    const inst = settings?.current_instance;
    const folder = settings?.instances?.[inst]?.local_folder;
    return typeof folder === "string" && folder ? folder : null;
}

/** Scan a mods folder; collect packageIds of mods that have no About/PublishedFileId.txt (excluding official Ludeon mods). */
function scanLocalModsMissingPfid(folder: string): { packageIds: string[]; total: number; noPackageId: string[] } {
    const packageIds: string[] = [];
    const noPackageId: string[] = [];
    let total = 0;
    let dirs: fs.Dirent[] = [];
    try { dirs = fs.readdirSync(folder, { withFileTypes: true }); } catch { return { packageIds, total, noPackageId }; }

    for (const d of dirs) {
        const modDir = path.join(folder, d.name);
        // Follow symlinks/junctions — dev mods are commonly symlinked into the Mods folder, and
        // Dirent.isDirectory() is false for a symlink. statSync follows the link; skip broken ones.
        let isDir = d.isDirectory();
        if (!isDir && (d.isSymbolicLink() || d.isFile())) {
            try { isDir = fs.statSync(modDir).isDirectory(); } catch { isDir = false; }
        }
        if (!isDir) continue;
        const aboutXml = findAboutXml(modDir);
        if (!aboutXml) continue; // not a mod folder
        total++;
        const hasPfid = findFileCI(path.join(modDir, "About"), "PublishedFileId.txt") !== null;
        if (hasPfid) continue;
        const pid = readPackageId(aboutXml);
        if (!pid) { noPackageId.push(d.name); continue; }
        if (pid.toLowerCase().startsWith("ludeon.")) continue; // official mods are never flagged
        packageIds.push(pid);
    }
    return { packageIds, total, noPackageId };
}

function findAboutXml(modDir: string): string | null {
    return findFileCI(path.join(modDir, "About"), "About.xml");
}

/** Case-insensitive lookup of a single file within a directory (Windows is CI, but be safe). */
function findFileCI(dir: string, fileName: string): string | null {
    const direct = path.join(dir, fileName);
    if (fs.existsSync(direct)) return direct;
    try {
        const hit = fs.readdirSync(dir).find(f => f.toLowerCase() === fileName.toLowerCase());
        return hit ? path.join(dir, hit) : null;
    } catch { return null; }
}

function readPackageId(aboutXmlPath: string): string | null {
    try {
        const xml = fs.readFileSync(aboutXmlPath, "utf8");
        const m = xml.match(/<packageId>\s*([^<\s]+)\s*<\/packageId>/i);
        return m ? m[1].trim() : null;
    } catch { return null; }
}

/** Merge packageIds into RimSort's ignore.json ({"ignored_mods":[…]}), preserving existing entries. */
function mergeIgnoreList(packageIds: string[]): { added: number; total: number; all: string[] } {
    let existing: string[] = [];
    try {
        const data = JSON.parse(fs.readFileSync(ignorePath(), "utf8"));
        if (Array.isArray(data)) existing = data.map(String);
        else if (data && Array.isArray(data.ignored_mods)) existing = data.ignored_mods.map(String);
    } catch { /* no file yet */ }

    const set = new Set(existing);
    let added = 0;
    for (const p of packageIds) if (!set.has(p)) { set.add(p); added++; }
    const all = [...set].sort();

    fs.mkdirSync(path.dirname(ignorePath()), { recursive: true });
    fs.writeFileSync(ignorePath(), JSON.stringify({
        ignored_mods: all,
        description: "Mods to ignore when checking for missing properties (identified by packageid)"
    }, null, 4));
    return { added, total: all.length, all };
}

function dedupe(arr: string[]): string[] { return [...new Set(arr)]; }
