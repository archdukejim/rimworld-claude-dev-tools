import * as fsp from "fs/promises";
import * as path from "path";
import { randomBytes } from "crypto";
import { nut, sharp } from "./pc/native";
import { loadConfig } from "../config";

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

/* ------------------------------------------------------------------------ *
 * Infographic renderer (roadmap #3): generate Vanilla-Expanded-style banners
 * and feature panels as PNGs, entirely from structured input via SVG -> sharp
 * (no headless browser / canvas needed). Two components mirror the VE layout
 * language: a notched "ribbon" section header, and a feature panel with an
 * icon tile + gray content panel (ribbon subtitle, italic flavor quote, body,
 * and an optional key/value stat grid). Themeable via a brand accent colour so
 * an author's images read as their own brand, not a VE clone.
 * ------------------------------------------------------------------------ */

const DEFAULT_ACCENT = "#b9622b"; // warm amber brand accent (VE itself uses ~#a83a3a red)

interface InfographicTheme {
    bg: string; bgEdge: string;
    accent: string; accentHi: string; accentSh: string;
    panel: string; panelEdge: string; chip: string;
    head: string; body: string; flavor: string;
    serif: string; sans: string;
}

/** Clamp+shade a #rrggbb colour by `amt` in [-1,1] (negative darkens, positive lightens). */
function shade(hex: string, amt: number): string {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    const n = m ? parseInt(m[1], 16) : 0xb9622b;
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(c => {
        const v = amt >= 0 ? c + (255 - c) * amt : c * (1 + amt);
        return Math.max(0, Math.min(255, Math.round(v)));
    });
    return "#" + ch.map(c => c.toString(16).padStart(2, "0")).join("");
}

function buildTheme(accent?: string): InfographicTheme {
    const a = /^#?[0-9a-f]{6}$/i.test(String(accent || "")) ? (accent!.startsWith("#") ? accent! : "#" + accent) : DEFAULT_ACCENT;
    return {
        bg: "#1b2838", bgEdge: "#12202e",
        accent: a, accentHi: shade(a, 0.18), accentSh: shade(a, -0.28),
        panel: "#4a4f55", panelEdge: "#2b2f34", chip: "#3a3f45",
        head: "#ffffff", body: "#e7e9ec", flavor: "#b9bcc0",
        serif: "Georgia, 'Times New Roman', serif",
        sans: "'Segoe UI', Verdana, sans-serif",
    };
}

const xmlEsc = (s: any) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Greedy word-wrap by estimated glyph width (avg = fraction of font-size per char). */
function wrapText(text: string, fontSize: number, maxW: number, avg = 0.53): string[] {
    const words = String(text || "").split(/\s+/).filter(Boolean);
    const cw = fontSize * avg;
    const lines: string[] = []; let cur = "";
    for (const w of words) {
        const test = cur ? cur + " " + w : w;
        if (test.length * cw > maxW && cur) { lines.push(cur); cur = w; }
        else cur = test;
    }
    if (cur) lines.push(cur);
    return lines;
}

/** Faint topographic contour texture (low-opacity wavy lines) matching the VE background. */
function contourTexture(w: number, h: number): string {
    let p = "";
    for (let y = -20; y < h + 20; y += 26) {
        let d = `M -20 ${y}`;
        for (let x = 0; x <= w + 40; x += 80) {
            const off = ((x / 80 + y) % 3) * 6 - 6;
            d += ` Q ${x - 40} ${y + off} ${x} ${y - off * 0.5}`;
        }
        p += `<path d="${d}" fill="none" stroke="#ffffff" stroke-opacity="0.03" stroke-width="1.2"/>`;
    }
    return p;
}

/** Notched ribbon-flag path (points inward on the right, like VE section banners). */
function ribbonPath(x: number, y: number, w: number, h: number, notch = 18): string {
    const r = x + w;
    return `M ${x} ${y} L ${r} ${y} L ${r - notch} ${y + h / 2} L ${r} ${y + h} L ${x} ${y + h} Z`;
}

function svgDefs(t: InfographicTheme): string {
    return `<defs>
    <linearGradient id="rib" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${t.accentHi}"/><stop offset="1" stop-color="${t.accentSh}"/>
    </linearGradient>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${t.bg}"/><stop offset="1" stop-color="${t.bgEdge}"/>
    </linearGradient>
    <clipPath id="iconClip"><rect x="12" y="12" width="150" height="150" rx="6"/></clipPath>
  </defs>`;
}

