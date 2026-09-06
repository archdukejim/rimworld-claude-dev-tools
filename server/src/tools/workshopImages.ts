import * as fsp from "fs/promises";
import * as path from "path";
import { randomBytes } from "crypto";
import { nut, sharp } from "./pc/native";
import { loadConfig } from "../config";
import { checkDescriptionCap, checkLinkDomains, DESCRIPTION_CAP } from "../steamLogic";

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
 * Infographic renderer: description panels as SVG at 800px wide, rasterised
 * to PNG (via sharp; no headless browser / canvas). Real font rendering,
 * never screenshots. Panel heights are derived from content — never fixed.
 * One swappable brand token (ACCENT); everything else is a fixed neutral
 * ramp, so every mod's page shares one visual system.
 * ------------------------------------------------------------------------ */

const DEFAULT_ACCENT = "#c8873a"; // ACCENT — the one swappable brand token

interface InfographicTheme {
    accent: string;                               // the swappable brand token
    bg: string; panel: string; panelEdge: string; // fixed neutral ramp
    title: string; body: string; muted: string;
    onAccent: string;                             // text sitting on accent fills
    font: string;
}

function buildTheme(accent?: string): InfographicTheme {
    const a = /^#?[0-9a-f]{6}$/i.test(String(accent || "")) ? (accent!.startsWith("#") ? accent! : "#" + accent) : DEFAULT_ACCENT;
    return {
        accent: a,
        bg: "#17181a", panel: "#232527", panelEdge: "#34373b",
        title: "#f0ece3", body: "#b6b2a8", muted: "#8b877d", onAccent: "#1a1409",
        font: "Segoe UI, Arial, sans-serif",
    };
}

const xmlEsc = (s: any) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* SVG has no auto-wrap: wrapping is manual, by per-character advance as a fraction of font
 * size. Row values are placed after the measured label width with the same table, so measure
 * and render agree. */
const ADV_NARROW = new Set("iljI!.,;:'|`");
const ADV_THIN = new Set("ft()[]{}/\\-r");
const ADV_WIDE = new Set("mwMW@");
function charAdvance(ch: string): number {
    if (ADV_NARROW.has(ch)) return 0.27;
    if (ADV_THIN.has(ch)) return 0.35;
    if (ADV_WIDE.has(ch)) return 0.83;
    if (ch === " ") return 0.26;
    if (ch >= "A" && ch <= "Z") return 0.63;
    if (ch >= "0" && ch <= "9") return 0.55;
    return 0.52;
}
function measureText(text: string, fontSize: number, bold = false): number {
    let units = 0;
    for (const ch of String(text || "")) units += charAdvance(ch);
    return units * fontSize * (bold ? 1.06 : 1);
}
function wrapText(text: string, fontSize: number, maxW: number, bold = false): string[] {
    const words = String(text || "").split(/\s+/).filter(Boolean);
    const lines: string[] = []; let cur = "";
    for (const w of words) {
        const test = cur ? cur + " " + w : w;
        if (measureText(test, fontSize, bold) > maxW && cur) { lines.push(cur); cur = w; }
        else cur = test;
    }
    if (cur) lines.push(cur);
    return lines;
}

const PAGE_W = 800;

/** Section header ribbon (800x74): a notched-hexagon bar with a centred uppercase title.
 *  Section dividers only — no body copy, no icons. */
