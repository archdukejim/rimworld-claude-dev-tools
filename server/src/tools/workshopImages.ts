import * as fsp from "fs/promises";
import * as path from "path";
import { randomBytes } from "crypto";
import { nut, sharp } from "./pc/native";

/**
 * Steam Workshop image pipeline (roadmap #1): capture RimWorld content and produce Workshop-ready
 * JPEGs so an author can embed "pages" of visual content and beat the ~8,000-character description
 * cap. Captures the screen (or a region) via the same nut-js path pcControl uses, then scales +
 * re-encodes with sharp to a sensible width/quality, saving named files to a persistent folder.
 *
 * Workflow: bring RimWorld to the foreground showing the content (use get_open_windows to confirm
 * which window is up and where), then capture_workshop_image. The produced JPEGs are what you upload
 * to Steam and reference in the description; the upload/embed step is roadmap #2.
 */
function localAppData(): string {
    return process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local");
}
const imagesDir = () => path.join(localAppData(), "RimAgentic", "workshop-images");

// Steam renders description images down to the content column; ~1000px wide is crisp without bloat.
const DEFAULT_MAX_WIDTH = 1000;
const DEFAULT_QUALITY = 85;

function safeName(name?: string): string {
    let base = (name || "").replace(/\.jpe?g$/i, "").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!base) base = "page-" + randomBytes(4).toString("hex");
    return base + ".jpg";
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

/** Grab the screen (or a region of it) to a temp PNG using nut-js; returns the temp path. */
async function grabScreenPng(region?: Crop): Promise<string> {
    const { screen, Region } = nut();
    await fsp.mkdir(imagesDir(), { recursive: true });
    const tmp = path.join(imagesDir(), `_tmp_${randomBytes(8).toString("hex")}.png`);
    const reg = region
        ? new Region(region.left, region.top, region.width, region.height)
        : new Region(0, 0, await screen.width(), await screen.height());
    await screen.captureRegion(tmp, reg);
    return tmp;
}

/** Scale + re-encode a source image to a Workshop-ready JPEG saved under imagesDir. */
async function toWorkshopJpeg(srcPath: string, name: string, maxWidth: number, quality: number, crop: Crop | null) {
    await fsp.mkdir(imagesDir(), { recursive: true });
    const S = sharp();
    let img = S(srcPath);
    if (crop) img = img.extract(crop);
    img = img.resize({ width: Math.max(64, Math.round(maxWidth)), withoutEnlargement: true });
    const buf = await img.jpeg({ quality: Math.max(1, Math.min(100, Math.round(quality))) }).toBuffer();
    const out = path.join(imagesDir(), name);
    await fsp.writeFile(out, buf);
    const meta = await S(out).metadata();
    return { path: out, name, width: meta.width || null, height: meta.height || null, bytes: buf.length };
}

export const workshopImageTools = [
    {
        name: "capture_workshop_image",
        description:
            "Capture the current screen (or a region of it) and save it as a Steam-Workshop-ready JPEG (scaled to " +
            "a sensible width and quality) for embedding in an item description — the way to pack 'pages' of visual " +
            "content past the ~8,000-character cap. Bring RimWorld to the foreground showing what you want first " +
            "(use get_open_windows to confirm which window is up and its rect). Returns the saved file path and " +
            "dimensions. Note: region coordinates are SCREEN pixels; get_open_windows rects are UI pixels, so use " +
            "them as an approximate guide.",
        inputSchema: {
            type: "object",
            properties: {
                name: { type: "string", description: "Output file name (without extension); a unique name is generated if omitted." },
                region: {
                    type: "object",
                    description: "Optional screen region to capture (else the full screen).",
                    properties: {
                        left: { type: "number" }, top: { type: "number" }, width: { type: "number" }, height: { type: "number" }
                    }
                },
                maxWidth: { type: "number", description: `Max output width in px (default ${DEFAULT_MAX_WIDTH}); never enlarged.` },
                quality: { type: "number", description: `JPEG quality 1-100 (default ${DEFAULT_QUALITY}).` }
            }
        }
    },
    {
        name: "make_workshop_image",
        description:
            "Process an EXISTING image file (e.g. a game screenshot PNG, or a page you rendered elsewhere) into a " +
            "Steam-Workshop-ready JPEG: optional crop, scale to a max width, re-encode at a quality, save to the " +
            "workshop-images folder. Use this when you already have the source image and just need the Workshop-" +
            "sized JPEG.",
        inputSchema: {
            type: "object",
            properties: {
                source: { type: "string", description: "Path to the source image file." },
                name: { type: "string", description: "Output file name (without extension); generated if omitted." },
                crop: {
                    type: "object",
                    description: "Optional crop rectangle in source pixels.",
                    properties: {
                        left: { type: "number" }, top: { type: "number" }, width: { type: "number" }, height: { type: "number" }
                    }
                },
                maxWidth: { type: "number", description: `Max output width in px (default ${DEFAULT_MAX_WIDTH}).` },
                quality: { type: "number", description: `JPEG quality 1-100 (default ${DEFAULT_QUALITY}).` }
            },
            required: ["source"]
        }
    },
    {
        name: "list_workshop_images",
        description: "List the Workshop JPEGs produced so far (name, path, dimensions, byte size) from the workshop-images folder. Read-only.",
        inputSchema: { type: "object", properties: {} }
    },
    {
        name: "compose_workshop_bbcode",
        description:
            "Compose Steam Workshop description BBCode that embeds a set of images ('pages') with optional captions " +
            "— the text you then pass to swh_update_description. The images must ALREADY be uploaded to Steam " +
            "(Steam-hosted URLs); Steam strips [img] from non-Steam hosts. See the workshop-images workflow for " +
            "uploading via Claude in Chrome. Combines an optional intro, the image blocks, and optionally your " +
            "existing description (mode: append | prepend | replace).",
        inputSchema: {
            type: "object",
            properties: {
                images: {
                    type: "array",
                    description: "Images to embed, in order.",
                    items: { type: "object", properties: { url: { type: "string" }, caption: { type: "string" } }, required: ["url"] }
                },
                intro: { type: "string", description: "Optional text/BBCode placed before the images." },
                existing: { type: "string", description: "Your current description, to keep alongside the images." },
                mode: { type: "string", description: "append (images after existing, default when existing given) | prepend | replace." }
            },
            required: ["images"]
        }
    }
];

