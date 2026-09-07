import * as fs from "fs";
import { Bridge, BRIDGE_HOWTO } from "../bridge";
import {
    chromeUp, openPage, editUrl, publicUrl, discussionsUrl, readAuth, probeEditPage, saveDescription,
    readPublicPage, listThreads, createThread, replyOnThread, pinThread, setThreadPinned,
    openPostEdit, saveOpenEdit, DEFAULT_CDP_PORT
} from "../steamCdp";
import {
    checkDescriptionCap, checkLinkDomains, parseModeration, versionLineOf, extractChangelogBlock,
    planChangelogThread, findChangelogThread, findMilestoneThread, shippedTitle, DESCRIPTION_CAP
} from "../steamLogic";

/*
 * Steam Workshop tools.
 * ---------------------
 * Two routes to the logged-in Steam session in the RimAgentic Chrome:
 *
 *   1. the extension loopback bridge (bridge.ts -> extension/src/swh-api.js `window.SWH`) — used
 *      when it is connected, because it is cheaper (no tab churn) and covers every method;
 *   2. the DevTools protocol (steamCdp.ts) — zero dependencies, needs only launch_chrome. The
 *      auth/item/description/moderation/discussions tools fall back to it AUTOMATICALLY, so a
 *      release never stalls on "bridge not started" while Chrome is up and signed in.
 *
 * The comment/notification tools only exist in the extension and stay bridge-only; when the
 * bridge is down they explain how it is supposed to come up instead of a bare error.
 *
 * Handlers follow the house convention: { content: [{ type: "text", text: JSON }] }.
 */

const fileIdProp = {
    fileId: {
        type: "string",
        description: "The Steam Workshop published file ID (the number in the item URL).",
    },
};

const portProp = { port: { type: "number", description: `RimAgentic Chrome DevTools port for the fallback route (default ${DEFAULT_CDP_PORT}).` } };

