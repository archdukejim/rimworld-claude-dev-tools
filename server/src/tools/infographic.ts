import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as http from "http";
import { execFile } from "child_process";
import { createHash, randomBytes } from "crypto";
import { loadConfig } from "../config";
import { sharp } from "./pc/native";
import { handleImgurTool } from "./imgur";
import { handleWorkshopImageTool } from "./workshopImages";
import { CdpPage, CDP_PORT_DEFAULT, openTab, closeTab, sleep } from "./cdp";

/*
 * Infographic pipeline: author a themed HTML infographic -> render it to a crisp PNG headlessly ->
 * publish it to a mod's destinations (GitHub edition repos + Steam Workshop handoff).
 *
 * The renderer is the load-bearing piece, and every flag below was learned the hard way:
 *   - HTML is served over a loopback HTTP server with `Content-Type: text/html; charset=utf-8`.
 *     Feeding Chrome a file (or serving without the charset) turns `→ ✓ · ○ ◐` into mojibake
 *     (`â†' âœ" Â·`). A <meta charset> is also injected when the source lacks one — belt and braces.
 *   - `--virtual-time-budget=<ms>` makes Chrome fast-forward through async work (JS-built DOM,
 *     Google Fonts arriving over the network) BEFORE the capture. Without it you screenshot a
 *     blank or unstyled page. Virtual time suspends while fetches are in flight, so fonts land.
 *   - `--force-device-scale-factor=2` renders at 2x for a crisp PNG (output pixels = window-size x 2).
 *   - Theme is FORCED by injecting `document.documentElement.setAttribute('data-theme', ...)` —
 *     artifact-style HTML is theme-aware (bare :root = light; [data-theme]/media queries = dark),
 *     and relying on the OS theme makes renders non-deterministic.
 *   - Height is MEASURED, not guessed: pass 1 runs `--dump-dom` with an injected script that keeps
 *     writing document.documentElement.scrollHeight into a `data-rs-h` attribute; pass 2 screenshots
 *     at exactly that height, so the PNG has no dead background margin at the bottom.
 *
 * Full docs incl. the publish workflow: docs/INFOGRAPHICS.md.
 */

function localAppData(): string {
    return process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local");
}
const infographicsDir = () => path.join(localAppData(), "RimAgentic", "infographics");
const handoffDir = () => path.join(infographicsDir(), "handoff");

// ---------------------------------------------------------------------------- browser discovery

/* Chrome first (matches the chromeCtl launcher), then Edge — every Windows box has Edge, and
 * `msedge.exe --headless=new` renders identically for our purposes. Kept local to this family so a
 * chromeCtl failure can't take the renderer down (families stay independent). */
function browserCandidates(): string[] {
    const pf = process.env["ProgramFiles"] || "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    return [
        path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(localAppData(), "Google", "Chrome", "Application", "chrome.exe"),
        path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
    ];
}

function findBrowser(explicit?: string): string | null {
    const cands = [
        ...(explicit ? [explicit] : []),
        ...(process.env.RIMAGENTIC_CHROME ? [process.env.RIMAGENTIC_CHROME] : []),
        ...browserCandidates(),
    ];
    for (const c of cands) { try { if (fs.statSync(c).isFile()) return c; } catch { /* next */ } }
    return null;
}

// ---------------------------------------------------------------------------- HTML instrumentation

const MEASURE_ATTR = "data-rs-h";

/* Script that keeps publishing the content height into an attribute --dump-dom will serialize.
 * scrollHeight floors at the viewport height (and headless new's viewport is ~95px SHORTER than
 * --window-size, window chrome), so for content shorter than the measure viewport it lies — fall
 * back to the body's actual bottom edge in that case. */
const MEASURE_SCRIPT =
    `<script>(function(){function m(){try{var de=document.documentElement,b=document.body;` +
    `var sh=de.scrollHeight,h;` +
    `if(sh>de.clientHeight){h=Math.max(sh,b?b.scrollHeight:0);}` +
    `else{h=Math.max(b?b.scrollHeight:0,b?Math.ceil(b.getBoundingClientRect().bottom):0,16);}` +
    `de.setAttribute("${MEASURE_ATTR}",String(h));}catch(e){}}` +
    `window.addEventListener("load",function(){requestAnimationFrame(function(){requestAnimationFrame(m);});});` +
    `setInterval(m,200);m();})();</script>`;

/**
 * Instrument source HTML for rendering: ensure a leading <!doctype html> (artifact-style pages
 * usually omit it, and quirks mode both changes layout and breaks height measurement — body
 * stretches to the viewport), then inject a <meta charset> when the source has none, the
 * theme-forcing script, and an optional <base> (so a page fetched from a URL keeps resolving its
 * relative resources); append the height measurement script at the end.
 */
function instrumentHtml(html: string, theme: string, baseHref?: string): string {
    let head = "";
    if (!/<meta[^>]+charset/i.test(html)) head += `<meta charset="utf-8">`;
    if (baseHref) head += `<base href="${baseHref.replace(/"/g, "&quot;")}">`;
    if (theme === "light" || theme === "dark") {
        head += `<script>document.documentElement.setAttribute("data-theme","${theme}");</script>`;
    }
    const m = /^\s*<!doctype[^>]*>/i.exec(html);
    const body = m
        ? html.slice(0, m[0].length) + head + html.slice(m[0].length)
        : "<!doctype html>" + head + html;
    return body + MEASURE_SCRIPT;
}

// ---------------------------------------------------------------------------- loopback server + chrome

/** Serve `html` at every path on an ephemeral loopback port; resolves with the origin + closer. */
function serveHtml(html: string): Promise<{ url: string; close: () => void }> {
    return new Promise((resolve, reject) => {
        const server = http.createServer((_req, res) => {
            // The charset header is the whole point — without it Chrome guesses and mangles UTF-8.
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(html);
        });
        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as any;
            resolve({ url: `http://127.0.0.1:${addr.port}/`, close: () => { try { server.close(); } catch { /* closing */ } } });
        });
    });
}

interface ChromeRunOpts {
    browser: string; url: string; width: number; height: number;
    scale: number; virtualTimeMs: number; background?: string;
    userDataDir: string; screenshotPath?: string; dumpDom?: boolean;
}

/** One headless Chrome invocation; returns stdout (the DOM for --dump-dom runs). */
function runChrome(o: ChromeRunOpts): Promise<string> {
    const args = [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--mute-audio",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--force-color-profile=srgb",
        // Recommended with virtual time so the frame is fully composited before the capture.
        "--run-all-compositor-stages-before-draw",
        `--user-data-dir=${o.userDataDir}`,
        `--virtual-time-budget=${o.virtualTimeMs}`,
        `--window-size=${o.width},${o.height}`,
        `--force-device-scale-factor=${o.scale}`,
    ];
    if (o.background) args.push(`--default-background-color=${o.background}`);
    if (o.screenshotPath) args.push(`--screenshot=${o.screenshotPath}`);
    if (o.dumpDom) args.push("--dump-dom");
    args.push(o.url);
    return new Promise((resolve, reject) => {
        execFile(o.browser, args, {
            timeout: o.virtualTimeMs + 60_000,
            maxBuffer: 128 * 1024 * 1024,
            windowsHide: true,
        }, (err, stdout) => {
            if (err) reject(new Error(`headless browser failed: ${err.message}`));
            else resolve(String(stdout || ""));
        });
    });
}