/** Section header banner (default 800x51). */
function renderHeaderSvg(title: string, t: InfographicTheme, width = 800, height = 51): string {
    const rw = Math.min(width - 40, 200 + String(title).length * 13);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    ${svgDefs(t)}
    <rect width="${width}" height="${height}" fill="url(#bg)"/>
    ${contourTexture(width, height)}
    <path d="${ribbonPath(6, 6, rw, height - 12)}" fill="url(#rib)" stroke="${t.accentSh}" stroke-width="1"/>
    <text x="24" y="${height / 2 + 8}" font-family="${t.serif}" font-size="24" fill="${t.head}">${xmlEsc(title)}</text>
  </svg>`;
}

interface StatRow { k?: string; v?: string; iconHref?: string | null; }
interface FeatureOpts {
    title: string; flavor?: string; body?: string; rows?: StatRow[];
    requirements?: string; iconHref?: string | null;
    width?: number; height?: number;
}

/** Feature panel (default 800x300): icon tile + gray content panel. */
function renderFeatureSvg(opts: FeatureOpts, t: InfographicTheme): string {
    const width = opts.width || 800, height = opts.height || 300;
    const pad = 12, iconSize = 150;
    const iconX = pad, iconY = pad;
    const panelX = iconX + iconSize + 14;
    const panelW = width - panelX - pad;
    const panelY = pad, panelH = height - pad * 2;

    const title = String(opts.title || "");
    const ribH = 40, ribW = Math.min(panelW - 20, 150 + title.length * 12);
    let y = panelY + 14;
    let content = "";

    content += `<path d="${ribbonPath(panelX + 14, y, ribW, ribH)}" fill="url(#rib)" stroke="${t.accentSh}"/>`;
    content += `<text x="${panelX + 32}" y="${y + ribH / 2 + 8}" font-family="${t.serif}" font-size="22" fill="${t.head}">${xmlEsc(title)}</text>`;
    y += ribH + 16;

    for (const l of wrapText(opts.flavor || "", 15, panelW - 40, 0.5)) {
        content += `<text x="${panelX + 20}" y="${y}" font-family="${t.serif}" font-style="italic" font-size="15" fill="${t.flavor}">${xmlEsc(l)}</text>`;
        y += 20;
    }
    if (opts.flavor) y += 6;
    for (const l of wrapText(opts.body || "", 16, panelW - 40, 0.52)) {
        content += `<text x="${panelX + 20}" y="${y}" font-family="${t.sans}" font-size="15" fill="${t.body}">${xmlEsc(l)}</text>`;
        y += 21;
    }
    if (Array.isArray(opts.rows) && opts.rows.length) {
        y += 6;
        const hasIcon = opts.rows.some(r => r?.iconHref);
        const step = hasIcon ? 30 : 22;
        const ico = 26;
        for (const r of opts.rows) {
            content += `<text x="${panelX + 20}" y="${y}" font-family="${t.sans}" font-size="15" font-weight="bold" fill="${t.head}">${xmlEsc(r?.k || "")}</text>`;
            if (r?.iconHref) {
                // VE-style "<label> = <icon>" grid row.
                content += `<text x="${panelX + 150}" y="${y}" font-family="${t.sans}" font-size="16" fill="${t.body}">=</text>`;
                content += `<image href="${r.iconHref}" x="${panelX + 172}" y="${y - ico + 6}" width="${ico}" height="${ico}" preserveAspectRatio="xMidYMid meet"/>`;
                if (r?.v) content += `<text x="${panelX + 172 + ico + 8}" y="${y}" font-family="${t.sans}" font-size="15" fill="${t.body}">${xmlEsc(r.v)}</text>`;
            } else {
                content += `<text x="${panelX + 150}" y="${y}" font-family="${t.sans}" font-size="15" fill="${t.body}">${xmlEsc(r?.v || "")}</text>`;
            }
            y += step;
        }
    }

    // Icon tile: embed the supplied image (as a data URI) clipped to the tile, else a neutral chip.
    let iconEl = `<rect x="${iconX}" y="${iconY}" width="${iconSize}" height="${iconSize}" rx="6" fill="${t.chip}" stroke="${t.panelEdge}" stroke-width="2"/>`;
    if (opts.iconHref) {
        iconEl += `<image href="${opts.iconHref}" x="${iconX}" y="${iconY}" width="${iconSize}" height="${iconSize}" preserveAspectRatio="xMidYMid slice" clip-path="url(#iconClip)"/>`;
        iconEl += `<rect x="${iconX}" y="${iconY}" width="${iconSize}" height="${iconSize}" rx="6" fill="none" stroke="${t.panelEdge}" stroke-width="2"/>`;
    }
    // Optional requirements chip is drawn as body text under the icon when there's no icon overlap.
    let reqEl = "";
    if (opts.requirements) {
        const reqLines = wrapText(opts.requirements, 12, iconSize - 12, 0.5);
        const chipH = 20 + reqLines.length * 15;
        const chipY = height - pad - chipH;
        reqEl += `<rect x="${iconX}" y="${chipY}" width="${iconSize}" height="${chipH}" rx="4" fill="${t.chip}" fill-opacity="0.92" stroke="${t.panelEdge}"/>`;
        let ry = chipY + 16;
        reqEl += `<text x="${iconX + 8}" y="${ry}" font-family="${t.sans}" font-size="12" font-weight="bold" fill="${t.head}">Requires:</text>`;
        ry += 15;
        for (const l of reqLines) { reqEl += `<text x="${iconX + 8}" y="${ry}" font-family="${t.sans}" font-size="12" fill="${t.body}">${xmlEsc(l)}</text>`; ry += 15; }
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    ${svgDefs(t)}
    <rect width="${width}" height="${height}" fill="url(#bg)"/>
    ${contourTexture(width, height)}
    ${iconEl}
    ${reqEl}
    <rect x="${panelX}" y="${panelY}" width="${panelW}" height="${panelH}" rx="4" fill="${t.panel}" fill-opacity="0.72" stroke="${t.panelEdge}"/>
    ${content}
  </svg>`;
}