export const swhTools = [
    {
        name: "swh_open_item",
        description:
            "Open (or focus and navigate) a browser tab directly on a workshop item and wait until it is ready. Works whether or not you are logged in. Use this to jump to a specific mod, or to bootstrap when no steamcommunity.com tab is open. Returns { ok, tabId, url, context, route }. Uses the extension bridge when connected, else the DevTools route in the RimAgentic Chrome.",
        inputSchema: {
            type: "object",
            properties: {
                ...fileIdProp,
                activate: { type: "boolean", description: "Bring the tab to the foreground (default true)." },
                ...portProp,
            },
            required: ["fileId"],
        },
    },
    {
        name: "swh_get_auth",
        description:
            "Report Steam login state as seen by the RimAgentic Chrome. Returns { loggedIn, steamId, accountName, route }. Never logs in; it reads the existing session — bridge if connected, else DevTools.",
        inputSchema: { type: "object", properties: { ...portProp } },
    },
    {
        name: "swh_get_context",
        description:
            "Return metadata about the workshop item currently open in the active browser tab (fileId, appId, ownerSteamId, title), or null if the tab is not a workshop item page. Bridge-only.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "swh_review_notifications",
        description:
            "Review recent comment notifications across ALL your workshop items in one call. Reads Steam's Comment Notifications feed (items people commented on) and enriches each with its latest comments (author, timestamp, text). This is the 'review my recent notifications' digest. Bridge-only.",
        inputSchema: {
            type: "object",
            properties: {
                ownItemsOnly: { type: "boolean", description: "Only your own items, excluding subscribed discussions (default true)." },
                perItem: { type: "number", description: "How many latest comments to include per item (default 5)." },
            },
        },
    },
    {
        name: "swh_get_notifications",
        description:
            "Raw comment-notifications list (which items have new comment activity), without fetching the comment text. Faster than swh_review_notifications; use it for just the summary. Bridge-only.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "swh_list_comments",
        description:
            "List comments on a workshop item. Returns { total, comments: [{ id, author, authorId, timestamp, text }] }. `id` is the gidcomment used by swh_delete_comment. Bridge-only.",
        inputSchema: {
            type: "object",
            properties: {
                ...fileIdProp,
                start: { type: "number", description: "Offset of the first comment (default 0)." },
                count: { type: "number", description: "How many comments to fetch (default 100)." },
            },
            required: ["fileId"],
        },
    },
    {
        name: "swh_post_comment",
        description:
            "Post a comment on a workshop item (Steam BBCode allowed). Requires being logged in. Returns { ok, newCommentId, total }. Bridge-only.",
        inputSchema: {
            type: "object",
            properties: {
                ...fileIdProp,
                text: { type: "string", description: "Comment body (Steam BBCode, not Markdown)." },
            },
            required: ["fileId", "text"],
        },
    },
    {
        name: "swh_delete_comment",
        description:
            "Delete a comment by its gidcomment (the `id` from swh_list_comments). You must own the comment or the item. Irreversible. Bridge-only.",
        inputSchema: {
            type: "object",
            properties: {
                ...fileIdProp,
                commentId: { type: "string", description: "The gidcomment id to delete." },
            },
            required: ["fileId", "commentId"],
        },
    },
    {
        name: "swh_get_item",
        description:
            "Read the current editable fields of a workshop item (title, description, visibility) from its edit page. Owner login required. Use before swh_update_description to edit from the current text. Returns { fileId, title, description, chars, visibility, route }. Bridge if connected, else DevTools.",
        inputSchema: {
            type: "object",
            properties: { ...fileIdProp, ...portProp },
            required: ["fileId"],
        },
    },
    {
        name: "swh_update_description",
        description:
            `Replace a workshop item's ENTIRE description with the given Steam BBCode. Owner login required. Reads the current text first, REFUSES descriptions over Steam's ${DESCRIPTION_CAP}-character cap (naming the overage and how to trim), warns on links to unfamiliar domains (Steam's content check flags them), saves, then verifies on the public item page as the owner. Returns { ok, verified, versionLine, moderation: { state, notice }, chars, route }. Bridge if connected, else DevTools.`,
        inputSchema: {
            type: "object",
            properties: {
                ...fileIdProp,
                description: { type: "string", description: "New full description in Steam BBCode." },
                ...portProp,
            },
            required: ["fileId", "description"],
        },
    },
    {
        name: "swh_update_title",
        description:
            "Update a workshop item's title. Owner login required. Returns { ok, verified }. Bridge-only.",
        inputSchema: {
            type: "object",
            properties: {
                ...fileIdProp,
                title: { type: "string", description: "New item title." },
            },
            required: ["fileId", "title"],
        },
    },
    {
        name: "swh_get_moderation_state",
        description:
            "Read Steam's moderation state for a workshop item from its public page AS THE LOGGED-IN OWNER (anonymous fetches differ while an item is flagged). Returns { state: 'visible'|'awaiting_analysis'|'removed'|'hidden'|'incompatible', notice, versionLine, updated }. Steam re-scans on every description change; while flagged, other users cannot see the item and edits/uploads can return Access Denied. DevTools route (needs launch_chrome).",
        inputSchema: {
            type: "object",
            properties: { ...fileIdProp, ...portProp },
            required: ["fileId"],
        },
    },
    {
        name: "extract_changelog_block",
        description:
            "Pull the `[h2]Changelog (v<version>) ...[/h2] ... [/list]` block for one version out of a mod's About/steam_description.txt, byte-identical, plus the wiki link the file carries. Feed the block to swh_post_changelog so the Discussions post matches the description exactly. Local file read; no browser.",
        inputSchema: {
            type: "object",
            properties: {
                steamDescriptionPath: { type: "string", description: "Absolute path to About/steam_description.txt." },
                version: { type: "string", description: "Version to extract, with or without the leading v (e.g. 0.3.2)." },
            },
            required: ["steamDescriptionPath", "version"],
        },
    },
    {
        name: "swh_post_changelog",
        description:
            "Post a release changelog to the workshop item's Discussions tab. TWO MODES. Default: the running " +
            "'Changelog' thread — finds the pinned/first thread named Changelog (case-insensitive); if none, creates " +
            "it with a short first post linking the wiki Changelog page; then posts the BBCode as a new reply and pins " +
            "the thread when the owner menu allows. MILESTONE MODE (pass `milestoneName`): closes out the milestone " +
            "thread instead — posts the changelog block as the final reply on the 'Next milestone: <version> ...' " +
            "thread, retitles it '<version> <name> - shipped', and unpins it (the next milestone's thread takes the " +
            "pin — the workshop-backlog skill's ship-it Step 9b flow). DEFAULT IS A DRY RUN returning exactly what " +
            "would be posted and where — only confirm:true posts. Supply `bbcode` directly, or `steamDescriptionPath` " +
            "+ `version` to extract the block. Returns { threadUrl, postUrl, pinned/unpinned, retitled } after a " +
            "confirmed post. DevTools route (needs launch_chrome, owner signed in).",
        inputSchema: {
            type: "object",
            properties: {
                ...fileIdProp,
                bbcode: { type: "string", description: "The post body (Steam BBCode). Omit to extract it from steamDescriptionPath + version." },
                steamDescriptionPath: { type: "string", description: "About/steam_description.txt to extract the changelog block from (with `version`)." },
                version: { type: "string", description: "Version whose changelog block to extract (e.g. 0.3.2). Also identifies the milestone thread in milestone mode." },
                milestoneName: { type: "string", description: "MILESTONE MODE: the milestone's name (e.g. 'Demographic Fine-tune'). Targets the 'Next milestone: <version> <name>' thread, retitles it '<version> <name> - shipped', unpins it." },
                title: { type: "string", description: "Changelog mode: thread title to find or create (default 'Changelog')." },
                thread: { type: "string", description: "'find-or-create' (default, the only mode)." },
                wikiChangelogUrl: { type: "string", description: "Wiki Changelog page to link from the first post when creating the thread (default: the wiki link found in steamDescriptionPath)." },
                pin: { type: "boolean", description: "Changelog mode: try to pin the thread after posting (default true)." },
                dryRun: { type: "boolean", description: "Return the plan without posting (default true)." },
                confirm: { type: "boolean", description: "Actually post. Required for any change; dryRun is implied false when confirm is true." },
                ...portProp,
            },
            required: ["fileId"],
        },
    },
];