interface RenderResult {
    path: string; width: number; height: number;
    cssWidth: number; cssHeight: number; bytes: number;
    theme: string; browser: string; warnings: string[];
}

/** The core render: instrument -> serve -> measure -> screenshot. Shared by the tool + tests. */
async function renderHtml(opts: {
    html?: string; htmlPath?: string; url?: string;
    width?: number; height?: number; scale?: number; theme?: string;
    virtualTimeMs?: number; padding?: number; maxHeight?: number;
    background?: string; outPath?: string; name?: string; chromePath?: string;
}): Promise<RenderResult> {
    const warnings: string[] = [];
    const width = Number(opts.width) > 0 ? Math.round(Number(opts.width)) : 1000;
    const scale = Number(opts.scale) > 0 ? Number(opts.scale) : 2;
    const theme = ["light", "dark", "none"].includes(String(opts.theme || "")) ? String(opts.theme) : "dark";
    const virtualTimeMs = Number(opts.virtualTimeMs) > 0 ? Math.round(Number(opts.virtualTimeMs)) : 4000;
    const padding = Number(opts.padding) >= 0 ? Math.round(Number(opts.padding)) : 0;
    // Chrome's capture surface tops out around 16384 physical px; stay under it after scaling.
    const hardCap = Math.floor(16000 / scale);
    const maxHeight = Math.min(Number(opts.maxHeight) > 0 ? Math.round(Number(opts.maxHeight)) : hardCap, hardCap);

    const browser = findBrowser(opts.chromePath);
    if (!browser) {
        throw new Error(
            "No headless-capable browser found. Looked for chrome.exe / msedge.exe in:\n" +
            browserCandidates().map(c => "  " + c).join("\n") +
            "\nPass chromePath, or set RIMAGENTIC_CHROME."
        );
    }

    // ---- source HTML ----
    let html: string | null = null;
    let baseHref: string | undefined;
    if (opts.html) {
        html = String(opts.html);
    } else if (opts.htmlPath) {
        html = await fsp.readFile(path.resolve(String(opts.htmlPath)), "utf8");
    } else if (opts.url) {
        // Fetch and re-serve locally so theme forcing + height measurement still work; a <base>
        // keeps the page's relative CSS/images resolving against the original origin.
        const res = await fetch(String(opts.url));
        if (!res.ok) throw new Error(`Fetching ${opts.url} failed: HTTP ${res.status}`);
        html = await res.text();
        baseHref = String(opts.url);
    } else {
        throw new Error("Provide exactly one of html_string, html_path, or url.");
    }

    const instrumented = instrumentHtml(html, theme, baseHref);

    // ---- output path ----
    let outPath: string;
    if (opts.outPath) {
        outPath = path.resolve(String(opts.outPath));
    } else {
        const base = (opts.name || (opts.htmlPath ? path.basename(String(opts.htmlPath)).replace(/\.[^.]+$/, "") : ""))
            .replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")
            || "infographic-" + randomBytes(4).toString("hex");
        outPath = path.join(infographicsDir(), base + ".png");
    }
    await fsp.mkdir(path.dirname(outPath), { recursive: true });

    const served = await serveHtml(instrumented);
    const profile = await fsp.mkdtemp(path.join(os.tmpdir(), "rs-render-"));
    try {
        // ---- pass 1: measure content height (skipped when the caller fixed it) ----
        let cssHeight: number;
        if (Number(opts.height) > 0) {
            cssHeight = Math.round(Number(opts.height));
        } else {
            const dom = await runChrome({
                browser, url: served.url, width, height: 1000, scale: 1,
                virtualTimeMs, userDataDir: profile, dumpDom: true,
            });
            const m = new RegExp(`${MEASURE_ATTR}="(\\d+)"`).exec(dom);
            if (!m) {
                throw new Error(
                    "Could not measure the rendered content height (the measurement attribute never appeared — " +
                    "a page script may be throwing before load). Pass an explicit `height` to skip measurement."
                );
            }
            cssHeight = parseInt(m[1], 10) + padding;
        }
        if (cssHeight > maxHeight) {
            warnings.push(`Content height ${cssHeight}px exceeds the ${maxHeight}px cap at scale ${scale} — clipped. Lower the scale, raise maxHeight, or split the page.`);
            cssHeight = maxHeight;
        }
        if (cssHeight < 16) cssHeight = 16;

        // ---- pass 2: screenshot at the measured size ----
        await runChrome({
            browser, url: served.url, width, height: cssHeight, scale,
            virtualTimeMs, userDataDir: profile,
            background: normalizeBackground(opts.background),
            screenshotPath: outPath,
        });

        let pxW = 0, pxH = 0, bytes = 0;
        try {
            const meta = await sharp()(outPath).metadata();
            pxW = meta.width || 0; pxH = meta.height || 0;
        } catch { warnings.push("sharp unavailable — output dimensions not verified."); }
        try { bytes = (await fsp.stat(outPath)).size; } catch { /* reported as 0 */ }
        if (!bytes) throw new Error("Chrome exited without writing the screenshot.");

        return { path: outPath, width: pxW, height: pxH, cssWidth: width, cssHeight, bytes, theme, browser, warnings };
    } finally {
        served.close();
        await fsp.rm(profile, { recursive: true, force: true }).catch(() => { /* temp profile */ });
    }
}