/** Render an SVG string to a PNG under `dir` (default imagesDir); returns saved path + dimensions. */
async function saveSvgPng(svg: string, name: string, dir: string = imagesDir()) {
    await fsp.mkdir(dir, { recursive: true });
    const S = sharp();
    const buf = await S(Buffer.from(svg)).png().toBuffer();
    const out = path.join(dir, name);
    await fsp.writeFile(out, buf);
    const meta = await S(out).metadata();
    return { path: out, name, width: meta.width || null, height: meta.height || null, bytes: buf.length };
}

interface MergeOpts { gap?: number; background?: string; maxHeightPx?: number; maxBytes?: number; chunks?: number; }
interface TileMeta { path: string; w: number; h: number; bytes: number; }

// Self-imposed performance target per merged image. It sits with margin below imgur's 1 MB anonymous
// lossless line (so uploads stay pixel-perfect), and is also about where a single image starts to load
// slowly and risk mobile-decoder downsampling. Long pages auto-split to stay under it.
const PERF_TARGET_BYTES = 700_000;
const IMGUR_LOSSY_ACCOUNT = 5_000_000;

/** Split tiles into n groups of roughly equal stacked height (each group non-empty). */
function evenGroupsByHeight(metas: TileMeta[], n: number): TileMeta[][] {
    const total = metas.reduce((s, m) => s + m.h, 0);
    const target = total / n;
    const groups: TileMeta[][] = [];
    let cur: TileMeta[] = []; let acc = 0; let made = 0;
    for (let i = 0; i < metas.length; i++) {
        cur.push(metas[i]); acc += metas[i].h;
        const remainingTiles = metas.length - 1 - i;
        const groupsLeftAfter = n - 1 - made;
        if (groupsLeftAfter > 0 && acc >= target * (made + 1) && remainingTiles >= groupsLeftAfter) {
            groups.push(cur); cur = []; made++;
        }
    }
    if (cur.length) groups.push(cur);
    return groups;
}

/** Greedily fill groups until adding the next tile would exceed the height or byte budget. */
function fillGroups(metas: TileMeta[], maxH: number, maxBytes: number, gap: number): TileMeta[][] {
    const groups: TileMeta[][] = [];
    let cur: TileMeta[] = []; let curH = 0; let curB = 0;
    for (const m of metas) {
        const addH = m.h + (cur.length ? gap : 0);
        if (cur.length && (curH + addH > maxH || curB + m.bytes > maxBytes)) {
            groups.push(cur); cur = []; curH = 0; curB = 0;
        }
        cur.push(m); curH += (cur.length > 1 ? gap : 0) + m.h; curB += m.bytes;
    }
    if (cur.length) groups.push(cur);
    return groups;
}

/**
 * Stack PNG tiles vertically into one (or a few) tall images written to `dir`. Merging a whole page
 * into ONE image means ONE hosted URL in the description — the URL is all that counts against Steam's
 * ~8,000-char cap, so N tiles collapse to ~1 URL's worth of budget. To keep each image fast to load,
 * pixel-perfect on imgur, and safe on mobile decoders, it splits: `chunks` = exactly N even halves;
 * else fill each image up to `maxBytes` (default the 700 KB performance target) and/or `maxHeightPx`.
 * Byte budgeting uses each source tile's file size (a slight over-estimate of the merged result, so it
 * stays conservatively under target). Returns the saved image(s).
 */
async function mergeTilesVertical(paths: string[], dir: string, baseName: string, opts: MergeOpts = {}) {
    await fsp.mkdir(dir, { recursive: true });
    const S = sharp();
    const gap = Math.max(0, Math.round(opts.gap ?? 0));
    const bg = opts.background || "#1b2838";
    const maxH = Number(opts.maxHeightPx) > 0 ? Math.round(opts.maxHeightPx as number) : Infinity;
    const maxBytes = Number(opts.maxBytes) > 0 ? Math.round(opts.maxBytes as number) : Infinity;

    const metas: TileMeta[] = [];
    for (const p of paths) {
        const m = await S(p).metadata();
        let bytes = 0; try { bytes = (await fsp.stat(p)).size; } catch { /* ignore */ }
        metas.push({ path: p, w: m.width || 0, h: m.height || 0, bytes });
    }
    if (!metas.length) return [];
    const width = Math.max(1, ...metas.map(m => m.w));

    const groups = (opts.chunks && opts.chunks >= 2)
        ? evenGroupsByHeight(metas, Math.min(Math.round(opts.chunks), metas.length))
        : fillGroups(metas, maxH, maxBytes, gap);

    const outputs: { name: string; path: string; width: number; height: number; tiles: number; bytes: number }[] = [];
    for (let gi = 0; gi < groups.length; gi++) {
        const grp = groups[gi];
        const totalH = grp.reduce((s, m, idx) => s + m.h + (idx ? gap : 0), 0);
        const composites: any[] = [];
        let y = 0;
        for (let idx = 0; idx < grp.length; idx++) {
            const m = grp[idx];
            composites.push({ input: m.path, top: y, left: Math.max(0, Math.round((width - m.w) / 2)) });
            y += m.h + gap;
        }
        const buf = await S({ create: { width, height: totalH, channels: 4, background: bg } })
            .composite(composites).png().toBuffer();
        const name = groups.length > 1 ? `${baseName}-${String(gi + 1).padStart(2, "0")}.png` : `${baseName}.png`;
        const outPath = path.join(dir, name);
        await fsp.writeFile(outPath, buf);
        outputs.push({ name, path: outPath, width, height: totalH, tiles: grp.length, bytes: buf.length });
    }
    return outputs;
}