// Tool name -> window.SWH method (bridge route).
const METHOD_MAP: Record<string, string> = {
    swh_open_item: "openItem",
    swh_get_auth: "getAuth",
    swh_get_context: "getContext",
    swh_review_notifications: "reviewNotifications",
    swh_get_notifications: "getNotifications",
    swh_list_comments: "listComments",
    swh_post_comment: "postComment",
    swh_delete_comment: "deleteComment",
    swh_get_item: "getItem",
    swh_update_description: "updateDescription",
    swh_update_title: "updateTitle",
};

/** Tools that have a DevTools implementation and therefore never need the bridge. */
export const CDP_CAPABLE = new Set(["swh_open_item", "swh_get_auth", "swh_get_item", "swh_update_description", "swh_get_moderation_state", "swh_post_changelog", "extract_changelog_block"]);

const okText = (obj: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] });

function bridgeReady(bridge: Bridge | null): boolean {
    return !!bridge && bridge.status().connected;
}

function bridgeNote(bridge: Bridge | null): string {
    return bridge ? bridge.status().note : "the loopback bridge was never started";
}

/** Choose the route: bridge when it is connected (and the call succeeds), else DevTools. */
export async function chooseRoute(bridge: Bridge | null, port: number | undefined): Promise<{ route: "bridge" | "devtools"; reason: string }> {
    if (bridgeReady(bridge)) return { route: "bridge", reason: "extension bridge connected" };
    if (await chromeUp(port)) return { route: "devtools", reason: `bridge not usable (${bridgeNote(bridge)}); RimAgentic Chrome answering on DevTools` };
    throw new Error(
        `No route to Steam: the extension bridge is not connected (${bridgeNote(bridge)}) and no RimAgentic Chrome ` +
        `answers on the DevTools port ${port || DEFAULT_CDP_PORT}. Run launch_chrome first (its profile is already signed into Steam).`
    );
}

async function viaBridgeThenCdp(bridge: Bridge | null, method: string, args: any, port: number | undefined, cdp: () => Promise<any>) {
    const chosen = await chooseRoute(bridge, port);
    if (chosen.route === "bridge") {
        try {
            const r = await bridge!.call(method, args || {});
            return { ...(r && typeof r === "object" ? r : { result: r }), route: "bridge" };
        } catch (e: any) {
            if (!(await chromeUp(port))) throw e;
            const r = await cdp();
            return { ...r, route: "devtools", bridgeError: String(e?.message || e) };
        }
    }
    const r = await cdp();
    return { ...r, route: "devtools", routeReason: chosen.reason };
}