function renderHeaderSvg(title: string, t: InfographicTheme): string {
    const W = PAGE_W, H = 74, rh = 46, y = 14, m = 6, notch = 22;
    const pts = [
        [m + notch, y], [W - m - notch, y], [W - m, y + rh / 2],
        [W - m - notch, y + rh], [m + notch, y + rh], [m, y + rh / 2],
    ].map(p => p.join(",")).join(" ");
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="${t.bg}"/>
    <polygon points="${pts}" fill="${t.accent}"/>
    <text x="${W / 2}" y="${y + rh / 2 + 8}" text-anchor="middle" font-family="${t.font}" font-size="23"
      font-weight="700" letter-spacing="2.5" fill="${t.onAccent}">${xmlEsc(String(title).toUpperCase())}</text>
  </svg>`;
}

interface StatRow { k?: string; v?: string; iconHref?: string | null; }
interface FeatureOpts {
    title: string; flavor?: string; body?: string; rows?: StatRow[];
    requirements?: string; iconHref?: string | null;
}

/* Feature panel geometry (800 wide; HEIGHT DERIVED FROM CONTENT — never fixed):
 * outer pad 22, tile 158, gap 20 -> content panel x=200 w=578, inner pad 20, wrap 538.
 * Vertical rhythm inside the panel: top 18 / subtitle +12 / flavor pitch 22.5 (block +8) /
 * body pitch 22.5 (block +6) / rows +10 before at 26 pitch / bottom 18.
 * Type roles (the only three): subtitle 21/700 TITLE; flavor 16.5 italic ACCENT (the one
 * italic line); body 15.5 BODY; rows 15 with bold TITLE label + regular MUTED value. */
const F = {
    pad: 22, tile: 158,
    panelX: 200, panelW: 578, innerPad: 20, wrapW: 538,
    top: 18, bottom: 18,
    subtitleSize: 21, subtitleGap: 12,
    flavorSize: 16.5, flavorPitch: 22.5, flavorGap: 8,
    bodySize: 15.5, bodyPitch: 22.5, bodyGap: 6,
    rowSize: 15, rowPitch: 26, rowsGap: 10, maxRows: 5,
    chipH: 26, chipGap: 8, chipSize: 11.5,
};

function renderFeatureSvg(opts: FeatureOpts, t: InfographicTheme): string {
    const W = PAGE_W;
    const tx = F.panelX + F.innerPad; // text left edge

    const subtitle = String(opts.title || "");
    const flavorLines = opts.flavor ? wrapText(opts.flavor, F.flavorSize, F.wrapW) : [];
    const bodyLines = opts.body ? wrapText(opts.body, F.bodySize, F.wrapW) : [];
    const rows = (Array.isArray(opts.rows) ? opts.rows : []).slice(0, F.maxRows);

    // ---- measure: walk the rhythm once to derive the content height ----
    let y = F.top;
    const subtitleTop = y;
    y += F.subtitleSize;
    if (flavorLines.length || bodyLines.length || rows.length) y += F.subtitleGap;
    const flavorTop = y;
    if (flavorLines.length) {
        y += flavorLines.length * F.flavorPitch;
        if (bodyLines.length || rows.length) y += F.flavorGap;
    }
    const bodyTop = y;
    if (bodyLines.length) {
        y += bodyLines.length * F.bodyPitch;
        if (rows.length) y += F.bodyGap;
    }
    let rowsTop = y;
    if (rows.length) { rowsTop = y + F.rowsGap; y = rowsTop + rows.length * F.rowPitch; }
    const contentH = Math.round(y + F.bottom);

    // Tile column and content panel are centred vertically INDEPENDENTLY of each other —
    // that is what keeps a page of varying-length panels from looking ragged.
    const tileBlockH = F.tile + (opts.requirements ? F.chipGap + F.chipH : 0);
    const H = Math.max(contentH + 2 * F.pad, tileBlockH + 2 * F.pad);
    const panelY = Math.round((H - contentH) / 2);
    const tileY = Math.round((H - tileBlockH) / 2);

    // ---- render ----
    let out = `<rect width="${W}" height="${H}" fill="${t.bg}"/>`;
    out += `<rect x="${F.panelX}" y="${panelY}" width="${F.panelW}" height="${contentH}" rx="8" fill="${t.panel}" stroke="${t.panelEdge}"/>`;

    // Subtitle tab: 5px accent bar at the inner left edge, text 14px right of it.
    const stY = panelY + subtitleTop;
    out += `<rect x="${tx}" y="${stY + 1}" width="5" height="${F.subtitleSize}" rx="2.5" fill="${t.accent}"/>`;
    out += `<text x="${tx + 5 + 14}" y="${(stY + F.subtitleSize * 0.8).toFixed(1)}" font-family="${t.font}" font-size="${F.subtitleSize}" font-weight="700" fill="${t.title}">${xmlEsc(subtitle)}</text>`;

    flavorLines.forEach((l, i) => {
        const by = panelY + flavorTop + i * F.flavorPitch + F.flavorSize * 0.8;
        out += `<text x="${tx}" y="${by.toFixed(1)}" font-family="${t.font}" font-style="italic" font-size="${F.flavorSize}" fill="${t.accent}">${xmlEsc(l)}</text>`;
    });
    bodyLines.forEach((l, i) => {
        const by = panelY + bodyTop + i * F.bodyPitch + F.bodySize * 0.8;
        out += `<text x="${tx}" y="${by.toFixed(1)}" font-family="${t.font}" font-size="${F.bodySize}" fill="${t.body}">${xmlEsc(l)}</text>`;
    });
    rows.forEach((r, i) => {
        const rowTop = panelY + rowsTop + i * F.rowPitch;
        const baseline = rowTop + F.rowPitch / 2 + F.rowSize * 0.3; // centred in the pitch
        const label = String(r?.k || "");
        out += `<circle cx="${tx + 3}" cy="${(baseline - F.rowSize * 0.32).toFixed(1)}" r="3" fill="${t.accent}"/>`;
        const labelX = tx + 14;
        out += `<text x="${labelX}" y="${baseline.toFixed(1)}" font-family="${t.font}" font-size="${F.rowSize}" font-weight="700" fill="${t.title}">${xmlEsc(label)}</text>`;
        let vx = labelX + measureText(label, F.rowSize, true) + 10;
        if (r?.iconHref) { // optional real item texture between label and value
            const ico = 20;
            out += `<image href="${r.iconHref}" x="${vx.toFixed(1)}" y="${(baseline - ico + 4).toFixed(1)}" width="${ico}" height="${ico}" preserveAspectRatio="xMidYMid meet"/>`;
            vx += ico + 8;
        }
        if (r?.v) out += `<text x="${vx.toFixed(1)}" y="${baseline.toFixed(1)}" font-family="${t.font}" font-size="${F.rowSize}" fill="${t.muted}">${xmlEsc(r.v)}</text>`;
    });

    // Tile: rx10 panel card with a 2px accent border; art (tile PNG or resolved icon) fills it.
    let defs = "";
    out += `<rect x="${F.pad}" y="${tileY}" width="${F.tile}" height="${F.tile}" rx="10" fill="${t.panel}"/>`;
    if (opts.iconHref) {
        defs = `<defs><clipPath id="tileR"><rect x="${F.pad}" y="${tileY}" width="${F.tile}" height="${F.tile}" rx="10"/></clipPath></defs>`;
        out += `<image href="${opts.iconHref}" x="${F.pad}" y="${tileY}" width="${F.tile}" height="${F.tile}" preserveAspectRatio="xMidYMid slice" clip-path="url(#tileR)"/>`;
    }
    out += `<rect x="${F.pad}" y="${tileY}" width="${F.tile}" height="${F.tile}" rx="10" fill="none" stroke="${t.accent}" stroke-width="2"/>`;

    // Requires chip under the tile, same width: "Requires: " MUTED + value ACCENT/600, centred.
    if (opts.requirements) {
        const chipY = tileY + F.tile + F.chipGap;
        const label = "Requires:", val = String(opts.requirements);
        const spaceW = 4; // explicit dx — SVG collapses a trailing space inside a tspan
        const totalW = measureText(label, F.chipSize) + spaceW + measureText(val, F.chipSize, true);
        const startX = F.pad + Math.max(6, (F.tile - totalW) / 2);
        out += `<rect x="${F.pad}" y="${chipY}" width="${F.tile}" height="${F.chipH}" rx="5" fill="${t.panel}" stroke="${t.panelEdge}"/>`;
        out += `<text x="${startX.toFixed(1)}" y="${(chipY + F.chipH / 2 + F.chipSize * 0.32).toFixed(1)}" font-family="${t.font}" font-size="${F.chipSize}">`
            + `<tspan fill="${t.muted}">${xmlEsc(label)}</tspan><tspan dx="${spaceW}" font-weight="600" fill="${t.accent}">${xmlEsc(val)}</tspan></text>`;
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${defs}${out}</svg>`;
}

