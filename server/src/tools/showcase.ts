import * as fsp from "fs/promises";
import * as path from "path";
import { randomBytes } from "crypto";
import { sharp } from "./pc/native";

/**
 * Showcase store — a persistent gallery of PASSING positive UI test cases, captioned and Steam-ready,
 * that later feeds Steam Workshop description uploads.
 *
 * The ui-test protocol (docs/UI-TESTING.md) produces a screenshot for every positive case that
 * passes. Those shots are exactly the "it works, here's proof" material a Workshop description wants,
 * so `showcase_add` scales each into a Workshop-sized JPEG and records it (caption + element + mod) in
 * a manifest that survives across sessions. When it's time to publish, `showcase_list` gives the
 * files + captions to upload (Claude-in-Chrome file_upload) and then feed to compose_workshop_bbcode
 * as {url, caption} once they're Steam-hosted. Kept separate from workshop-images (ad-hoc capture
 * scratch) so the curated positive-evidence set doesn't get mixed with one-off grabs.
 */
function localAppData(): string {
    return process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local");
}
const showcaseDir = () => path.join(localAppData(), "RimAgentic", "showcase");
const manifestPath = () => path.join(showcaseDir(), "showcase.json");

const DEFAULT_MAX_WIDTH = 1000; // matches the Workshop description column
const DEFAULT_QUALITY = 85;

interface ShowcaseEntry {
    id: string;
    caption: string;
    element?: string;   // the UI element demonstrated (e.g. "Skylight 'Toggle glass' gizmo")
    mod?: string;       // which mod / Workshop item this belongs to
    file: string;       // basename in showcaseDir
    path: string;       // absolute path
    width: number | null;
    height: number | null;
    bytes: number;
    createdAt: string;  // ISO timestamp
}

async function readManifest(): Promise<ShowcaseEntry[]> {
    try {
        const txt = await fsp.readFile(manifestPath(), "utf8");
        const arr = JSON.parse(txt);
        return Array.isArray(arr) ? arr : [];
    } catch { return []; }
}
async function writeManifest(entries: ShowcaseEntry[]): Promise<void> {
    await fsp.mkdir(showcaseDir(), { recursive: true });
    await fsp.writeFile(manifestPath(), JSON.stringify(entries, null, 2), "utf8");
}

