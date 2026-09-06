/*
 * Pure Steam Workshop publishing logic — no browser, no network. Everything the swh_* tools
 * decide BEFORE or AFTER talking to a page lives here so it can be unit-tested without a
 * Chrome: the description cap, moderation-notice parsing, changelog-block extraction, the
 * find-or-create plan for the Changelog discussion thread, and the link-domain guardrail.
 */

/** Steam silently truncates / refuses Workshop descriptions longer than this. */
export const DESCRIPTION_CAP = 8000;

export const CAP_ADVICE =
    "Drop the oldest `[h2]Changelog (vX)[/h2] ... [/list]` block from About/steam_description.txt " +
    "(keep the `Full version history` link so nothing is lost) and try again.";

export interface CapCheck { ok: boolean; chars: number; cap: number; over: number; message?: string }

/** Refuse anything over the cap, naming the overage and how to fix it. */
export function checkDescriptionCap(description: string): CapCheck {
    const chars = description.length;
    const over = chars - DESCRIPTION_CAP;
    if (over <= 0) return { ok: true, chars, cap: DESCRIPTION_CAP, over: 0 };
    return {
        ok: false, chars, cap: DESCRIPTION_CAP, over,
        message: `Description is ${chars} characters — ${over} over Steam's ${DESCRIPTION_CAP}-character Workshop cap. ${CAP_ADVICE}`
    };
}

// ---------------------------------------------------------------------------- moderation

export type ModerationState = "visible" | "awaiting_analysis" | "removed" | "hidden" | "incompatible";

export interface Moderation { state: ModerationState; notice: string }

/**
 * Steam's moderation notices are plain body text on the public item page. Order matters: a
 * removed item also says it is hidden, so the more specific / more severe strings go first.
 */
const NOTICES: Array<{ state: ModerationState; re: RegExp }> = [
    { state: "removed", re: /This item has been removed from the community because it violates Steam Community (?:&|and) Content Guidelines[^\n]*/i },
    { state: "awaiting_analysis", re: /[^\n]*awaiting analysis by our automated content check system[^\n]*/i },
    { state: "hidden", re: /The item is either marked as hidden or you do not have permission to view it[^\n]*/i },
    { state: "incompatible", re: /This item is incompatible with RimWorld[^\n]*/i },
];

export function parseModeration(bodyText: string): Moderation {
    const text = String(bodyText || "");
    for (const n of NOTICES) {
        const m = text.match(n.re);
        if (m) return { state: n.state, notice: m[0].trim() };
    }
    return { state: "visible", notice: "" };
}

// ---------------------------------------------------------------------------- version line

/** `[b]Version:[/b] v0.3.2 (Target: RimWorld 1.6)` -> `v0.3.2 (Target: RimWorld 1.6)` (BBCode or rendered text). */
export function versionLineOf(text: string): string {
    const m = String(text || "").match(/Version:(?:\[\/b\])?\s*(v?[0-9][0-9A-Za-z.\-]*[^\n\[]*)/);
    return m ? m[1].trim() : "";
}

// ---------------------------------------------------------------------------- changelog block

export interface ChangelogBlock { ok: boolean; version: string; block: string; chars: number; wikiUrl: string | null; error?: string }

/**
 * Pull `[h2]Changelog (v<version>) ...[/h2]` through its closing `[/list]` out of a steam_description
 * body, byte-identical, so the Discussions post is exactly what the description says.
 */
export function extractChangelogBlock(description: string, version: string): ChangelogBlock {
    const v = String(version || "").trim().replace(/^v/i, "");
    const src = String(description || "");
    const esc = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\[h2\\]Changelog \\(v${esc}\\)[^\\n]*\\[/h2\\]\\r?\\n[\\s\\S]*?\\[/list\\]`);
    const m = src.match(re);
    // Prefer the "Full version history" link (the Changelog page); fall back to any wiki link.
    const history = src.match(/Full version history[^\n]*?\[url=(https?:\/\/[^\]\s]+)\]/i);
    const wiki = history || src.match(/\[url=(https?:\/\/[^\]\s]*wiki[^\]\s]*)\]/i);
    const wikiUrl = wiki ? wiki[1] : null;
    if (!m) {
        const seen = [...src.matchAll(/\[h2\]Changelog \(v([^)]+)\)/g)].map(x => x[1]);
        return {
            ok: false, version: v, block: "", chars: 0, wikiUrl,
            error: `No \`[h2]Changelog (v${v})[/h2] ... [/list]\` block found` + (seen.length ? ` (versions present: ${seen.join(", ")})` : " (no changelog blocks at all)") + "."
        };
    }
    return { ok: true, version: v, block: m[0], chars: m[0].length, wikiUrl };
}