/** Render an SVG string to a PNG under `dir` (default imagesDir); returns saved path + dimensions. */
async function saveSvgPng(svg: string, name: string, dir: string = imagesDir()) {
    await fsp.mkdir(dir, { recursive: true });
    const S = sharp();
    const buf = await S(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
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
    const bg = opts.background || "#17181a";
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
            .composite(composites).png({ compressionLevel: 9 }).toBuffer();
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
    const resolved: Record<string, string> = {};
    const unresolved: string[] = [];
    const resolve = async (ref: string): Promise<string | null> => {
        const hit = await resolveIconDataUri(ref, roots);
        if (hit) { resolved[ref] = hit.path; return hit.dataUri; }
        unresolved.push(ref); return null;
    };

    if (type === "header") return { svg: renderHeaderSvg(title, theme), resolved, unresolved };

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
    }, theme);
    return { svg, resolved, unresolved };
}

/* ------------------------------------------------------------------------ *
 * Feature-panel tile art + inline screenshot blocks.
 *
 * Each feature panel has a ~150px left tile. Fill it with a rendered GLYPH (a
 * small built-in symbol set) or with EXTERNAL art (AI-generated / hand-made):
 * the tile is written as its own PNG next to the page, and if that file already
 * exists it is reused as-is — the "gate" where custom/AI art drops in, and what
 * makes a page cheap to regenerate (swap one tile PNG, re-compose).
 *
 * Screenshots are NOT crammed into the tile — they go inline as their own
 * full-width page blocks (type "image"/"screenshot"), placed right where the
 * feature is described in the text.
 * ------------------------------------------------------------------------ */