export async function handleWorkshopImageTool(name: string, args: any) {
    if (name === "capture_workshop_image") {
        const region = readCrop(args?.region);
        const outName = safeName(args?.name);
        const maxWidth = Number(args?.maxWidth) > 0 ? Number(args.maxWidth) : DEFAULT_MAX_WIDTH;
        const quality = Number(args?.quality) > 0 ? Number(args.quality) : DEFAULT_QUALITY;
        let tmp: string | null = null;
        try {
            tmp = await grabScreenPng(region || undefined);
            const res = await toWorkshopJpeg(tmp, outName, maxWidth, quality, null);
            return okText({ ok: true, ...res, folder: imagesDir() });
        } catch (e: any) {
            return errText(`Failed to capture Workshop image: ${e?.message || e}`);
        } finally {
            if (tmp) { try { await fsp.unlink(tmp); } catch { /* ignore */ } }
        }
    }

    if (name === "make_workshop_image") {
        const source = String(args?.source || "");
        if (!source) return errText("'source' image path is required.");
        try { await fsp.access(source); } catch { return errText(`Source image not found: ${source}`); }
        const outName = safeName(args?.name);
        const maxWidth = Number(args?.maxWidth) > 0 ? Number(args.maxWidth) : DEFAULT_MAX_WIDTH;
        const quality = Number(args?.quality) > 0 ? Number(args.quality) : DEFAULT_QUALITY;
        try {
            const res = await toWorkshopJpeg(source, outName, maxWidth, quality, readCrop(args?.crop));
            return okText({ ok: true, ...res, folder: imagesDir() });
        } catch (e: any) {
            return errText(`Failed to process Workshop image: ${e?.message || e}`);
        }
    }

    if (name === "list_workshop_images") {
        try {
            const dir = imagesDir();
            let entries: string[] = [];
            try { entries = await fsp.readdir(dir); } catch { return okText({ count: 0, folder: dir, images: [] }); }
            const jpgs = entries.filter(f => /\.jpe?g$/i.test(f));
            const S = sharp();
            const images = [];
            for (const f of jpgs) {
                const p = path.join(dir, f);
                try {
                    const [stat, meta] = await Promise.all([fsp.stat(p), S(p).metadata()]);
                    images.push({ name: f, path: p, width: meta.width || null, height: meta.height || null, bytes: stat.size });
                } catch { /* skip unreadable */ }
            }
            return okText({ count: images.length, folder: dir, images });
        } catch (e: any) {
            return errText(`Failed to list Workshop images: ${e?.message || e}`);
        }
    }

    if (name === "compose_workshop_bbcode") {
        const images = Array.isArray(args?.images) ? args.images : [];
        if (images.length === 0) return errText("Provide 'images': [{ url, caption? }].");
        const blocks: string[] = [];
        for (const im of images) {
            const url = String(im?.url || "").trim();
            if (!url) continue;
            let block = `[img]${url}[/img]`;
            const caption = im?.caption ? String(im.caption).trim() : "";
            if (caption) block += `\n[i]${caption}[/i]`;
            blocks.push(block);
        }
        if (blocks.length === 0) return errText("No valid image URLs supplied.");
        const imagesBlock = blocks.join("\n\n");
        const intro = args?.intro ? String(args.intro).trim() : "";
        const existing = args?.existing ? String(args.existing) : "";
        const mode = String(args?.mode || (existing ? "append" : "replace")).toLowerCase();

        const parts: string[] = [];
        if (intro) parts.push(intro);
        if (mode === "prepend") { parts.push(imagesBlock); if (existing) parts.push(existing); }
        else if (mode === "append") { if (existing) parts.push(existing); parts.push(imagesBlock); }
        else { parts.push(imagesBlock); } // replace
        const bbcode = parts.join("\n\n");
        return okText({ ok: true, images: blocks.length, mode, chars: bbcode.length, bbcode, note: "Pass 'bbcode' to swh_update_description { fileId, description }." });
    }

    throw new Error(`Unknown workshop-image tool: ${name}`);
}

function okText(obj: any) { return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] }; }
function errText(msg: string) { return { content: [{ type: "text", text: msg }] }; }