function slug(s: string, fallback: string): string {
    const base = (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
    return base || fallback;
}

interface Crop { left: number; top: number; width: number; height: number; }
function readCrop(c: any): Crop | null {
    if (!c) return null;
    const n = (v: any) => Math.max(0, Math.round(Number(v)));
    if ([c.left, c.top, c.width, c.height].some(v => v === undefined || isNaN(Number(v)))) return null;
    const crop = { left: n(c.left), top: n(c.top), width: n(c.width), height: n(c.height) };
    if (crop.width < 1 || crop.height < 1) return null;
    return crop;
}

export const showcaseTools = [
    {
        name: "showcase_add",
        description:
            "Store a PASSING positive UI-test screenshot as a captioned, Steam-ready showcase item, for later Workshop " +
            "description uploads. Scales the source image to a description-sized JPEG and records it (caption, element, " +
            "mod) in a persistent manifest. Call this from the ui-test protocol on each positive case that passes so " +
            "positive evidence accrues over time. Returns the stored entry.",
        inputSchema: {
            type: "object",
            properties: {
                source: { type: "string", description: "Path to the screenshot to store (e.g. a capture_gizmo / capture_game_window / capture_play_settings output)." },
                caption: { type: "string", description: "One-line caption of what the shot demonstrates (shown under the image in the Steam description)." },
                element: { type: "string", description: "The UI element demonstrated (e.g. \"Skylight 'Toggle glass' gizmo\"). Optional." },
                mod: { type: "string", description: "Which mod / Workshop item this belongs to (used to group items for an upload). Optional." },
                maxWidth: { type: "number", description: `Max output width in px (default ${DEFAULT_MAX_WIDTH}); never enlarged.` },
                quality: { type: "number", description: `JPEG quality 1-100 (default ${DEFAULT_QUALITY}).` },
                crop: {
                    type: "object", description: "Optional crop rectangle in source pixels.",
                    properties: { left: { type: "number" }, top: { type: "number" }, width: { type: "number" }, height: { type: "number" } }
                }
            },
            required: ["source", "caption"]
        }
    },
    {
        name: "showcase_list",
        description: "List stored showcase items (passing positive UI cases) with their captions, elements, mod, and file paths — the material for a Steam Workshop description upload. Optionally filter by mod. Read-only.",
        inputSchema: {
            type: "object",
            properties: { mod: { type: "string", description: "Only list items tagged with this mod." } }
        }
    },
    {
        name: "showcase_remove",
        description: "Remove a stored showcase item by id (deletes the manifest entry and its JPEG). Use to prune superseded shots before an upload.",
        inputSchema: {
            type: "object",
            properties: { id: { type: "string", description: "The showcase entry id (from showcase_add / showcase_list)." } },
            required: ["id"]
        }
    }
];

export async function handleShowcaseTool(name: string, args: any) {
    if (name === "showcase_add") {
        const source = String(args?.source || "");
        const caption = String(args?.caption || "").trim();
        if (!source) return errText("'source' image path is required.");
        if (!caption) return errText("'caption' is required — it's the text shown under the image in the description.");
        try { await fsp.access(source); } catch { return errText(`Source image not found: ${source}`); }

        const maxWidth = Number(args?.maxWidth) > 0 ? Number(args.maxWidth) : DEFAULT_MAX_WIDTH;
        const quality = Number(args?.quality) > 0 ? Number(args.quality) : DEFAULT_QUALITY;
        const crop = readCrop(args?.crop);
        const element = args?.element ? String(args.element).trim() : undefined;
        const mod = args?.mod ? String(args.mod).trim() : undefined;

        try {
            await fsp.mkdir(showcaseDir(), { recursive: true });
            const id = randomBytes(6).toString("hex");
            const fileName = `${mod ? slug(mod, "mod") + "-" : ""}${slug(element || caption, "item")}-${id}.jpg`;

            const S = sharp();
            let img = S(source);
            if (crop) img = img.extract(crop);
            img = img.resize({ width: Math.max(64, Math.round(maxWidth)), withoutEnlargement: true });
            const buf = await img.jpeg({ quality: Math.max(1, Math.min(100, Math.round(quality))) }).toBuffer();
            const outPath = path.join(showcaseDir(), fileName);
            await fsp.writeFile(outPath, buf);
            const meta = await S(outPath).metadata();

            const entry: ShowcaseEntry = {
                id, caption, element, mod, file: fileName, path: outPath,
                width: meta.width || null, height: meta.height || null, bytes: buf.length,
                createdAt: new Date().toISOString()
            };
            const entries = await readManifest();
            entries.push(entry);
            await writeManifest(entries);

            return okText({ ok: true, entry, total: entries.length, folder: showcaseDir(), note: "To publish: upload these JPEGs to Steam (Claude-in-Chrome file_upload), then compose_workshop_bbcode with {url, caption} and swh_update_description." });
        } catch (e: any) {
            return errText(`Failed to add showcase item: ${e?.message || e}`);
        }
    }

    if (name === "showcase_list") {
        const mod = args?.mod ? String(args.mod).trim().toLowerCase() : null;
        const entries = await readManifest();
        const filtered = mod ? entries.filter(e => (e.mod || "").toLowerCase() === mod) : entries;
        return okText({ count: filtered.length, folder: showcaseDir(), items: filtered });
    }

    if (name === "showcase_remove") {
        const id = String(args?.id || "").trim();
        if (!id) return errText("'id' is required.");
        const entries = await readManifest();
        const idx = entries.findIndex(e => e.id === id);
        if (idx < 0) return errText(`No showcase item with id '${id}'.`);
        const [removed] = entries.splice(idx, 1);
        try { await fsp.unlink(removed.path); } catch { /* file already gone */ }
        await writeManifest(entries);
        return okText({ ok: true, removed: removed.id, remaining: entries.length });
    }

    throw new Error(`Unknown showcase tool: ${name}`);
}

function okText(obj: any) { return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] }; }
function errText(msg: string) { return { content: [{ type: "text", text: msg }] }; }