/** Warn if any merged image exceeds the performance target; suggest chunks/maxBytes or an imgur account. */
function imgurSizeWarning(outputs: { name: string; bytes: number }[]): string | undefined {
    const over = outputs.filter(o => o.bytes > PERF_TARGET_BYTES);
    if (!over.length) return undefined;
    const over5 = outputs.filter(o => o.bytes > IMGUR_LOSSY_ACCOUNT);
    const list = over.map(o => `${o.name}=${Math.round(o.bytes / 1024)}KB`).join(", ");
    let msg = `${over.length} merged image(s) exceed the ${Math.round(PERF_TARGET_BYTES / 1000)} KB performance target (${list}). `
        + `imgur recompresses non-animated uploads over 1 MB anonymously / 5 MB with an account (which blurs crisp text), and `
        + `heavier images load slower and can be downsampled on mobile — split with 'chunks' or a smaller 'maxBytes', or upload via an imgur account.`;
    if (over5.length) msg += ` ${over5.length} exceed 5 MB and would be converted to JPEG even with an account.`;
    return msg;
}

/** Read an image file and return a data: URI for inline <image> embedding (for icon tiles). */
async function fileToDataUri(p: string): Promise<string | null> {
    try {
        const buf = await fsp.readFile(p);
        const ext = path.extname(p).toLowerCase();
        const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
        return `data:${mime};base64,${buf.toString("base64")}`;
    } catch { return null; }
}

function safePngName(name?: string): string {
    let base = (name || "").replace(/\.png$/i, "").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!base) base = "infographic-" + randomBytes(4).toString("hex");
    return base + ".png";
}

/* ------------------------------------------------------------------------ *
 * RimWorld texture icon resolver.
 *
 * RimWorld ships Core/DLC art inside Unity .assets bundles (not loose files),
 * so vanilla item icons can't be pulled from disk without asset-bundle
 * extraction (also EULA-restricted to redistribute). MOD textures, however,
 * are loose PNGs under <mod>/[<sub>/]Textures/... — including the author's own
 * mods in the local Mods folder. So we resolve icon refs against loose PNGs:
 * a drop-in icon library the author fills themselves (for any vanilla icons
 * they extract), the local Mods folder, and optionally the 294100 Workshop
 * tree. Resolution mirrors RimWorld's texPath rules: a single <texPath>.png,
 * else a variant folder from which the UI-front variant is chosen.
 * ------------------------------------------------------------------------ */

const iconLibraryDir = () => path.join(localAppData(), "RimAgentic", "icons");

/** Derive the Steam Workshop content dir for RimWorld (294100) from the configured install path. */
function workshopContentDir(): string | null {
    const cfg = loadConfig();
    const base = cfg.rimworldModsDir || cfg.rimworldPath || "";
    // .../steamapps/common/RimWorld/(Mods|RimWorldWin64.exe) -> .../steamapps
    const idx = base.replace(/\\/g, "/").toLowerCase().indexOf("/steamapps/");
    if (idx < 0) return null;
    return path.join(base.slice(0, idx), "steamapps", "workshop", "content", "294100");
}

function defaultIconRoots(searchWorkshop: boolean): string[] {
    const cfg = loadConfig();
    const roots = [iconLibraryDir()];
    if (cfg.rimworldModsDir) roots.push(cfg.rimworldModsDir);
    if (searchWorkshop) { const ws = workshopContentDir(); if (ws) roots.push(ws); }
    return roots;
}

// Variant suffixes RimWorld appends to texture files; lower rank = preferred as the UI-front icon.
function variantRank(baseNoExt: string): number {
    const m = /_(a|b|c|north|south|east|west|\d+)$/i.exec(baseNoExt);
    if (!m) return 0; // no suffix — a plain single file is the best match
    const order: Record<string, number> = { south: 1, a: 2, east: 3, north: 4, west: 5, b: 6, c: 7 };
    return order[m[1].toLowerCase()] ?? 8;
}
const stripVariant = (b: string) => b.replace(/_(a|b|c|north|south|east|west|\d+)$/i, "");

interface IconIndex { keys: Map<string, { file: string; rank: number }>; }
const iconIndexCache = new Map<string, IconIndex>();