const TILE_SIZE = 158;

// Gear is built from 8 radial teeth; kept as a prebuilt string like the others.
const GEAR_GLYPH = (() => {
    let teeth = "";
    for (let k = 0; k < 8; k++) {
        const a = k * Math.PI / 4;
        const x1 = 50 + 17 * Math.cos(a), y1 = 50 + 17 * Math.sin(a);
        const x2 = 50 + 30 * Math.cos(a), y2 = 50 + 30 * Math.sin(a);
        teeth += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
    }
    return `<circle cx="50" cy="50" r="17"/><circle cx="50" cy="50" r="5" fill="COL" stroke="none"/>${teeth}`;
})();

/* Monoline glyphs in a 100x100 box. Stroke/width/caps come from the wrapping <g> (ACCENT, 5,
 * round, fill none) at render time. Allowed exceptions: a small solid accent dot as a focal
 * point (fill="COL" stroke="none") and a fill-opacity 0.18 accent wash to suggest mass.
 * PNL fills with the panel colour (to knock a knob out of a line). Each glyph literally
 * depicts its feature rather than gesturing at the category; gear/check are the fallback of
 * last resort. Draw new ones per mod feature — no emoji, stock icons, or clip art. */
const TILE_GLYPHS: Record<string, string> = {
    crosshair: `<circle cx="50" cy="50" r="28"/><path d="M50 10 V26 M50 74 V90 M10 50 H26 M74 50 H90"/><circle cx="50" cy="50" r="4.5" fill="COL" stroke="none"/>`,
    standoff: `<circle cx="26" cy="50" r="5" fill="COL" stroke="none"/><path d="M46 32 a26 26 0 0 1 0 36 M58 23 a39 39 0 0 1 0 54 M70 14 a52 52 0 0 1 0 72"/>`,
    bipod: `<rect x="42" y="12" width="16" height="22" rx="3"/><path d="M50 34 V52 M50 52 L30 84 M50 52 L70 84 M22 84 H38 M62 84 H78"/>`,
    tracks: `<path d="M18 30 H82 M18 50 H82 M18 70 H82"/><circle cx="60" cy="30" r="7" fill="PNL"/><circle cx="34" cy="50" r="7" fill="PNL"/><circle cx="70" cy="70" r="7" fill="PNL"/>`,
    box: `<rect x="24" y="30" width="52" height="44" rx="3"/><path d="M24 46 H76 M50 30 V74"/>`,
    broom: `<line x1="66" y1="20" x2="44" y2="52"/><path d="M32 52 H56 L62 80 H26 Z"/><path d="M36 64 V80 M44 64 V80 M52 64 V80"/>`,
    backpack: `<rect x="30" y="36" width="40" height="42" rx="9"/><path d="M40 36 v-4 a10 10 0 0 1 20 0 v4"/><rect x="42" y="50" width="16" height="16" rx="3"/>`,
    venn: `<circle cx="42" cy="52" r="17"/><circle cx="58" cy="52" r="17"/>`,
    check: `<circle cx="50" cy="50" r="26"/><path d="M37 51 l9 9 l18 -20"/>`,
    book: `<path d="M50 32 C43 27 31 27 25 30 V72 C31 69 43 69 50 74 C57 69 69 69 75 72 V30 C69 27 57 27 50 32 Z"/><path d="M50 32 V74"/>`,
    wrench: `<path d="M63 22 a16 16 0 0 0 -14 24 L26 69 a7 7 0 0 0 10 10 L59 56 a16 16 0 0 0 20 -22 l-11 11 l-9 -9 z"/>`,
    bolt: `<path d="M54 18 L28 54 H46 L42 82 L72 44 H52 Z"/>`,
    gear: GEAR_GLYPH,
};
const TILE_GLYPH_NAMES = Object.keys(TILE_GLYPHS);

/** Substitute theme colours into a glyph string (COL = accent, PNL = panel). */
function glyphWithTheme(glyph: string, theme: InfographicTheme): string {
    return glyph.replace(/COL/g, theme.accent).replace(/PNL/g, theme.panel);
}

/** Render a tile card (158x158): rx10 panel with a 2px accent border and a monoline glyph
 *  centred in a 100x100 box, or an external art image sliced to fill. */