/** 'transparent' | '#rrggbb' | 'rrggbb' | 'rrggbbaa' -> Chrome's RRGGBBAA form (or undefined). */
function normalizeBackground(bg?: string): string | undefined {
    if (!bg) return undefined;
    const s = String(bg).trim().replace(/^#/, "");
    if (/^transparent$/i.test(s)) return "00000000";
    if (/^[0-9a-f]{6}$/i.test(s)) return s.toUpperCase() + "FF";
    if (/^[0-9a-f]{8}$/i.test(s)) return s.toUpperCase();
    return undefined;
}

// ---------------------------------------------------------------------------- compose templates

/* The house design system, lifted from the finished artifact-style infographics (faction codex /
 * roadmap): cool-steel neutrals + one brass accent, Chakra Petch display over IBM Plex Sans/Mono,
 * light + dark via CSS tokens (bare :root = light; media-query and [data-theme="dark"] = dark),
 * which is exactly what the renderer's theme forcing expects. */
const THEME_CSS = `
  :root {
    --ground: #eceeec; --surface: #fafbfa; --surface-2: #f1f3f1;
    --ink: #191d1c; --ink-soft: #4a524f; --ink-faint: #7c847f;
    --line: #d7dbd7; --line-soft: #e4e7e4;
    --brass: #a67c26; --brass-bright: #bd8f31;
    --good: #2f8f6b; --bad: #c0503f;
    --shadow: 0 1px 2px rgba(20,28,25,.05), 0 8px 26px rgba(20,28,25,.07);
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --ground: #0e1211; --surface: #161b19; --surface-2: #1c2220;
      --ink: #e7ebe8; --ink-soft: #a6afaa; --ink-faint: #737b76;
      --line: #29302d; --line-soft: #212724;
      --brass: #cba24a; --brass-bright: #dcb35b;
      --good: #4bb98c; --bad: #e0705d;
      --shadow: 0 1px 2px rgba(0,0,0,.3), 0 10px 30px rgba(0,0,0,.4);
    }
  }
  :root[data-theme="dark"] {
    --ground: #0e1211; --surface: #161b19; --surface-2: #1c2220;
    --ink: #e7ebe8; --ink-soft: #a6afaa; --ink-faint: #737b76;
    --line: #29302d; --line-soft: #212724;
    --brass: #cba24a; --brass-bright: #dcb35b;
    --good: #4bb98c; --bad: #e0705d;
    --shadow: 0 1px 2px rgba(0,0,0,.3), 0 10px 30px rgba(0,0,0,.4);
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--ground); color: var(--ink);
    font-family: "IBM Plex Sans", system-ui, sans-serif; line-height: 1.5; -webkit-font-smoothing: antialiased; }
  .wrap { max-width: 960px; margin: 0 auto; padding: 44px 36px 52px; }
  .eyebrow { font-family: "IBM Plex Mono", monospace; font-size: 12px; font-weight: 500;
    letter-spacing: .18em; text-transform: uppercase; color: var(--brass); margin: 0 0 12px; }
  h1 { font-family: "Chakra Petch", sans-serif; font-size: 34px; font-weight: 700; margin: 0 0 8px; letter-spacing: .01em; }
  .subtitle { color: var(--ink-soft); font-size: 15.5px; margin: 0 0 34px; max-width: 62ch; }
  .footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--line-soft); text-align: center;
    font-family: "IBM Plex Mono", monospace; font-size: 11.5px; letter-spacing: .08em; color: var(--ink-faint); }
  .chip { display: inline-block; font-family: "IBM Plex Mono", monospace; font-size: 11px; font-weight: 600;
    letter-spacing: .1em; text-transform: uppercase; padding: 2px 9px; border-radius: 999px;
    border: 1px solid var(--line); color: var(--ink-soft); background: var(--surface-2); }
  .chip.done { color: var(--good); border-color: color-mix(in srgb, var(--good) 40%, transparent); }
  .chip.active { color: var(--brass-bright); border-color: color-mix(in srgb, var(--brass) 45%, transparent); }
`;

const FONTS_HTML =
    `<link rel="preconnect" href="https://fonts.googleapis.com">` +
    `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>` +
    `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">`;

const esc = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function pageShell(title: string, extraCss: string, bodyHtml: string): string {
    return `<title>${esc(title)}</title>\n${FONTS_HTML}\n` +
        `<meta charset="utf-8">\n<style>${THEME_CSS}${extraCss}</style>\n` +
        `<div class="wrap">${bodyHtml}</div>`;
}

function headerHtml(a: any): string {
    let out = "";
    if (a.eyebrow) out += `<p class="eyebrow">${esc(a.eyebrow)}</p>`;
    out += `<h1>${esc(a.title)}</h1>`;
    if (a.subtitle) out += `<p class="subtitle">${esc(a.subtitle)}</p>`;
    return out;
}
const footerHtml = (a: any) => a.footer ? `<div class="footer">${esc(a.footer)}</div>` : "";

/* Roadmap: the milestone/mechanic card rail — a fat card per entry with body copy and bullets.
 * Best for explaining COMPLEX mechanics per milestone. For a plain feature timeline (many small
 * entries, one line each) use the 'timeline' template below instead. */
const ROADMAP_CSS = `
  .tl { position: relative; margin: 0; padding: 0 0 0 30px; list-style: none; }
  .tl::before { content: ""; position: absolute; left: 9px; top: 6px; bottom: 6px; width: 2px; background: var(--line); }
  .tl li { position: relative; margin: 0 0 22px; }
  .tl .dot { position: absolute; left: -27px; top: 5px; width: 12px; height: 12px; border-radius: 50%;
    background: var(--surface); border: 2.5px solid var(--ink-faint); }
  .tl .done .dot { border-color: var(--good); background: var(--good); }
  .tl .active .dot { border-color: var(--brass-bright); background: var(--brass-bright);
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--brass) 22%, transparent); }
  .tl .card { background: var(--surface); border: 1px solid var(--line); border-radius: 10px;
    padding: 14px 18px; box-shadow: var(--shadow); }
  .tl .head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .tl .label { font-family: "IBM Plex Mono", monospace; font-size: 12px; font-weight: 600; color: var(--brass); letter-spacing: .06em; }
  .tl h3 { font-family: "Chakra Petch", sans-serif; font-size: 17px; font-weight: 600; margin: 0; }
  .tl .body { color: var(--ink-soft); font-size: 14px; margin: 6px 0 0; }
  .tl ul { margin: 8px 0 0; padding-left: 18px; color: var(--ink-soft); font-size: 13.5px; }
  .tl ul li { margin: 3px 0; }
`;

function roadmapHtml(items: any[]): string {
    const rows = items.map(it => {
        const status = ["done", "active", "planned"].includes(String(it.status)) ? String(it.status) : "planned";
        const chip = status !== "planned" ? `<span class="chip ${status}">${status === "done" ? "Shipped" : "In progress"}</span>` : "";
        const bullets = Array.isArray(it.bullets) && it.bullets.length
            ? `<ul>${it.bullets.map((b: any) => `<li>${esc(b)}</li>`).join("")}</ul>` : "";
        return `<li class="${status}"><span class="dot"></span><div class="card">` +
            `<div class="head">${it.label ? `<span class="label">${esc(it.label)}</span>` : ""}<h3>${esc(it.title)}</h3>${chip}</div>` +
            (it.body ? `<p class="body">${esc(it.body)}</p>` : "") + bullets + `</div></li>`;
    }).join("");
    return `<ol class="tl">${rows}</ol>`;
}

/* Timeline: the compact FEATURE timeline — a slim rail of one-line entries (version/date + name
 * + optional short note), so a long history fits one image. Entries with only `heading` render
 * an era divider. */
const TIMELINE_CSS = `
  .ftl { list-style: none; margin: 0; padding: 0; }
  .ftl li { display: grid; grid-template-columns: 92px 34px 1fr; align-items: baseline; position: relative; padding: 6px 0; }
  .ftl li::before { content: ""; position: absolute; left: calc(92px + 16px); top: 0; bottom: 0; width: 2px; background: var(--line); }
  .ftl li:first-child::before { top: 50%; }
  .ftl li:last-child::before { bottom: 50%; }
  .ftl .when { text-align: right; font-family: "IBM Plex Mono", monospace; font-size: 12px; font-weight: 600; color: var(--brass); letter-spacing: .04em; }
  .ftl .dot { position: relative; z-index: 1; justify-self: center; align-self: center; width: 10px; height: 10px; border-radius: 50%;
    background: var(--ground); border: 2.5px solid var(--ink-faint); }
  .ftl .done .dot { border-color: var(--good); background: var(--good); }
  .ftl .active .dot { border-color: var(--brass-bright); background: var(--brass-bright);
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--brass) 22%, transparent); }
  .ftl .what { font-size: 14px; }
  .ftl .name { font-family: "Chakra Petch", sans-serif; font-size: 15px; font-weight: 600; }
  .ftl .planned .name { color: var(--ink-soft); }
  .ftl .note { color: var(--ink-soft); font-size: 13px; }
  .ftl .note::before { content: " — "; color: var(--ink-faint); }
  .ftl li.era { display: block; padding: 16px 0 6px; }
  .ftl li.era::before { display: none; }
  .ftl .eraname { font-family: "IBM Plex Mono", monospace; font-size: 11.5px; font-weight: 600;
    letter-spacing: .16em; text-transform: uppercase; color: var(--ink-faint);
    border-bottom: 1px solid var(--line-soft); display: block; padding-bottom: 5px; }
`;

function timelineHtml(items: any[]): string {
    const rows = items.map(it => {
        if (it && it.heading && !it.title) {
            return `<li class="era"><span class="eraname">${esc(it.heading)}</span></li>`;
        }
        const status = ["done", "active", "planned"].includes(String(it.status)) ? String(it.status) : "planned";
        return `<li class="${status}">` +
            `<span class="when">${esc(it.label ?? "")}</span><span class="dot"></span>` +
            `<span class="what"><span class="name">${esc(it.title)}</span>` +
            (it.desc || it.body ? `<span class="note">${esc(it.desc ?? it.body)}</span>` : "") +
            `</span></li>`;
    }).join("");
    return `<ol class="ftl">${rows}</ol>`;
}

const CARDGRID_CSS = `
  .grid { display: grid; grid-template-columns: repeat(var(--cols, 2), 1fr); gap: 16px; }
  .gcard { background: var(--surface); border: 1px solid var(--line); border-radius: 10px;
    padding: 16px 18px; box-shadow: var(--shadow); }
  .gcard .head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
  .gcard h3 { font-family: "Chakra Petch", sans-serif; font-size: 16.5px; font-weight: 600; margin: 0 0 6px; }
  .gcard .body { color: var(--ink-soft); font-size: 13.5px; margin: 0 0 10px; }
  .gcard table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .gcard td { padding: 4px 0; border-top: 1px solid var(--line-soft); }
  .gcard td.k { color: var(--ink-soft); }
  .gcard td.v { text-align: right; font-family: "IBM Plex Mono", monospace; color: var(--ink); }
`;

function cardGridHtml(cards: any[], columns: number): string {
    const cells = cards.map(c => {
        const rows = Array.isArray(c.rows) && c.rows.length
            ? `<table>${c.rows.map((r: any) => `<tr><td class="k">${esc(r.k)}</td><td class="v">${esc(r.v)}</td></tr>`).join("")}</table>` : "";
        return `<div class="gcard"><div class="head"><h3>${esc(c.title)}</h3>` +
            (c.badge ? `<span class="chip">${esc(c.badge)}</span>` : "") + `</div>` +
            (c.body ? `<p class="body">${esc(c.body)}</p>` : "") + rows + `</div>`;
    }).join("");
    return `<div class="grid" style="--cols:${columns}">${cells}</div>`;
}

const STATSHEET_CSS = `
  .sgroup { background: var(--surface); border: 1px solid var(--line); border-radius: 10px;
    box-shadow: var(--shadow); margin: 0 0 18px; overflow: hidden; }
  .sgroup .bar { font-family: "Chakra Petch", sans-serif; font-size: 14px; font-weight: 600;
    letter-spacing: .04em; text-transform: uppercase; padding: 10px 18px;
    background: var(--surface-2); border-bottom: 1px solid var(--line); color: var(--brass); }
  .srow { display: flex; align-items: baseline; gap: 14px; padding: 9px 18px; border-top: 1px solid var(--line-soft); }
  .srow:first-of-type { border-top: none; }
  .srow .k { flex: 1; color: var(--ink-soft); font-size: 14px; }
  .srow .v { font-family: "IBM Plex Mono", monospace; font-size: 14px; font-weight: 500; color: var(--ink); }
  .srow .note { color: var(--ink-faint); font-size: 12.5px; }
`;

function statSheetHtml(groups: any[]): string {
    return groups.map(g => {
        const rows = (Array.isArray(g.stats) ? g.stats : []).map((s: any) =>
            `<div class="srow"><span class="k">${esc(s.k)}</span><span class="v">${esc(s.v)}</span>` +
            (s.note ? `<span class="note">${esc(s.note)}</span>` : "") + `</div>`).join("");
        return `<div class="sgroup"><div class="bar">${esc(g.title)}</div>${rows}</div>`;
    }).join("");
}

async function composeInfographic(args: any) {
    const template = String(args.template || "").toLowerCase();
    const title = String(args.title || "").trim();
    if (!title) return errText("'title' is required.");

    let css = "", body = "";
    if (template === "roadmap" || template === "milestones") {
        const items = Array.isArray(args.items) ? args.items : [];
        if (!items.length) return errText("roadmap needs 'items': [{ label?, title, status?, body?, bullets? }].");
        css = ROADMAP_CSS; body = roadmapHtml(items);
    } else if (template === "timeline" || template === "feature-timeline") {
        const items = Array.isArray(args.items) ? args.items : [];
        if (!items.length) return errText("timeline needs 'items': [{ label?, title, status?, desc? } | { heading }].");
        css = TIMELINE_CSS; body = timelineHtml(items);
    } else if (template === "card-grid" || template === "cardgrid" || template === "matrix") {
        const cards = Array.isArray(args.cards) ? args.cards : [];
        if (!cards.length) return errText("card-grid needs 'cards': [{ title, badge?, body?, rows? }].");
        const columns = Number(args.columns) >= 1 ? Math.min(4, Math.round(Number(args.columns))) : 2;
        css = CARDGRID_CSS; body = cardGridHtml(cards, columns);
    } else if (template === "stat-sheet" || template === "statsheet") {
        const groups = Array.isArray(args.groups) ? args.groups : [];
        if (!groups.length) return errText("stat-sheet needs 'groups': [{ title, stats: [{ k, v, note? }] }].");
        css = STATSHEET_CSS; body = statSheetHtml(groups);
    } else {
        return errText("'template' must be one of: roadmap, timeline, card-grid, stat-sheet.");
    }

    const htmlOut = pageShell(title, css, headerHtml(args) + body + footerHtml(args));
    const base = String(args.name || title).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "infographic";
    const outPath = args.out_path ? path.resolve(String(args.out_path)) : path.join(infographicsDir(), base + ".html");
    await fsp.mkdir(path.dirname(outPath), { recursive: true });
    await fsp.writeFile(outPath, htmlOut, "utf8");
    return okText({
        ok: true, template, path: outPath, bytes: Buffer.byteLength(htmlOut),
        note: "Themed HTML written (light+dark via tokens). Render with render_html_to_image { html_path, theme }."
    });
}

// ---------------------------------------------------------------------------- publish

interface Edition { key: string; repo: string; workshopId: string | null; }

function editionMap(): Record<string, string> {
    const cfg: any = loadConfig();
    return cfg.editions && typeof cfg.editions === "object" ? cfg.editions : {};
}

function readWorkshopId(repo: string): string | null {
    try {
        const id = fs.readFileSync(path.join(repo, "About", "PublishedFileId.txt"), "utf8").trim();
        return /^\d+$/.test(id) ? id : null;
    } catch { return null; }
}

/** Resolve edition specs (config keys like 'mmf'/'rp2', or literal repo paths) to repos + ids. */
function resolveEditions(specs: any): Edition[] {
    const map = editionMap();
    const list: string[] = Array.isArray(specs) && specs.length ? specs.map(String) : Object.keys(map);
    if (!list.length) {
        throw new Error(
            "No editions given and none configured. Pass editions as repo paths, or add to mcp-config/config.json:\n" +
            `  "editions": { "mmf": "C:\\\\path\\\\to\\\\Core-MMF", "rp2": "C:\\\\path\\\\to\\\\Core-RP2" }`
        );
    }
    return list.map(spec => {
        const fromMap = map[spec] || map[spec.toLowerCase()];
        let repo = fromMap || spec;
        repo = path.resolve(repo);
        if (!fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) {
            throw new Error(`Edition "${spec}" does not resolve to a directory (tried ${repo}). Configure it in mcp-config/config.json "editions", or pass the repo path directly.`);
        }
        const key = fromMap ? spec.toLowerCase() : path.basename(repo).toLowerCase();
        return { key, repo, workshopId: readWorkshopId(repo) };
    });
}

function git(repo: string, ...argv: string[]): Promise<{ ok: boolean; out: string }> {
    return new Promise(resolve => {
        execFile("git", ["-C", repo, ...argv], { timeout: 60_000, windowsHide: true }, (err, stdout, stderr) => {
            resolve({ ok: !err, out: String(stdout || "") + String(stderr || "") });
        });
    });
}

async function sha256File(p: string): Promise<string | null> {
    try { return createHash("sha256").update(await fsp.readFile(p)).digest("hex"); } catch { return null; }
}

/**
 * Insert or refresh a named [h1] section in a Steam description's BBCode. `block` must begin with
 * `[h1]heading[/h1]`. The existing section (from its heading to the next [h1] or the end) is
 * replaced in place; otherwise the block is appended — re-publishing never duplicates the section
 * and never touches the rest of the description.
 */
function upsertBbcodeSection(desc: string, heading: string, block: string): string {
    const escRe = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\[h1\\]\\s*${escRe}\\s*\\[/h1\\][\\s\\S]*?(?=\\n?\\[h1\\]|$)`, "i");
    if (re.test(desc)) return desc.replace(re, block + "\n");
    const sep = desc.trim() ? (desc.endsWith("\n\n") ? "" : desc.endsWith("\n") ? "\n" : "\n\n") : "";
    return desc + sep + block + "\n";
}

/* -------------------------------------------------------------------------- *
 * Live Steam description update over CDP — the workaround for the dead swh
 * bridge. Replicates the extension's proven ItemEditText flow (clone the real
 * edit form, override `description`, re-POST with the session id), but runs it
 * as in-page JS in the logged-in RimAgentic Chrome via Runtime.evaluate: no
 * bridge, no window focus, no blind UI driving. Requires launch_chrome and a
 * Steam session signed in as the item owner (Steam only serves the edit page
 * to the owner).
 * -------------------------------------------------------------------------- */

interface SteamUpdateResult { ok: boolean; changed: boolean; verified: boolean; before: number; after: number; }

async function cdpUpdateDescription(
    port: number, fileId: string, upsert: (current: string) => string, verifySnippet: string
): Promise<SteamUpdateResult> {
    const editUrl = `https://steamcommunity.com/sharedfiles/itemedittext/?id=${encodeURIComponent(fileId)}`;
    const tab = await openTab(port, editUrl);
    const page = await CdpPage.open(tab.webSocketDebuggerUrl!);
    try {
        await page.cmd("Runtime.enable");

        // Wait for the edit form (page load is async); detect a signed-out session early.
        let current: string | null = null;
        const t0 = Date.now();
        while (current === null && Date.now() - t0 < 25_000) {
            await sleep(700);
            try {
                const probe = await page.eval(
                    `(() => { if (/\\/login/.test(location.pathname)) return { login: true };` +
                    ` const ta = document.querySelector('[name="description"], #description');` +
                    ` return ta ? { desc: ta.value } : null; })()`
                );
                if (probe?.login) throw new Error("Steam bounced to the login page — the RimAgentic Chrome is not signed into Steam.");
                if (probe && typeof probe.desc === "string") current = probe.desc;
            } catch (e: any) {
                if (/signed into Steam/.test(String(e?.message))) throw e;
                /* page mid-navigation; retry */
            }
        }
        if (current === null) {
            throw new Error(`No description edit form appeared on ${editUrl} — is the Chrome session signed in as the item OWNER? (Steam only serves the edit page to the owner.)`);
        }

        const updated = upsert(current);
        if (updated === current) return { ok: true, changed: false, verified: true, before: current.length, after: updated.length };

        // Clone the live form, override description, re-POST — same fields the extension sends.
        const script = `(async () => {
            const forms = Array.from(document.querySelectorAll("form"));
            const form = forms.find(f => f.querySelector('[name="description"], #description'))
                || forms.find(f => /edititem/i.test(f.getAttribute("action") || ""))
                || forms.find(f => f.querySelector('[name="title"]'));
            if (!form) return { error: "edit form disappeared" };
            const params = new URLSearchParams();
            for (const el of form.elements) {
                if (!el.name || el.disabled) continue;
                const type = (el.type || "").toLowerCase();
                if (type === "checkbox" || type === "radio") { if (el.checked) params.set(el.name, el.value); }
                else if (el.tagName === "SELECT") params.set(el.name, el.value);
                else if (type !== "submit" && type !== "button" && type !== "file") params.set(el.name, el.value);
            }
            params.set("description", ${JSON.stringify(updated)});
            if (!params.get("sessionid") && window.g_sessionID) params.set("sessionid", window.g_sessionID);
            if (!params.get("id")) params.set("id", ${JSON.stringify(fileId)});
            const action = form.getAttribute("action");
            const postUrl = action ? new URL(action, location.href).href : location.href;
            const res = await fetch(postUrl, {
                method: "POST", credentials: "include",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: params.toString()
            });
            let verified = false;
            try {
                const html = await (await fetch(${JSON.stringify(editUrl)}, { credentials: "include" })).text();
                const doc = new DOMParser().parseFromString(html, "text/html");
                const ta = doc.querySelector('[name="description"], #description');
                verified = !!ta && ta.value.includes(${JSON.stringify(verifySnippet)});
            } catch (e) { /* verification is best-effort */ }
            return { status: res.status, ok: res.ok, verified };
        })()`;
        const r = await page.eval(script);
        if (r?.error) throw new Error(r.error);
        if (!r?.ok) throw new Error(`description POST failed: HTTP ${r?.status}`);
        return { ok: true, changed: true, verified: !!r.verified, before: current.length, after: updated.length };
    } finally {
        page.close();
        await closeTab(port, tab.id);
    }
}

const markerStart = (slug: string) => `<!-- infographic:${slug} -->`;
const markerEnd = (slug: string) => `<!-- /infographic:${slug} -->`;

/** Replace the slug's marker-fenced README section, or append it. Never touches other content. */
function upsertReadmeSection(readme: string, slug: string, section: string): string {
    const start = markerStart(slug), end = markerEnd(slug);
    const block = `${start}\n${section}\n${end}`;
    const re = new RegExp(
        `${start.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`
    );
    if (re.test(readme)) return readme.replace(re, block);
    const sep = readme.endsWith("\n\n") ? "" : readme.endsWith("\n") ? "\n" : "\n\n";
    return readme + sep + block + "\n";
}

async function publishInfographic(args: any) {
    const image = path.resolve(String(args.image || ""));
    if (!args.image || !fs.existsSync(image)) return errText(`'image' must be an existing PNG (got ${args.image || "nothing"}). Render one with render_html_to_image first.`);
    const sectionTitle = String(args.section_title || "").trim();
    if (!sectionTitle) return errText("'section_title' is required — it heads the README section and the Steam BBCode block.");
    const sectionBody = args.section_body ? String(args.section_body).trim() : "";
    const alt = args.alt ? String(args.alt) : sectionTitle;
    const dryRun = !!args.dryRun;
    const push = args.push !== false;
    const targets = (Array.isArray(args.targets) && args.targets.length ? args.targets : ["github", "steam"]).map((t: any) => String(t).toLowerCase());
    const slug = String(args.name || path.basename(image).replace(/\.[^.]+$/, ""))
        .replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "infographic";

    let editions: Edition[];
    try { editions = resolveEditions(args.editions); }
    catch (e: any) { return errText(e?.message || String(e)); }

    const warnings: string[] = [];
    const result: any = { slug, image, dryRun, editions: editions.map(e => ({ key: e.key, repo: e.repo, workshopId: e.workshopId })) };

    // ---------------- GitHub ----------------
    if (targets.includes("github")) {
        const gh: any[] = [];
        for (const ed of editions) {
            const destRel = path.posix.join("About", slug + ".png");
            const dest = path.join(ed.repo, "About", slug + ".png");
            const readmePath = path.join(ed.repo, "README.md");
            const entry: any = { edition: ed.key, repo: ed.repo, imagePath: destRel };
            try {
                const [srcHash, dstHash] = await Promise.all([sha256File(image), sha256File(dest)]);
                const imageChanged = srcHash !== dstHash;

                let readme = "";
                let readmeExisted = true;
                try { readme = await fsp.readFile(readmePath, "utf8"); }
                catch { readmeExisted = false; readme = `# ${path.basename(ed.repo)}\n`; }
                const section = `## ${sectionTitle}\n\n![${alt}](${destRel})` + (sectionBody ? `\n\n${sectionBody}` : "");
                const updated = upsertReadmeSection(readme, slug, section);
                const readmeChanged = updated !== readme || !readmeExisted;

                entry.imageChanged = imageChanged;
                entry.readmeChanged = readmeChanged;
                if (!imageChanged && !readmeChanged) {
                    entry.status = "up-to-date";
                    gh.push(entry); continue;
                }

                if (dryRun) {
                    entry.status = "planned";
                    entry.plannedSection = `${markerStart(slug)}\n${section}\n${markerEnd(slug)}`;
                    gh.push(entry); continue;
                }

                await fsp.mkdir(path.dirname(dest), { recursive: true });
                if (imageChanged) await fsp.copyFile(image, dest);
                if (readmeChanged) await fsp.writeFile(readmePath, updated, "utf8");

                const branch = (await git(ed.repo, "rev-parse", "--abbrev-ref", "HEAD")).out.trim();
                entry.branch = branch;
                if (branch !== "main" && branch !== "master") {
                    warnings.push(`${ed.key}: committing on '${branch}', not main — intended?`);
                }
                const add = await git(ed.repo, "add", destRel, "README.md");
                if (!add.ok) throw new Error(`git add failed: ${add.out.trim()}`);
                const commit = await git(ed.repo, "commit", "-m",
                    `Update ${slug} infographic (${sectionTitle})\n\nVia publish_infographic (rimworld-claude-dev-tools).`);
                if (!commit.ok) {
                    // "nothing to commit" happens when only whitespace differed after normalization.
                    if (/nothing to commit/i.test(commit.out)) entry.status = "up-to-date";
                    else throw new Error(`git commit failed: ${commit.out.trim()}`);
                } else {
                    entry.committed = true;
                    if (push) {
                        const p = await git(ed.repo, "push", "origin", "HEAD");
                        entry.pushed = p.ok;
                        if (!p.ok) warnings.push(`${ed.key}: push failed — ${p.out.trim().split("\n").pop()}`);
                    } else {
                        entry.pushed = false;
                    }
                    entry.status = "published";
                }
                gh.push(entry);
            } catch (e: any) {
                entry.status = "error";
                entry.error = e?.message || String(e);
                gh.push(entry);
            }
        }
        result.github = gh;
    }

    // ---------------- Steam ----------------
    if (targets.includes("steam")) {
        const steam: any = { items: [] };
        let url = "{{IMGUR_URL — uploaded at publish time}}";
        if (!dryRun) {
            try {
                const up = await handleImgurTool("imgur_upload", { path: image });
                const parsed = JSON.parse(up.content?.[0]?.text || "{}");
                const first = parsed.bbcodeImages?.[0]?.url || parsed.results?.find((r: any) => r.ok)?.link;
                if (!first) throw new Error(parsed.results?.[0]?.error || up.content?.[0]?.text || "no URL returned");
                url = first;
                steam.imgur = { url, reused: !!parsed.results?.[0]?.reused };
            } catch (e: any) {
                steam.error = `imgur upload failed: ${e?.message || e}. Fix imgur auth (imgur_status / imgur_login) or use imgur_web_upload, then re-run with targets:["steam"].`;
                result.steam = steam;
                return okText({ ...result, warnings, note: publishNote(dryRun) });
            }
        }

        // Reuse the canonical BBCode composer so image blocks match the release flow's output.
        const intro = `[h1]${sectionTitle}[/h1]` + (sectionBody ? `\n${sectionBody}` : "");
        const comp = await handleWorkshopImageTool("compose_workshop_bbcode", { images: [{ url }], intro });
        let bbcode = "";
        try { bbcode = JSON.parse(comp.content?.[0]?.text || "{}").bbcode || ""; } catch { /* fall through */ }
        if (!bbcode) bbcode = `${intro}\n\n[img]${url}[/img]`;
        steam.bbcode = bbcode;

        const port = Number(args.port) > 0 ? Math.round(Number(args.port)) : CDP_PORT_DEFAULT;
        const wantLive = !dryRun && String(args.steamMode || "live").toLowerCase() !== "handoff";
        const writeHandoff = async (ed: Edition, reason?: string): Promise<string> => {
            await fsp.mkdir(handoffDir(), { recursive: true });
            const id = ed.workshopId;
            const file = path.join(handoffDir(), `${slug}-${ed.key}.txt`);
            const text =
                `Steam Workshop handoff — ${ed.key.toUpperCase()}${id ? ` (item ${id})` : " (workshop id UNKNOWN)"}\n` +
                (dryRun ? `*** DRY RUN — the [img] URL below is a placeholder; re-run without dryRun to upload + publish. ***\n` : "") +
                (reason ? `*** Live update did not go through: ${reason} ***\n` : "") +
                (id ? `Item page: https://steamcommunity.com/sharedfiles/filedetails/?id=${id}\n` +
                    `Edit desc: https://steamcommunity.com/sharedfiles/itemedittext/?id=${id}\n` : "") +
                `\nPaste the BBCode below into the item description (replace the previous '${sectionTitle}' block if one exists):\n` +
                `----------------8<----------------\n${bbcode}\n----------------8<----------------\n`;
            await fsp.writeFile(file, text, "utf8");
            return file;
        };

        for (const ed of editions) {
            const item: any = { edition: ed.key, workshopId: ed.workshopId };
            if (!ed.workshopId) {
                warnings.push(`${ed.key}: no About/PublishedFileId.txt in ${ed.repo} — cannot address the workshop item; handoff written without a link.`);
                item.status = dryRun ? "planned" : "handoff";
                item.handoff = await writeHandoff(ed, dryRun ? undefined : "workshop id unknown");
            } else if (!wantLive) {
                item.status = dryRun ? "planned" : "handoff";
                item.handoff = await writeHandoff(ed);
            } else {
                // Live path: upsert the named [h1] section into the current description over CDP.
                try {
                    const r = await cdpUpdateDescription(
                        port, ed.workshopId,
                        current => upsertBbcodeSection(current, sectionTitle, bbcode),
                        `[img]${url}[/img]`
                    );
                    item.status = r.changed ? "updated" : "up-to-date";
                    item.verified = r.verified;
                    item.descriptionChars = r.after;
                    if (r.changed && !r.verified) warnings.push(`${ed.key}: description POST succeeded but the re-read did not show the new [img] block — check the item page.`);
                    if (r.after > 7600) warnings.push(`${ed.key}: description is ${r.after} chars — close to Steam's ~8,000-char cap.`);
                } catch (e: any) {
                    const reason = e?.message || String(e);
                    warnings.push(`${ed.key}: live description update failed (${reason}) — handoff file written instead. launch_chrome + a Steam owner session enables the live path.`);
                    item.status = "handoff-fallback";
                    item.error = reason;
                    item.handoff = await writeHandoff(ed, reason);
                }
            }
            steam.items.push(item);
        }
        result.steam = steam;
    }

    return okText({ ...result, warnings, note: publishNote(dryRun) });
}

function publishNote(dryRun: boolean): string {
    return dryRun
        ? "DRY RUN: nothing was copied, committed, uploaded, or sent to Steam. plannedSection shows the README block; handoff files carry placeholder BBCode."
        : "GitHub sections committed via markers; Steam [h1] sections upserted in the live descriptions (re-runs update in place). Items with status 'handoff'/'handoff-fallback' need a manual paste from their handoff file.";
}

// ---------------------------------------------------------------------------- tool definitions

export const infographicTools = [
    {
        name: "render_html_to_image",
        description:
            "Render an HTML infographic (file, string, or URL) to a crisp PNG with headless Chrome/Edge — no game, " +
            "no visible browser. Serves the HTML over loopback HTTP with charset=utf-8 (raw file:// rendering " +
            "mangles arrows/checkmarks into mojibake), fast-forwards JS-built DOM and Google Fonts with a virtual-" +
            "time budget, forces the light/dark theme by injecting data-theme (artifact-style token HTML), renders " +
            "at a device-scale-factor for sharpness, and MEASURES the content height first so the PNG is cropped " +
            "tight with no dead margin. Returns the PNG path + pixel dimensions. Gotchas + tuning: docs/INFOGRAPHICS.md.",
        inputSchema: {
            type: "object",
            properties: {
                html_path: { type: "string", description: "Path to the HTML file to render (exactly one of html_path / html_string / url)." },
                html_string: { type: "string", description: "Inline HTML to render." },
                url: { type: "string", description: "http(s) URL to render — fetched and re-served locally (a <base> keeps relative resources working) so theme forcing + height measurement still apply." },
                width: { type: "number", description: "Viewport width in CSS px (default 1000). Output width = width x scale." },
                height: { type: "number", description: "Fixed viewport height in CSS px — skips the measurement pass. Omit to auto-fit content height (recommended)." },
                scale: { type: "number", description: "Device scale factor (default 2 for a 2x crisp PNG)." },
                theme: { type: "string", description: "'dark' (default) | 'light' — forced via data-theme on <html>; 'none' leaves the page's own default." },
                virtualTimeMs: { type: "number", description: "Virtual-time budget in ms for scripts/fonts to settle before capture (default 4000). Raise for heavy JS." },
                padding: { type: "number", description: "Extra CSS px added below the measured content height (default 0)." },
                maxHeight: { type: "number", description: "Cap on the CSS height (default fits Chrome's ~16000px physical surface at the given scale); taller content is clipped with a warning." },
                background: { type: "string", description: "Page background behind transparent areas: 'transparent', '#rrggbb', or rrggbbaa hex. Default: leave to the page." },
                out_path: { type: "string", description: "Where to write the PNG. Default %LOCALAPPDATA%\\RimAgentic\\infographics\\<name>.png." },
                name: { type: "string", description: "Output file name (no extension) when out_path is omitted." },
                chromePath: { type: "string", description: "Explicit chrome.exe/msedge.exe path if not in a standard location (also RIMAGENTIC_CHROME env)." }
            }
        }
    },
    {
        name: "compose_infographic",
        description:
            "Generate a themed, render-ready HTML infographic from structured data — no hand-written HTML. Built-in " +
            "templates: 'roadmap' (milestone cards on a rail with body copy + bullets — best for explaining complex " +
            "mechanics per milestone), 'timeline' (compact feature timeline — one slim line per entry with version/" +
            "date, name, short note, optional era headings; fits a long history in one image), 'card-grid' (matrix " +
            "of cards with badge + k/v rows), 'stat-sheet' (grouped stat panels). All emit the house design system " +
            "(cool-steel neutrals + brass accent, Chakra Petch / IBM Plex via Google Fonts, light+dark CSS tokens) " +
            "so the output matches hand-authored artifact pages and drops straight into render_html_to_image.",
        inputSchema: {
            type: "object",
            properties: {
                template: { type: "string", description: "'roadmap' (milestone/mechanic cards) | 'timeline' (compact feature timeline) | 'card-grid' | 'stat-sheet'." },
                title: { type: "string", description: "Page H1." },
                eyebrow: { type: "string", description: "Small mono kicker line above the title (e.g. 'REGIONS & SOCIETIES — DEV ROADMAP')." },
                subtitle: { type: "string", description: "One-paragraph standfirst under the title." },
                footer: { type: "string", description: "Small centred mono footer line." },
                items: { type: "array", description: "roadmap: [{ label? (e.g. 'v1.2'), title, status? 'done'|'active'|'planned', body?, bullets?: [..] }]. timeline: [{ label? (version/date), title, status?, desc? }] plus { heading: '2026' } era-divider entries.", items: { type: "object" } },
                cards: { type: "array", description: "card-grid: [{ title, badge?, body?, rows?: [{k,v}] }].", items: { type: "object" } },
                columns: { type: "number", description: "card-grid: grid columns 1-4 (default 2)." },
                groups: { type: "array", description: "stat-sheet: [{ title, stats: [{ k, v, note? }] }].", items: { type: "object" } },
                name: { type: "string", description: "Output file name (no extension); defaults from the title." },
                out_path: { type: "string", description: "Explicit output .html path. Default %LOCALAPPDATA%\\RimAgentic\\infographics\\<name>.html." }
            },
            required: ["template", "title"]
        }
    },
    {
        name: "publish_infographic",
        description:
            "Fan a rendered infographic PNG out to a mod's destinations in one call — both edition GitHub repos and " +
            "both Steam Workshop items. GitHub: copies the PNG to About/<name>.png, upserts a marker-fenced README " +
            "section (idempotent — re-runs update in place, never duplicate, never touch unrelated content), commits " +
            "and pushes. Steam: uploads once via imgur_upload (content-hash dedup), composes the [img] BBCode via " +
            "compose_workshop_bbcode, then PUSHES it into each item's live description — the named [h1] section is " +
            "inserted/refreshed in place (the image lives in the description body, not as an uploaded screenshot) via " +
            "the CDP ItemEditText re-POST in the logged-in RimAgentic Chrome (launch_chrome + Steam owner session; " +
            "the swh bridge path is not required). When the live path is unavailable it falls back to a ready-to-" +
            "paste handoff file per item. Editions resolve via the config 'editions' map (mcp-config/config.json) or " +
            "literal repo paths; workshop ids from each repo's About/PublishedFileId.txt. Use dryRun to stage the " +
            "README section + BBCode without writing, committing, uploading, or touching Steam.",
        inputSchema: {
            type: "object",
            properties: {
                image: { type: "string", description: "Path to the rendered PNG (from render_html_to_image)." },
                name: { type: "string", description: "Stable slug for the asset (About/<name>.png + README markers). Defaults from the image filename — keep it stable across re-publishes." },
                section_title: { type: "string", description: "Heading for the README section and the Steam BBCode block." },
                section_body: { type: "string", description: "Optional text under the heading (markdown for README; plain/BBCode for Steam)." },
                alt: { type: "string", description: "Image alt text in the README (defaults to section_title)." },
                editions: { type: "array", items: { type: "string" }, description: "Edition keys from config (e.g. ['mmf','rp2']) or literal repo paths. Default: every configured edition." },
                targets: { type: "array", items: { type: "string" }, description: "'github' and/or 'steam'. Default both." },
                dryRun: { type: "boolean", description: "Stage everything (planned README section, BBCode handoff with placeholder URL) but copy/commit/upload/update nothing. Default false." },
                push: { type: "boolean", description: "git push after committing (default true). false = commit only." },
                steamMode: { type: "string", description: "'live' (default): upsert each item's description over CDP in the RimAgentic Chrome. 'handoff': skip the live update and only write paste-ready handoff files." },
                port: { type: "number", description: "RimAgentic Chrome debugging port for the live Steam update (default 9222)." }
            },
            required: ["image", "section_title"]
        }
    }
];

// ---------------------------------------------------------------------------- dispatch

export async function handleInfographicTool(name: string, args: any) {
    if (name === "render_html_to_image") {
        try {
            const r = await renderHtml({
                html: args?.html_string, htmlPath: args?.html_path, url: args?.url,
                width: args?.width, height: args?.height, scale: args?.scale, theme: args?.theme,
                virtualTimeMs: args?.virtualTimeMs, padding: args?.padding, maxHeight: args?.maxHeight,
                background: args?.background, outPath: args?.out_path, name: args?.name, chromePath: args?.chromePath,
            });
            return okText({ ok: true, ...r, note: "Publish with publish_infographic, or upload via imgur_upload for a Steam description." });
        } catch (e: any) {
            return errText(`render_html_to_image failed: ${e?.message || e}`);
        }
    }
    if (name === "compose_infographic") return await composeInfographic(args || {});
    if (name === "publish_infographic") return await publishInfographic(args || {});
    throw new Error(`Unknown infographic tool: ${name}`);
}

function okText(obj: any) { return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] }; }
function errText(msg: string) { return { content: [{ type: "text" as const, text: msg }] }; }