/** Walk a root and index every loose PNG under a Textures/ segment by texPath and by bare name. */
async function buildIconIndex(root: string): Promise<IconIndex> {
    const cached = iconIndexCache.get(root);
    if (cached) return cached;
    const keys = new Map<string, { file: string; rank: number }>();
    const put = (key: string, file: string, rank: number) => {
        if (!key) return;
        const prev = keys.get(key);
        if (!prev || rank < prev.rank) keys.set(key, { file, rank });
    };
    async function walk(dir: string, texturesRel: string | null, depth: number) {
        if (depth > 10) return;
        let ents: any[];
        try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (/^(\.git|Source|Assemblies|Sounds|Languages|News)$/i.test(e.name)) continue;
                const isTex = /^Textures$/i.test(e.name);
                await walk(full, isTex ? "" : (texturesRel === null ? null : path.join(texturesRel, e.name)), depth + 1);
            } else if (texturesRel !== null && /\.png$/i.test(e.name)) {
                const baseNoExt = e.name.replace(/\.png$/i, "");
                const rank = variantRank(baseNoExt);
                const relNoExt = path.join(texturesRel, baseNoExt).replace(/\\/g, "/").toLowerCase();
                put(relNoExt, full, rank);                              // full texPath incl. variant
                const relStripped = path.join(texturesRel, stripVariant(baseNoExt)).replace(/\\/g, "/").toLowerCase();
                put(relStripped, full, rank);                           // texPath with variant stripped
                const folder = texturesRel.replace(/\\/g, "/").toLowerCase();
                const folderName = path.basename(texturesRel).toLowerCase();
                if (folderName && folderName === stripVariant(baseNoExt).toLowerCase()) put(folder, full, rank); // variant-folder convention
                put(stripVariant(baseNoExt).toLowerCase(), full, rank); // bare name
            }
        }
    }
    // The icon library holds flat <defName>.png files (not under a Textures/ segment), so treat its
    // root as the texture base; every other root only indexes PNGs beneath a Textures/ directory.
    const isLibrary = path.resolve(root) === path.resolve(iconLibraryDir());
    await walk(root, isLibrary ? "" : null, 0);
    const idx = { keys };
    iconIndexCache.set(root, idx);
    return idx;
}