function renderTileCardSvg(theme: InfographicTheme, opts: { glyph?: string; imageHref?: string }, size = TILE_SIZE): string {
    let content = "";
    if (opts.imageHref) {
        content = `<image href="${opts.imageHref}" x="0" y="0" width="${size}" height="${size}" preserveAspectRatio="xMidYMid slice" clip-path="url(#tileClip)"/>`;
    } else if (opts.glyph && TILE_GLYPHS[opts.glyph]) {
        const pad = ((size - 100) / 2).toFixed(1);
        content = `<g transform="translate(${pad},${pad})" stroke="${theme.accent}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none">${glyphWithTheme(TILE_GLYPHS[opts.glyph], theme)}</g>`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
      <defs><clipPath id="tileClip"><rect width="${size}" height="${size}" rx="10"/></clipPath></defs>
      <rect width="${size}" height="${size}" rx="10" fill="${theme.panel}"/>
      ${content}
      <rect x="1" y="1" width="${size - 2}" height="${size - 2}" rx="10" fill="none" stroke="${theme.accent}" stroke-width="2"/>
    </svg>`;
}

/** A feature block's tile source: an external art file, or a built-in glyph name. */
function normalizeTileSpec(block: any): { glyph?: string; image?: string } | null {
    const t = block?.tile;
    if (t && typeof t === "object") {
        if (t.image) return { image: String(t.image) };
        if (t.glyph) return { glyph: String(t.glyph) };
    }
    if (typeof t === "string" && t) {
        return TILE_GLYPHS[t] ? { glyph: t } : { image: t };
    }
    return null;
}

async function fileExists(p: string): Promise<boolean> { try { await fsp.access(p); return true; } catch { return false; } }

/**
 * Ensure a feature block's tile PNG exists at `<outDir>/<tileName>`. Override gate: if the file is
 * already there (custom / AI art), it is reused untouched unless `regen`. Otherwise it is rendered
 * from the block's `tile` spec (glyph or external image). Returns the tile path, or null if there is
 * nothing to draw (no spec and no existing file).
 */
async function ensureTilePng(block: any, outDir: string, tileName: string, theme: InfographicTheme, regen: boolean): Promise<string | null> {
    const tilePath = path.join(outDir, tileName);
    const exists = await fileExists(tilePath);
    if (exists && !regen) return tilePath;
    const spec = normalizeTileSpec(block);
    if (!spec) return exists ? tilePath : null;
    let imageHref: string | undefined;
    if (spec.image) {
        const uri = await fileToDataUri(spec.image);
        if (!uri) return exists ? tilePath : null;
        imageHref = uri;
    }
    const svg = renderTileCardSvg(theme, { glyph: spec.glyph, imageHref });
    await saveSvgPng(svg, tileName, outDir);
    return tilePath;
}

/** Render a full-width screenshot/image block: the image framed on the page background, + caption. */
async function renderScreenshotSvg(source: string, theme: InfographicTheme, opts: { width?: number; caption?: string }): Promise<string | null> {
    const S = sharp();
    let meta: any;
    try { meta = await S(source).metadata(); } catch { return null; }
    const uri = await fileToDataUri(source);
    if (!uri) return null;
    const W = opts.width && opts.width > 0 ? Math.round(opts.width) : PAGE_W;
    const pad = 22; // aligns with the feature panels' outer pad
    const innerW = W - pad * 2;
    const ar = (meta.height || 1) / (meta.width || 1);
    const imgH = Math.max(1, Math.round(innerW * ar));
    const cap = opts.caption ? String(opts.caption) : "";
    const capH = cap ? 30 : 0;
    const H = pad * 2 + imgH + capH;
    const capEl = cap
        ? `<text x="${W / 2}" y="${pad + imgH + 21}" text-anchor="middle" font-family="${theme.font}" font-style="italic" font-size="14" fill="${theme.muted}">${xmlEsc(cap)}</text>`
        : "";
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <rect width="${W}" height="${H}" fill="${theme.bg}"/>
      <image href="${uri}" x="${pad}" y="${pad}" width="${innerW}" height="${imgH}" preserveAspectRatio="xMidYMid meet"/>
      <rect x="${pad}" y="${pad}" width="${innerW}" height="${imgH}" fill="none" stroke="${theme.panelEdge}" stroke-width="2"/>
      ${capEl}
    </svg>`;
}

/* ------------------------------------------------------------------------ *
 * Preview card: the mod-list preview (640x360) and the Workshop thumbnail
 * (512x512), rendered from ONE source spec so they always match. Gradient
 * ground, 7px accent bars flush top and bottom, centred glyph above the
 * wordmark (title 46/700 TITLE, subtitle 20/600 ls3.5 ACCENT, tagline 17
 * italic MUTED).
 * ------------------------------------------------------------------------ */
function renderPreviewSvg(opts: { title: string; subtitle?: string; tagline?: string; glyphSvg?: string; imageHref?: string },
    t: InfographicTheme, W: number, H: number): string {
    const title = String(opts.title || "");
    const subtitle = opts.subtitle ? String(opts.subtitle).toUpperCase() : "";
    const tagline = opts.tagline ? String(opts.tagline) : "";

    // Shrink the title if it would overflow the card width.
    let titleSize = 46;
    const maxTitleW = W - 60;
    const tw = measureText(title, titleSize, true);
    if (tw > maxTitleW) titleSize = Math.max(24, Math.floor(titleSize * maxTitleW / tw));

    const hasGlyph = !!(opts.glyphSvg || opts.imageHref);
    const glyphBox = 100;
    let contentH = titleSize;
    if (hasGlyph) contentH += glyphBox + 26;
    if (subtitle) contentH += 20 + 16;
    if (tagline) contentH += 17 + 14;

    let y = (H - contentH) / 2;
    let out = "";
    if (hasGlyph) {
        const gx = (W - glyphBox) / 2;
        if (opts.imageHref) {
            out += `<image href="${opts.imageHref}" x="${gx}" y="${y.toFixed(1)}" width="${glyphBox}" height="${glyphBox}" preserveAspectRatio="xMidYMid meet"/>`;
        } else {
            out += `<g transform="translate(${gx},${y.toFixed(1)})" stroke="${t.accent}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none">${opts.glyphSvg}</g>`;
        }
        y += glyphBox + 26;
    }
    out += `<text x="${W / 2}" y="${(y + titleSize * 0.8).toFixed(1)}" text-anchor="middle" font-family="${t.font}" font-size="${titleSize}" font-weight="700" fill="${t.title}">${xmlEsc(title)}</text>`;
    y += titleSize;
    if (subtitle) {
        y += 16;
        out += `<text x="${W / 2}" y="${(y + 16).toFixed(1)}" text-anchor="middle" font-family="${t.font}" font-size="20" font-weight="600" letter-spacing="3.5" fill="${t.accent}">${xmlEsc(subtitle)}</text>`;
        y += 20;
    }
    if (tagline) {
        y += 14;
        out += `<text x="${W / 2}" y="${(y + 13.6).toFixed(1)}" text-anchor="middle" font-family="${t.font}" font-style="italic" font-size="17" fill="${t.muted}">${xmlEsc(tagline)}</text>`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <defs><linearGradient id="pv" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#1e2023"/><stop offset="1" stop-color="#121315"/>
      </linearGradient></defs>
      <rect width="${W}" height="${H}" fill="url(#pv)"/>
      <rect width="${W}" height="7" fill="${t.accent}"/>
      <rect y="${H - 7}" width="${W}" height="7" fill="${t.accent}"/>
      ${out}
    </svg>`;
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
            "Generate one Workshop description panel as a PNG (800px wide, real font rendering — never a " +
            "screenshot) from structured input. type 'header' renders the section ribbon (800x74): a notched " +
            "hexagon bar with a centred uppercase title — section dividers only, no body copy. type 'feature' " +
            "renders a feature panel whose HEIGHT IS DERIVED FROM ITS CONTENT: a left glyph tile (+ optional " +
            "'Requires' chip) and a content panel with subtitle, one italic accent flavor line, body (~40-60 " +
            "words), and up to 5 bullet rows (bold label + muted value — a row is a fact, not a sentence). One " +
            "swappable brand token: 'accent' (#rrggbb); everything else is a fixed neutral ramp. Saves a PNG to " +
            "the workshop-images folder; upload it (imgur or Steam) and embed via compose_workshop_bbcode.",
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
                searchWorkshop: { type: "boolean", description: "Also resolve icons against the 294100 Steam Workshop mods tree (slower first call; indexed+cached). Default false." }
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
                    description: "Ordered page blocks (heights derive from content — never fixed). header: { type:'header', title }. feature: { type:'feature', title, flavor?, body?, rows?, requirements?, " +
                        "tile? } where tile is the left-tile art — { glyph:'<name>' } (built-in: " + TILE_GLYPH_NAMES.join(", ") + ") or { image:'<path>' } (external/AI art), or a string (glyph name or file path). " +
                        "image/screenshot: { type:'image', source:'<png path>', caption?, width? } — a full-width framed screenshot placed inline where a feature is described.",
                    items: { type: "object" }
                },
                accent: { type: "string", description: `Brand accent #rrggbb applied to every block (default ${DEFAULT_ACCENT}).` },
                regenerateTiles: { type: "boolean", description: "Re-render tile art even if a tile PNG already exists (default false — existing tile files, e.g. dropped-in AI art, are reused untouched)." },
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
        name: "render_tile",
        description:
            "Render one feature-panel tile card (158x158, rx10 panel with a 2px accent border) as a PNG — from a " +
            "built-in monoline GLYPH (stroke accent, centred in a 100x100 box) or from an EXTERNAL art image " +
            "(AI-generated / hand-made). Save it next to a page as <prefix>-tile-NN.png and compose_workshop_page " +
            "picks it up via the override gate. Built-in glyphs: " + TILE_GLYPH_NAMES.join(", ") + ". Pick the one " +
            "that literally depicts the feature; gear/check are the fallback of last resort.",
        inputSchema: {
            type: "object",
            properties: {
                glyph: { type: "string", description: `A built-in glyph name: ${TILE_GLYPH_NAMES.join(", ")}.` },
                image: { type: "string", description: "Path to an external art image (AI-generated / custom) to fit into the tile instead of a glyph." },
                name: { type: "string", description: "Output file name without extension (e.g. 'haulmod-tile-02'). Generated if omitted." },
                outDir: { type: "string", description: "Folder to write the tile PNG into. Default the workshop-images folder." },
                accent: { type: "string", description: `Brand accent #rrggbb (default ${DEFAULT_ACCENT}).` },
                size: { type: "number", description: `Tile size in px (default ${TILE_SIZE}).` }
            }
        }
    },
    {
        name: "render_workshop_preview",
        description:
            "Render the mod's preview card from ONE source spec to two PNGs: 640x360 (the mod-list preview) and " +
            "512x512 (the Workshop thumbnail). Gradient ground, accent bars flush top and bottom, a centred " +
            "monoline glyph above the wordmark (title 46/700, letter-spaced accent subtitle, italic muted " +
            "tagline). Uses the same design tokens as the description panels so the whole presence reads as one " +
            "set. Draft-first: writes local files only.",
        inputSchema: {
            type: "object",
            properties: {
                title: { type: "string", description: "Wordmark title (46/700; auto-shrinks if it would overflow)." },
                subtitle: { type: "string", description: "Letter-spaced accent subtitle under the title (rendered uppercase)." },
                tagline: { type: "string", description: "One italic muted line under the subtitle." },
                glyph: { type: "string", description: `Built-in glyph above the wordmark: ${TILE_GLYPH_NAMES.join(", ")}.` },
                image: { type: "string", description: "Path to art shown instead of a glyph (fitted to a 100x100 box)." },
                accent: { type: "string", description: `Brand accent #rrggbb (default ${DEFAULT_ACCENT}).` },
                name: { type: "string", description: "Base output name (default 'preview') → <name>-640x360.png + <name>-512x512.png." },
                outDir: { type: "string", description: "Folder to write into. Default the workshop-images folder." }
            },
            required: ["title"]
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
        // Guardrails (learned on the R&S 0.3.2 publish): Steam caps descriptions at 8,000 characters, and its
        // content check flags unfamiliar link domains — both are cheaper to catch here than after the upload.
        const cap = checkDescriptionCap(bbcode);
        const domains = checkLinkDomains(bbcode);
        const warnings = domains.ok ? [] : [domains.warning!];
        return okText({
            ok: cap.ok, images: blocks.length, mode, chars: bbcode.length, cap: DESCRIPTION_CAP, over: cap.over,
            ...(cap.ok ? {} : { error: cap.message }),
            warnings, links: domains.links, bbcode,
            note: cap.ok
                ? "Pass 'bbcode' to swh_update_description { fileId, description }." + (warnings.length ? " Review the warnings first." : "")
                : "Over the cap — swh_update_description will refuse this. Trim before uploading."
        });
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
            const regenTiles = !!args?.regenerateTiles;
            for (let i = 0; i < blocks.length; i++) {
                let b = blocks[i] || {};
                const type = String(b?.type || "").toLowerCase();
                const seq = String(i + 1).padStart(2, "0");

                // Inline screenshot / image block: framed full-width on the page background.
                if (type === "image" || type === "screenshot") {
                    const src = String(b?.source || b?.image || "");
                    if (!src) return errText(`blocks[${i}] (image) needs a 'source' file path.`);
                    const svg = await renderScreenshotSvg(src, theme, { width: Number(b?.width) || 800, caption: b?.caption });
                    if (!svg) return errText(`blocks[${i}] image not readable: ${src}`);
                    const saved = await saveSvgPng(svg, `${prefix}-${seq}-image.png`, outDir);
                    pages.push({ order: i + 1, type: "image", source: src, ...saved });
                    continue;
                }

                if (type !== "header" && type !== "feature") return errText(`blocks[${i}].type must be 'header', 'feature', or 'image'.`);
                if (!String(b?.title || "").trim()) return errText(`blocks[${i}].title is required.`);

                // Feature tile art: render/reuse a separate tile PNG (glyph or external/AI art) via the gate.
                let tileArt: string | undefined;
                if (type === "feature") {
                    const tilePath = await ensureTilePng(b, outDir, `${prefix}-tile-${seq}.png`, theme, regenTiles);
                    if (tilePath) { b = { ...b, icon: tilePath }; tileArt = tilePath; }
                }

                const { svg, resolved, unresolved } = await renderInfographicSpec(b, theme, roots);
                const outName = `${prefix}-${seq}-${type}.png`;
                const saved = await saveSvgPng(svg, outName, outDir);
                pages.push({ order: i + 1, type, title: b.title, ...saved, tile: tileArt, iconsResolved: Object.keys(resolved).length ? resolved : undefined });
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

    if (name === "render_tile") {
        const glyph = args?.glyph ? String(args.glyph) : "";
        const image = args?.image ? String(args.image) : "";
        if (!glyph && !image) return errText(`Provide 'glyph' (${TILE_GLYPH_NAMES.join(", ")}) or 'image' (a path to art).`);
        if (glyph && !TILE_GLYPHS[glyph]) return errText(`Unknown glyph '${glyph}'. Built-in: ${TILE_GLYPH_NAMES.join(", ")}.`);
        try {
            const theme = buildTheme(args?.accent);
            const size = Number(args?.size) > 0 ? Number(args.size) : TILE_SIZE;
            let imageHref: string | undefined;
            if (image) {
                imageHref = (await fileToDataUri(image)) || undefined;
                if (!imageHref) return errText(`Art image not found or unreadable: ${image}`);
            }
            const svg = renderTileCardSvg(theme, { glyph: glyph || undefined, imageHref }, size);
            const outDir = args?.outDir ? String(args.outDir) : imagesDir();
            const outName = safePngName(args?.name || (glyph ? `tile-${glyph}` : "tile"));
            const res = await saveSvgPng(svg, outName, outDir);
            return okText({ ok: true, ...res, folder: outDir, note: "Tile PNG saved. Reference it from a feature block's tile:{image} or let compose_workshop_page pick it up as <prefix>-tile-NN.png (override gate)." });
        } catch (e: any) {
            return errText(`Failed to render tile: ${e?.message || e}`);
        }
    }

    if (name === "render_workshop_preview") {
        const title = String(args?.title || "").trim();
        if (!title) return errText("'title' is required.");
        const glyph = args?.glyph ? String(args.glyph) : "";
        if (glyph && !TILE_GLYPHS[glyph]) return errText(`Unknown glyph '${glyph}'. Built-in: ${TILE_GLYPH_NAMES.join(", ")}.`);
        try {
            const theme = buildTheme(args?.accent);
            let imageHref: string | undefined;
            if (args?.image) {
                imageHref = (await fileToDataUri(String(args.image))) || undefined;
                if (!imageHref) return errText(`Art image not found or unreadable: ${args.image}`);
            }
            const spec = {
                title,
                subtitle: args?.subtitle ? String(args.subtitle) : undefined,
                tagline: args?.tagline ? String(args.tagline) : undefined,
                glyphSvg: glyph ? glyphWithTheme(TILE_GLYPHS[glyph], theme) : undefined,
                imageHref,
            };
            const outDir = args?.outDir ? String(args.outDir) : imagesDir();
            const base = (String(args?.name || "preview").replace(/\.png$/i, "").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")) || "preview";
            const card = await saveSvgPng(renderPreviewSvg(spec, theme, 640, 360), `${base}-640x360.png`, outDir);
            const thumb = await saveSvgPng(renderPreviewSvg(spec, theme, 512, 512), `${base}-512x512.png`, outDir);
            return okText({ ok: true, folder: outDir, card, thumb, note: "640x360 is the mod-list preview; 512x512 the Workshop thumbnail. Draft-first: files written locally only." });
        } catch (e: any) {
            return errText(`Failed to render preview card: ${e?.message || e}`);
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