// ---------------------------------------------------------------------------- discussions plan

export interface ThreadRow { name: string; href: string; pinned?: boolean; replies?: string | number }

export interface ThreadPlan {
    action: "reply" | "create";
    thread: ThreadRow | null;
    title: string;
    /** The first post used when creating the thread. */
    firstPost: string;
    /** The changelog post (a reply on an existing thread, or the first reply on a new one). */
    reply: string;
}

/** Find the Changelog thread — pinned first, then the first name match (case-insensitive, trimmed). */
export function findChangelogThread(threads: ThreadRow[], title = "Changelog"): ThreadRow | null {
    const want = title.trim().toLowerCase();
    const norm = (n: string) => String(n || "").replace(/^PINNED:\s*/i, "").trim().toLowerCase();
    const hits = (threads || []).filter(t => norm(t.name) === want);
    if (!hits.length) return null;
    return hits.find(t => t.pinned) || hits[0];
}

export function firstPostFor(title: string, wikiUrl: string | null): string {
    const link = wikiUrl
        ? `Full version history: [url=${wikiUrl}]${wikiUrl.replace(/^https?:\/\//, "")}[/url]`
        : "Full version history is in the mod's wiki (see the description).";
    return `This thread is the running ${title.toLowerCase()} for this item: each release is posted below as it ships.\n\n${link}`;
}

export function planChangelogThread(threads: ThreadRow[], bbcode: string, opts: { title?: string; wikiUrl?: string | null } = {}): ThreadPlan {
    const title = (opts.title || "Changelog").trim();
    const existing = findChangelogThread(threads, title);
    return {
        action: existing ? "reply" : "create",
        thread: existing,
        title,
        firstPost: existing ? "" : firstPostFor(title, opts.wikiUrl ?? null),
        reply: bbcode
    };
}

// ---------------------------------------------------------------------------- link domains

/** Domains Steam's automated content check is known to accept in Workshop descriptions. */
export const WELL_KNOWN_DOMAINS = ["steamcommunity.com", "steampowered.com", "github.com", "imgur.com", "i.imgur.com", "ko-fi.com", "discord.gg"];

export const DOMAIN_RATIONALE =
    "Steam re-scans an item whenever its description changes, and an unfamiliar domain is the likely trigger for " +
    "'awaiting analysis' / 'removed for violating Community & Content Guidelines' — while flagged, other users cannot " +
    "see the item and edits/uploads can return Access Denied. Link only well-known domains (e.g. link the repo's own " +
    "LICENSE page on github.com instead of a licence site).";

export interface DomainCheck { ok: boolean; links: string[]; unknown: string[]; warning?: string }

function hostOf(url: string): string | null {
    try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

function isWellKnown(host: string): boolean {
    return WELL_KNOWN_DOMAINS.some(d => host === d || host.endsWith("." + d));
}

/** Every http(s) URL in the BBCode ([url=…], [img]…[/img], and bare) checked against the allow-list. */
export function checkLinkDomains(bbcode: string): DomainCheck {
    const links = [...String(bbcode || "").matchAll(/https?:\/\/[^\s\]\["'<>]+/gi)].map(m => m[0].replace(/[.,;:)]+$/, ""));
    const unknown = [...new Set(links.filter(l => { const h = hostOf(l); return !h || !isWellKnown(h); }))];
    if (!unknown.length) return { ok: true, links, unknown };
    return { ok: false, links, unknown, warning: `Links to domains Steam may not recognise: ${unknown.join(", ")}. ${DOMAIN_RATIONALE}` };
}