/** Resolve an icon ref (existing file path, texPath, or bare item name) to an absolute PNG path. */
async function resolveIconPath(ref: string, roots: string[]): Promise<string | null> {
    const raw = String(ref || "").trim();
    if (!raw) return null;
    // 1) An existing file path wins outright.
    try { const st = await fsp.stat(raw); if (st.isFile()) return raw; } catch { /* not a direct path */ }
    // 2) Index lookup by normalized texPath, then by bare basename.
    const norm = raw.replace(/\\/g, "/").replace(/\.png$/i, "").replace(/^textures\//i, "").toLowerCase();
    const baseKey = norm.split("/").pop() || norm;
    for (const root of roots) {
        const idx = await buildIconIndex(root);
        const hit = idx.keys.get(norm) || idx.keys.get(baseKey);
        if (hit) return hit.file;
    }
    return null;
}

async function resolveIconDataUri(ref: string, roots: string[]): Promise<{ path: string; dataUri: string } | null> {
    const p = await resolveIconPath(ref, roots);
    if (!p) return null;
    const dataUri = await fileToDataUri(p);
    return dataUri ? { path: p, dataUri } : null;
}

/** Build icon resolution roots: caller-supplied first, then the library + Mods (+ Workshop if asked). */
function iconRootsFor(iconRoots: any, searchWorkshop: any): string[] {
    const extra = Array.isArray(iconRoots) ? iconRoots.map((r: any) => String(r)).filter(Boolean) : [];
    return [...extra, ...defaultIconRoots(!!searchWorkshop)];
}

/**
 * Render one infographic spec (header or feature) to an SVG string, resolving any icon refs against
 * `roots`. Shared by render_workshop_infographic (single) and compose_workshop_page (many), so both
 * produce identical output. Returns the SVG plus which refs resolved / did not.
 */
async function renderInfographicSpec(spec: any, theme: InfographicTheme, roots: string[]):
    Promise<{ svg: string; resolved: Record<string, string>; unresolved: string[] }> {
    const type = String(spec?.type || "").toLowerCase();
    const title = String(spec?.title || "");
    const width = Number(spec?.width) > 0 ? Number(spec.width) : 800;
    const resolved: Record<string, string> = {};
    const unresolved: string[] = [];
    const resolve = async (ref: string): Promise<string | null> => {
        const hit = await resolveIconDataUri(ref, roots);
        if (hit) { resolved[ref] = hit.path; return hit.dataUri; }
        unresolved.push(ref); return null;
    };

    if (type === "header") {
        const height = Number(spec?.height) > 0 ? Number(spec.height) : 51;
        return { svg: renderHeaderSvg(title, theme, width, height), resolved, unresolved };
    }

    const height = Number(spec?.height) > 0 ? Number(spec.height) : 300;
    let iconHref: string | null = null;
    if (spec?.icon) iconHref = await resolve(String(spec.icon));
    const rows: StatRow[] = [];
    if (Array.isArray(spec?.rows)) {
        for (const r of spec.rows) {
            const row: StatRow = { k: r?.k ? String(r.k) : "", v: r?.v ? String(r.v) : "" };
            if (r?.icon) row.iconHref = await resolve(String(r.icon));
            rows.push(row);
        }
    }
    const svg = renderFeatureSvg({
        title,
        flavor: spec?.flavor ? String(spec.flavor) : "",
        body: spec?.body ? String(spec.body) : "",
        rows,
        requirements: spec?.requirements ? String(spec.requirements) : "",
        iconHref,
        width, height,
    }, theme);
    return { svg, resolved, unresolved };
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
            "— the text you then pass to swh_update_description. The images must ALREADY be hosted at a URL — prefer " +
            "imgur (short i.imgur.com links that render in item descriptions, as Vanilla Expanded does); Steam-hosted " +
            "URLs also work but are ~3x longer and burn more of the ~8,000-char cap. Tip: merge tiles into one tall " +
            "image (merge_workshop_tiles) so a whole page is a single URL. Use 'intro' for a plain-text keyword/SEO " +
            "block (the images aren't indexable). Combines intro + image blocks + optionally your existing " +
            "description (mode: append | prepend | replace).",
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
    },
    {
        name: "render_workshop_infographic",
        description:
            "Generate a Vanilla-Expanded-style infographic PNG for a Workshop description from structured input — " +
            "no screenshot or external tool needed. Two components: type 'header' renders a notched ribbon section " +
            "banner (default 800x51) from a title; type 'feature' renders a feature panel (default 800x300) with a " +
            "left icon tile + optional 'Requires' chip and a gray content panel holding a ribbon subtitle, an italic " +
            "flavor quote, body text, and an optional key/value stat grid. Themeable via 'accent' (a #rrggbb brand " +
            "colour) so the images read as your own brand. Saves a PNG to the workshop-images folder; upload it " +
            "(imgur or Steam) and embed via compose_workshop_bbcode. Build a description by rendering a header + " +
            "several feature panels in order.",
        inputSchema: {
            type: "object",
            properties: {
                type: { type: "string", description: "'header' (ribbon section banner) or 'feature' (icon + content panel)." },
                title: { type: "string", description: "Banner text (header) or the panel's ribbon subtitle (feature)." },
                name: { type: "string", description: "Output file name without extension; generated if omitted." },
                accent: { type: "string", description: `Brand accent colour as #rrggbb (default ${DEFAULT_ACCENT}).` },
                flavor: { type: "string", description: "feature: italic flavor/quote line(s), e.g. the in-game description." },
                body: { type: "string", description: "feature: main body paragraph (auto-wrapped)." },
                rows: {
                    type: "array",
                    description: "feature: stat grid rows. Each is a bold label plus EITHER a text value (v) or a " +
                        "real item texture icon (icon), rendered VE-style as 'label = <icon>'.",
                    items: {
                        type: "object",
                        properties: {
                            k: { type: "string", description: "Row label, e.g. '10 Mining skill'." },
                            v: { type: "string", description: "Text value (used when no icon, or as a suffix after an icon)." },
                            icon: { type: "string", description: "Icon ref: a file path, a RimWorld texPath (e.g. 'Things/Item/Resource/Steel'), or a bare item/texture name. Resolved against loose mod PNGs + the icon library." }
                        }
                    }
                },
                requirements: { type: "string", description: "feature: short text for the 'Requires:' chip under the icon." },
                icon: { type: "string", description: "feature: left tile image — a file path, texPath, or item/texture name (same resolver as row icons)." },
                iconRoots: { type: "array", items: { type: "string" }, description: "Extra folders to resolve icon refs against, searched FIRST (e.g. your mod's project folder). Defaults add the icon library + local Mods dir." },
                searchWorkshop: { type: "boolean", description: "Also resolve icons against the 294100 Steam Workshop mods tree (slower first call; indexed+cached). Default false." },
                width: { type: "number", description: "Override output width (default 800)." },
                height: { type: "number", description: "Override output height (default 51 header / 300 feature)." }
            },
            required: ["type", "title"]
        }
    },
    {
        name: "compose_workshop_page",
        description:
            "Render a whole Vanilla-Expanded-style description page in one call: an ordered list of blocks " +
            "(each a header banner or a feature panel, same fields as render_workshop_infographic) is rendered " +
            "to numbered PNGs in the workshop-images folder, sharing one brand accent and one icon-resolution " +
            "setup. Draft-first: it only generates local images + a manifest — it does NOT upload or change any " +
            "Steam description. Returns { pages:[{order,type,name,path,...}], unresolved, note }. Then upload the " +
            "PNGs in order and pass their URLs to compose_workshop_bbcode.",
        inputSchema: {
            type: "object",
            properties: {
                blocks: {
                    type: "array",
                    description: "Ordered page blocks. Each: { type:'header'|'feature', title, and for feature: flavor?, body?, rows?, requirements?, icon?, width?, height? } — same shape as render_workshop_infographic.",
                    items: { type: "object" }
                },
                accent: { type: "string", description: `Brand accent #rrggbb applied to every block (default ${DEFAULT_ACCENT}).` },
                namePrefix: { type: "string", description: "Prefix for output file names, e.g. 'haulmod' → haulmod-01-header.png. Default 'page'." },
                outDir: { type: "string", description: "Folder to write the tiles into (e.g. the mod's repo '<mod>/workshop-page'). Default the workshop-images folder." },
                merge: { description: "Also stack the tiles into one tall image (one hosted URL for the whole page). true, or { chunks?, maxBytes?, maxHeight?, gap?, background? } to tune. By default auto-splits so each image stays under the 700 KB performance target; chunks:N forces N even halves.", oneOf: [{ type: "boolean" }, { type: "object", properties: { chunks: { type: "number" }, maxBytes: { type: "number" }, maxHeight: { type: "number" }, gap: { type: "number" }, background: { type: "string" } } }] },
                iconRoots: { type: "array", items: { type: "string" }, description: "Extra folders to resolve icon refs against, searched first (applied to all feature blocks)." },
                searchWorkshop: { type: "boolean", description: "Also resolve icons against the 294100 Workshop tree. Default false." }
            },
            required: ["blocks"]
        }
    },
    {
        name: "list_item_icons",
        description:
            "List the icons available in the icon library (%LOCALAPPDATA%\\RimAgentic\\icons) that feature panels " +
            "resolve against — i.e. what dump_item_icons has exported. Read-only. Use it to confirm a defName before " +
            "referencing it as a row/tile icon.",
        inputSchema: {
            type: "object",
            properties: {
                filter: { type: "string", description: "Case-insensitive substring to filter icon names (defNames)." },
                limit: { type: "number", description: "Max names to return (default 200)." }
            }
        }
    },
    {
        name: "resolve_item_icon",
        description:
            "Resolve a single icon ref (file path, RimWorld texPath, or bare defName/item name) to the PNG the " +
            "infographic tools would use, without rendering anything. Read-only — for checking a stat-grid icon " +
            "before composing a page. Returns { found, resolved, rootsSearched }.",
        inputSchema: {
            type: "object",
            properties: {
                ref: { type: "string", description: "The icon ref to resolve: a file path, texPath (e.g. 'Things/Item/Resource/Steel'), or bare name (e.g. 'Steel')." },
                iconRoots: { type: "array", items: { type: "string" }, description: "Extra folders to search first." },
                searchWorkshop: { type: "boolean", description: "Also search the 294100 Workshop tree. Default false." }
            },
            required: ["ref"]
        }
    },
    {
        name: "merge_workshop_tiles",
        description:
            "Stack PNG tiles vertically into one (or a few) tall 800px-wide images. Point this at the tiles from " +
            "compose_workshop_page (or any PNGs) to collapse a whole page into a SINGLE image — so the description " +
            "embeds one hosted URL instead of one per tile, which is what makes the ~8,000-char cap a non-issue. " +
            "Long pages can split via 'maxHeight'. Returns the saved merged image(s). Draft-first: writes files " +
            "only; upload the result to imgur yourself.",
        inputSchema: {
            type: "object",
            properties: {
                images: { type: "array", items: { type: "string" }, description: "Ordered list of PNG file paths to stack, top to bottom." },
                name: { type: "string", description: "Base output name (without extension). Default 'merged'. Chunks become name-01.png, name-02.png…" },
                outDir: { type: "string", description: "Folder to write the merged image(s) into. Default the workshop-images folder." },
                chunks: { type: "number", description: "Split into exactly N evenly-divided (by height) images, e.g. 2 for two halves. Overrides maxBytes/maxHeight." },
                maxBytes: { type: "number", description: "Target max bytes per merged image; fills each up to it then starts a new one. Default 700000 (the 700 KB performance target). Ignored if 'chunks' is set." },
                gap: { type: "number", description: "Vertical gap in px between tiles (default 0 — seamless, like VE)." },
                maxHeight: { type: "number", description: "Max stacked height per image in px; exceeding it starts a new chunk. Combined with maxBytes; ignored if 'chunks' is set." },
                background: { type: "string", description: "Fill colour behind the tiles / in gaps as #rrggbb (default the dark theme background)." }
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
            const jpgs = entries.filter(f => /\.(jpe?g|png)$/i.test(f) && !f.startsWith("_tmp_"));
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

    if (name === "render_workshop_infographic") {
        const type = String(args?.type || "").toLowerCase();
        const title = String(args?.title || "").trim();
        if (type !== "header" && type !== "feature") return errText("'type' must be 'header' or 'feature'.");
        if (!title) return errText("'title' is required.");
        try {
            const theme = buildTheme(args?.accent);
            const roots = iconRootsFor(args?.iconRoots, args?.searchWorkshop);
            const { svg, resolved, unresolved } = await renderInfographicSpec(args, theme, roots);
            const res = await saveSvgPng(svg, safePngName(args?.name));
            return okText({
                ok: true, type, ...res, folder: imagesDir(),
                icons: { resolved, unresolved, rootsSearched: roots },
                note: unresolved.length
                    ? `PNG saved, but ${unresolved.length} icon ref(s) did not resolve (shown as blank): ${unresolved.join(", ")}. Pass 'iconRoots' at the mod's folder, set searchWorkshop:true, populate the library via dump_item_icons, or check the defName with list_item_icons.`
                    : "PNG saved. Upload it (imgur or Steam), then embed via compose_workshop_bbcode."
            });
        } catch (e: any) {
            return errText(`Failed to render infographic: ${e?.message || e}`);
        }
    }

    if (name === "compose_workshop_page") {
        const blocks = Array.isArray(args?.blocks) ? args.blocks : [];
        if (blocks.length === 0) return errText("Provide 'blocks': an ordered array of { type:'header'|'feature', title, ... }.");
        try {
            const theme = buildTheme(args?.accent);
            const roots = iconRootsFor(args?.iconRoots, args?.searchWorkshop);
            const prefix = (String(args?.namePrefix || "page").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")) || "page";
            const outDir = args?.outDir ? String(args.outDir) : imagesDir();
            const pages: any[] = [];
            const allUnresolved: string[] = [];
            for (let i = 0; i < blocks.length; i++) {
                const b = blocks[i] || {};
                const type = String(b?.type || "").toLowerCase();
                if (type !== "header" && type !== "feature") return errText(`blocks[${i}].type must be 'header' or 'feature'.`);
                if (!String(b?.title || "").trim()) return errText(`blocks[${i}].title is required.`);
                const { svg, resolved, unresolved } = await renderInfographicSpec(b, theme, roots);
                const outName = `${prefix}-${String(i + 1).padStart(2, "0")}-${type}.png`;
                const saved = await saveSvgPng(svg, outName, outDir);
                pages.push({ order: i + 1, type, title: b.title, ...saved, iconsResolved: Object.keys(resolved).length ? resolved : undefined });
                allUnresolved.push(...unresolved);
            }

            let merged: any[] | undefined;
            if (args?.merge) {
                const mo = (typeof args.merge === "object" && args.merge) ? args.merge : {};
                const noExplicit = !mo.chunks && !mo.maxHeight && !mo.maxBytes;
                merged = await mergeTilesVertical(pages.map(p => p.path), outDir, `${prefix}-merged`, {
                    gap: mo.gap, background: mo.background || theme.bg,
                    chunks: mo.chunks, maxHeightPx: mo.maxHeight,
                    maxBytes: mo.maxBytes ?? (noExplicit ? PERF_TARGET_BYTES : undefined),
                });
            }

            const mergeWarning = merged ? imgurSizeWarning(merged) : undefined;
            return okText({
                ok: true, count: pages.length, folder: outDir, pages, merged,
                warning: mergeWarning,
                unresolved: allUnresolved,
                note: (merged && merged.length
                    ? `Draft-first: ${pages.length} tiles + ${merged.length} merged image(s) written to ${outDir}. Next: upload the MERGED image(s) to imgur (one URL for the whole page), `
                    : "Draft-first: all page images were generated locally, in order. Next: upload them (imgur) keeping the order, ")
                    + "then compose_workshop_bbcode with the resulting URL(s) + a plain-text keyword intro, then CONFIRM with the user before swh_update_description."
                    + (allUnresolved.length ? ` Note: ${allUnresolved.length} icon ref(s) did not resolve: ${[...new Set(allUnresolved)].join(", ")}.` : "")
            });
        } catch (e: any) {
            return errText(`Failed to compose workshop page: ${e?.message || e}`);
        }
    }

    if (name === "list_item_icons") {
        try {
            const dir = iconLibraryDir();
            let entries: string[] = [];
            try { entries = await fsp.readdir(dir); } catch { return okText({ count: 0, dir, icons: [], note: "Library is empty — populate it with dump_item_icons (from a running game)." }); }
            let names = entries.filter(f => /\.png$/i.test(f)).map(f => f.replace(/\.png$/i, ""));
            const filter = args?.filter ? String(args.filter).toLowerCase() : "";
            if (filter) names = names.filter(n => n.toLowerCase().includes(filter));
            names.sort((a, b) => a.localeCompare(b));
            const total = names.length;
            const limit = Number(args?.limit) > 0 ? Number(args.limit) : 200;
            const shown = names.slice(0, limit);
            return okText({ count: total, shown: shown.length, truncated: total > shown.length, dir, icons: shown });
        } catch (e: any) {
            return errText(`Failed to list item icons: ${e?.message || e}`);
        }
    }

    if (name === "resolve_item_icon") {
        const ref = String(args?.ref || "").trim();
        if (!ref) return errText("'ref' is required (a file path, texPath, or bare defName/item name).");
        try {
            const roots = iconRootsFor(args?.iconRoots, args?.searchWorkshop);
            const p = await resolveIconPath(ref, roots);
            return okText({ ref, found: !!p, resolved: p || null, rootsSearched: roots,
                note: p ? "Use this ref as a row/tile icon in render_workshop_infographic or compose_workshop_page."
                        : "Not found. Check the defName via list_item_icons, pass iconRoots at the mod's folder, set searchWorkshop:true, or run dump_item_icons." });
        } catch (e: any) {
            return errText(`Failed to resolve item icon: ${e?.message || e}`);
        }
    }

    if (name === "merge_workshop_tiles") {
        const images = Array.isArray(args?.images) ? args.images.map((p: any) => String(p)).filter(Boolean) : [];
        if (images.length === 0) return errText("Provide 'images': an ordered array of PNG file paths to stack.");
        for (const p of images) { try { await fsp.access(p); } catch { return errText(`Tile not found: ${p}`); } }
        try {
            const outDir = args?.outDir ? String(args.outDir) : imagesDir();
            const base = (String(args?.name || "merged").replace(/\.png$/i, "").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")) || "merged";
            const hasExplicit = Number(args?.chunks) > 0 || Number(args?.maxHeight) > 0 || Number(args?.maxBytes) > 0;
            const outputs = await mergeTilesVertical(images, outDir, base, {
                gap: Number(args?.gap) || 0,
                chunks: Number(args?.chunks) || undefined,
                maxHeightPx: Number(args?.maxHeight) || undefined,
                maxBytes: Number(args?.maxBytes) || (hasExplicit ? undefined : PERF_TARGET_BYTES),
                background: args?.background ? String(args.background) : undefined,
            });
            return okText({
                ok: true, tilesMerged: images.length, images: outputs, folder: outDir,
                warning: imgurSizeWarning(outputs),
                note: "Draft-first: merged image(s) written. Upload to imgur (one URL per merged image), then embed via compose_workshop_bbcode with a plain-text keyword intro."
            });
        } catch (e: any) {
            return errText(`Failed to merge tiles: ${e?.message || e}`);
        }
    }

    throw new Error(`Unknown workshop-image tool: ${name}`);
}

function okText(obj: any) { return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] }; }
function errText(msg: string) { return { content: [{ type: "text", text: msg }] }; }