function requireBridge(bridge: Bridge | null, name: string) {
    if (bridgeReady(bridge)) return;
    throw new Error(
        `${name} runs only through the extension loopback bridge, which is not connected: ${bridgeNote(bridge)}\n${BRIDGE_HOWTO}`
    );
}

export async function handleSwhTool(name: string, args: any, bridge: Bridge | null) {
    const a = args || {};
    const port = Number(a.port) > 0 ? Math.round(Number(a.port)) : undefined;
    const fileId = a.fileId !== undefined ? String(a.fileId).trim() : "";

    // ---- local, no browser ---------------------------------------------------------------
    if (name === "extract_changelog_block") {
        const p = String(a.steamDescriptionPath || "");
        if (!p || !fs.existsSync(p)) throw new Error(`steamDescriptionPath not found: ${p || "(empty)"}`);
        const text = fs.readFileSync(p, "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
        const r = extractChangelogBlock(text, String(a.version || ""));
        if (!r.ok) throw new Error(r.error);
        return okText({ ok: true, version: r.version, chars: r.chars, wikiUrl: r.wikiUrl, block: r.block, path: p });
    }

    // ---- bridge-only (extension-implemented) ---------------------------------------------
    if (!CDP_CAPABLE.has(name)) {
        const method = METHOD_MAP[name];
        if (!method) throw new Error(`Unknown workshop tool: ${name}`);
        requireBridge(bridge, name);
        const result = await bridge!.call(method, a);
        return okText(result);
    }

    // ---- bridge-or-devtools ----------------------------------------------------------------
    if (name === "swh_get_auth") {
        return okText(await viaBridgeThenCdp(bridge, "getAuth", {}, port, () => readAuth(port)));
    }

    if (name === "swh_open_item") {
        if (!fileId) throw new Error("fileId is required");
        return okText(await viaBridgeThenCdp(bridge, "openItem", a, port, async () => {
            const page = await openPage(publicUrl(fileId), port);
            const ctx = await page.evaluate<{ title: string; url: string; loggedIn: boolean }>("openItem", `({ title: document.title, url: location.href, loggedIn: !!document.querySelector('#account_pulldown') })`);
            await page.detach();
            return { ok: true, url: ctx.url, context: { fileId, title: ctx.title.replace(/^Steam Workshop::/, "").trim(), loggedIn: ctx.loggedIn }, note: "Tab left open in the RimAgentic Chrome." };
        }));
    }

    if (name === "swh_get_item") {
        if (!fileId) throw new Error("fileId is required");
        const r = await viaBridgeThenCdp(bridge, "getItem", a, port, () => cdpGetItem(fileId, port));
        const desc = typeof r.description === "string" ? r.description : "";
        return okText({ ...r, chars: desc.length, cap: DESCRIPTION_CAP });
    }

    if (name === "swh_update_description") {
        if (!fileId) throw new Error("fileId is required");
        if (typeof a.description !== "string") throw new Error("description (string) is required");
        return okText(await updateDescription(bridge, fileId, a.description, port));
    }

    if (name === "swh_get_moderation_state") {
        if (!fileId) throw new Error("fileId is required");
        if (!(await chromeUp(port))) throw new Error(`No RimAgentic Chrome answers on the DevTools port ${port || DEFAULT_CDP_PORT}. Run launch_chrome first.`);
        const pub = await readPublicPage(fileId, port);
        const mod = parseModeration(pub.bodyText);
        return okText({ fileId, ...mod, title: pub.title, versionLine: versionLineOf(pub.descriptionText), updated: pub.updated, url: pub.url, route: "devtools" });
    }

    if (name === "swh_post_changelog") {
        if (!fileId) throw new Error("fileId is required");
        return okText(await postChangelog(fileId, a, port));
    }

    throw new Error(`Unknown workshop tool: ${name}`);
}

// ---------------------------------------------------------------------------- DevTools implementations

async function cdpGetItem(fileId: string, port?: number) {
    const page = await openPage(editUrl(fileId), port);
    try {
        const p = await probeEditPage(page);
        if (!p.loggedIn) throw new Error("The RimAgentic Chrome is not signed into Steam (no #account_pulldown on the edit page). Sign in once in that window.");
        if (!p.hasTextarea) throw new Error(`No #description textarea on ${editUrl(fileId)} — Steam only serves the edit page to the item's owner.${p.error ? " Page says: " + p.error : ""}`);
        return { fileId, title: p.itemTitle, description: p.description, visibility: p.visibility };
    } finally { await page.close(); }
}

async function verifyPublic(fileId: string, expected: string, port?: number) {
    const pub = await readPublicPage(fileId, port);
    const moderation = parseModeration(pub.bodyText);
    const versionLine = versionLineOf(pub.descriptionText);
    const want = versionLineOf(expected);
    const verified = want ? pub.descriptionText.includes(want) : pub.descriptionText.trim().length > 0;
    return { verified, versionLine, expectedVersionLine: want, moderation, updated: pub.updated, publicUrl: pub.url };
}

async function updateDescription(bridge: Bridge | null, fileId: string, description: string, port?: number) {
    const cap = checkDescriptionCap(description);
    const domains = checkLinkDomains(description);
    const warnings = domains.ok ? [] : [domains.warning!];
    if (!cap.ok) return { ok: false, refused: true, chars: cap.chars, cap: cap.cap, over: cap.over, error: cap.message, warnings };

    const chosen = await chooseRoute(bridge, port);
    let route: "bridge" | "devtools" = chosen.route;
    let previousChars: number | null = null;
    let saveNote = "";
    let bridgeError: string | undefined;

    if (route === "bridge") {
        try {
            const cur = await bridge!.call("getItem", { fileId });
            previousChars = typeof cur?.description === "string" ? cur.description.length : null;
            const r = await bridge!.call("updateDescription", { fileId, description });
            saveNote = r?.verified ? "extension re-read the edit form and it matched" : "extension saved (edit-form re-read did not match or was skipped)";
        } catch (e: any) {
            bridgeError = String(e?.message || e);
            if (!(await chromeUp(port))) throw e;
            route = "devtools";
        }
    }

    if (route === "devtools") {
        const page = await openPage(editUrl(fileId), port);
        try {
            const p = await probeEditPage(page);
            if (!p.loggedIn) throw new Error("The RimAgentic Chrome is not signed into Steam (no #account_pulldown on the edit page). Sign in once in that window.");
            if (!p.hasTextarea) throw new Error(`No #description textarea on ${editUrl(fileId)} — Steam only serves the edit page to the item's owner.${p.error ? " Page says: " + p.error : ""}`);
            previousChars = p.description.length;
            const saved = await saveDescription(page, description);
            if (saved.error) {
                const mod = /access denied/i.test(saved.error) ? " Access Denied after a save usually means the item is under moderation — check swh_get_moderation_state." : "";
                throw new Error(`Steam rejected the save: ${saved.error}.${mod}`);
            }
            saveNote = saved.navigated ? `saved (${saved.clicked}; page navigated to ${saved.url})` : `save clicked (${saved.clicked}) but no navigation was seen within 30s; verification below decides`;
        } finally { await page.close(); }
    }

    // Verify on the public page as the owner — through DevTools when Chrome is up either way.
    let verify: Awaited<ReturnType<typeof verifyPublic>> | null = null;
    if (await chromeUp(port)) verify = await verifyPublic(fileId, description, port);

    return {
        ok: !!verify?.verified,
        verified: !!verify?.verified,
        versionLine: verify?.versionLine ?? null,
        expectedVersionLine: verify?.expectedVersionLine ?? versionLineOf(description),
        moderation: verify?.moderation ?? { state: "unknown", notice: "public page not checked (no DevTools Chrome)" },
        chars: cap.chars, cap: cap.cap, previousChars, route, saveNote, warnings,
        ...(bridgeError ? { bridgeError } : {}),
        ...(verify ? { updated: verify.updated, publicUrl: verify.publicUrl } : {}),
    };
}

async function postChangelog(fileId: string, a: any, port?: number) {
    const confirm = a.confirm === true;
    const dryRun = !confirm && a.dryRun !== false;
    if (!confirm && !dryRun) throw new Error("Refusing to post without confirm:true (dryRun:false alone is not consent).");
    const title = String(a.title || "Changelog").trim() || "Changelog";
    if (a.thread && String(a.thread) !== "find-or-create") throw new Error("thread: only 'find-or-create' is supported.");

    // Body: given, or extracted from the description file.
    let bbcode = typeof a.bbcode === "string" ? a.bbcode.replace(/\r\n/g, "\n") : "";
    let wikiUrl: string | null = a.wikiChangelogUrl ? String(a.wikiChangelogUrl) : null;
    let extracted: any = null;
    if (a.steamDescriptionPath) {
        const p = String(a.steamDescriptionPath);
        if (!fs.existsSync(p)) throw new Error(`steamDescriptionPath not found: ${p}`);
        const text = fs.readFileSync(p, "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
        if (!bbcode) {
            if (!a.version) throw new Error("version is required to extract the changelog block from steamDescriptionPath (or pass bbcode).");
            const r = extractChangelogBlock(text, String(a.version));
            if (!r.ok) throw new Error(r.error);
            bbcode = r.block;
            extracted = { version: r.version, chars: r.chars };
        }
        if (!wikiUrl) wikiUrl = extractChangelogBlock(text, String(a.version || "")).wikiUrl;
    }
    if (!bbcode.trim()) throw new Error("Nothing to post: pass bbcode, or steamDescriptionPath + version.");

    if (!(await chromeUp(port))) throw new Error(`No RimAgentic Chrome answers on the DevTools port ${port || DEFAULT_CDP_PORT}. Run launch_chrome first.`);

    // ---- MILESTONE MODE: close out the "Next milestone: <version> <name>" thread ----------
    if (a.milestoneName !== undefined) {
        const version = String(a.version || "").trim().replace(/^v/i, "");
        if (!version) throw new Error("milestone mode needs `version` (it identifies the 'Next milestone: <version>' thread).");
        const milestoneName = String(a.milestoneName).trim();
        const newTitle = shippedTitle(version, milestoneName);
        const page = await openPage(discussionsUrl(fileId), port);
        try {
            const listing = await listThreads(page);
            if (!listing.loggedIn) throw new Error("The RimAgentic Chrome is not signed into Steam (no #account_pulldown on the discussions page).");
            const thread = findMilestoneThread(listing.threads, version);
            if (!thread) {
                throw new Error(
                    `No 'Next milestone: ${version} ...' thread on the Discussions tab (threads: ${listing.threads.map(t => t.name).join(" | ") || "none"}). ` +
                    `The workshop-backlog skill creates it at milestone start — run it, or post to the running Changelog thread instead (omit milestoneName).`
                );
            }
            const base = {
                fileId, mode: "milestone", version, milestoneName, discussionsUrl: listing.url,
                thread: { name: thread.name, href: thread.href, pinned: !!thread.pinned },
                newTitle, chars: bbcode.length, ...(extracted ? { extracted } : {}),
            };
            if (dryRun) {
                return {
                    dryRun: true, ...base,
                    would: `reply on "${thread.name}" (${thread.href}) with the changelog block, retitle the thread to "${newTitle}", and unpin it`,
                    reply: bbcode,
                    note: "Nothing was posted. Re-run with confirm:true to do exactly this.",
                };
            }
            await page.navigate(thread.href);
            const reply = await replyOnThread(page, bbcode);
            if (reply.error) throw new Error(`Steam refused the reply: ${reply.error}`);

            // Retitle: the OP edit form carries the topic title; keep the body byte-identical.
            let retitled = false, retitleNote = "";
            const cur = await openPostEdit(page, "op");
            if (!cur.ok) retitleNote = `could not open the OP edit form (${cur.note}) — retitle to "${newTitle}" by hand`;
            else {
                const saved = await saveOpenEdit(page, "op", cur.raw, newTitle);
                retitled = saved.ok;
                retitleNote = saved.note;
            }

            let unpinned = !thread.pinned, unpinNote = thread.pinned ? "" : "was not pinned";
            if (thread.pinned) {
                const pr = await setThreadPinned(page, false);
                unpinNote = pr.note;
                await page.navigate(discussionsUrl(fileId));
                const after = await listThreads(page);
                unpinned = !after.threads.find(t => t.href === thread.href && t.pinned);
                if (pr.acted && !unpinned) unpinNote = `clicked the admin-menu item (${pr.note}) but the listing still shows it pinned — unpin by hand`;
            }

            return {
                ok: true, ...base, threadUrl: thread.href, postUrl: reply.postUrl, postId: reply.postId ?? null,
                postConfirmed: !!reply.postId, retitled, retitleNote, unpinned, unpinNote,
                note: (reply.postId ? "Changelog posted; " : "Reply submitted but not observed — open threadUrl to confirm; ") +
                    `thread ${retitled ? `retitled to "${newTitle}"` : "NOT retitled"}, ${unpinned ? "unpinned" : "still pinned"}. The next milestone's thread takes the pin (workshop-backlog skill).`,
            };
        } finally { await page.close(); }
    }

    // ---- default: the running Changelog thread --------------------------------------------
    const page = await openPage(discussionsUrl(fileId), port);
    try {
        const listing = await listThreads(page);
        if (!listing.loggedIn) throw new Error("The RimAgentic Chrome is not signed into Steam (no #account_pulldown on the discussions page).");
        const plan = planChangelogThread(listing.threads, bbcode, { title, wikiUrl });
        const base = {
            fileId, discussionsUrl: listing.url, forumId: listing.forumId, title,
            action: plan.action, thread: plan.thread,
            ...(extracted ? { extracted } : {}),
            chars: bbcode.length, wikiUrl,
        };

        if (dryRun) {
            return {
                dryRun: true, ...base,
                would: plan.action === "create"
                    ? `create thread "${title}" on ${listing.url} with the first post below, then reply with the changelog block`
                    : `reply on existing thread "${plan.thread!.name}" (${plan.thread!.href}) with the changelog block`,
                firstPost: plan.firstPost || null,
                reply: bbcode,
                threadsSeen: listing.threads.map(t => ({ name: t.name, pinned: t.pinned, replies: t.replies })),
                canStart: listing.canStart,
                note: "Nothing was posted. Re-run with confirm:true to post exactly this.",
            };
        }

        // ---- confirmed ----
        let threadUrl = plan.thread?.href || "";
        let created = false;
        if (plan.action === "create") {
            if (!listing.forumId || !listing.canStart) throw new Error("Cannot start a discussion here: no newtopic area / Forum_CreateTopic on the page (discussions disabled, or not the owner).");
            const r = await createThread(page, listing.forumId, title, plan.firstPost);
            if (r.error) throw new Error(`Steam refused the new thread: ${r.error}`);
            if (/\/discussion\/\d+\/\d+/.test(r.url)) threadUrl = r.url;
            else {
                await page.navigate(discussionsUrl(fileId));
                const again = await listThreads(page);
                const found = findChangelogThread(again.threads, title);
                if (!found) throw new Error("The new thread was submitted but does not appear in the thread list yet — check the Discussions tab before retrying (a retry would create a duplicate).");
                threadUrl = found.href;
            }
            created = true;
        }

        if (page.url !== threadUrl) await page.navigate(threadUrl);
        const reply = await replyOnThread(page, bbcode);
        if (reply.error) throw new Error(`Steam refused the reply: ${reply.error}`);

        let pinned = false, pinNote = "pin not attempted";
        if (a.pin !== false) {
            const alreadyPinned = !!plan.thread?.pinned;
            if (alreadyPinned) { pinned = true; pinNote = "already pinned"; }
            else {
                const pr = await pinThread(page);
                pinNote = pr.note;
                if (pr.pinned) {
                    await page.navigate(discussionsUrl(fileId));
                    const after = await listThreads(page);
                    pinned = !!after.threads.find(t => t.href === threadUrl && t.pinned);
                    if (!pinned) pinNote = `clicked the admin-menu item (${pr.note}) but the thread list does not show it as pinned — pin it by hand`;
                }
            }
        }

        return {
            ok: true, ...base, created, threadUrl, postUrl: reply.postUrl, postId: reply.postId ?? null,
            postConfirmed: !!reply.postId, pinned, pinNote,
            note: reply.postId ? "Posted." : "Reply submitted but no new post element was observed within 10s — open threadUrl to confirm before retrying.",
        };
    } finally { await page.close(); }
}
