import {
    chromeUp, openPage, discussionsUrl, topicUrl, publicUrl, listThreads, createThread, replyOnThread,
    readThread, openPostEdit, saveOpenEdit, setThreadPinned, readPublicPage, DEFAULT_CDP_PORT, Page,
} from "../steamCdp";
import {
    checkDiscussionPostCap, checkLinkDomains, parseModeration, parseTopicId, findThreadByTitle,
    DISCUSSION_POST_CAP,
} from "../steamLogic";

/*
 * Steam Workshop Discussions tools — list, read, create, reply, edit, pin/unpin threads on a
 * workshop item's Discussions tab. This is what lets the Discussions tab replace the GitHub
 * backlog + changelog for players (the workshop-backlog skill drives these; conventions in
 * docs/DISCUSSIONS.md).
 *
 * Route: DevTools-only (steamCdp.ts — needs launch_chrome with the Steam owner session). The
 * extension bridge never implemented discussions, and the DevTools route drives Steam's own
 * page JS (Forum_CreateTopic, the comment-thread widget), which is far more robust than
 * reverse-engineering the forum AJAX endpoints into the extension. This mirrors how
 * swh_post_changelog already works; the bridge keeps covering what it implements.
 *
 * Write discipline (every write tool):
 *   - DRY RUN by default — returns exactly what would be posted; only confirm:true posts.
 *   - re-reads the current text before writing (edit refuses to save blind).
 *   - refuses bodies over the discussion post cap (steamLogic.DISCUSSION_POST_CAP).
 *   - warns on links outside the well-known-domain allow-list (Steam's content scan).
 *   - returns the public URL of what it touched, and the item's moderation state afterwards
 *     (Steam re-scans on edits; a flag here means players cannot see the item).
 */

const fileIdProp = { fileId: { type: "string", description: "The Steam Workshop published file ID (the number in the item URL)." } };
const topicIdProp = { topicId: { type: "string", description: "The discussion topic id (last path segment of the thread URL; from swh_list_discussions)." } };
const portProp = { port: { type: "number", description: `RimAgentic Chrome DevTools port (default ${DEFAULT_CDP_PORT}).` } };
const confirmProps = {
    dryRun: { type: "boolean", description: "Return the plan without posting (default true)." },
    confirm: { type: "boolean", description: "Actually post/edit. Required for any change; the default is a dry run." },
};

export const discussionsTools = [
    {
        name: "swh_list_discussions",
        description:
            "List every thread on a workshop item's Discussions tab. Returns { threads: [{ topicId, title, url, " +
            "pinned, replies, lastActivity, author }], forumId, canStart }. Read-only. DevTools route (launch_chrome, " +
            "signed into Steam).",
        inputSchema: { type: "object", properties: { ...fileIdProp, ...portProp }, required: ["fileId"] },
    },
    {
        name: "swh_find_discussion",
        description:
            "Find one discussion thread by EXACT title (case-insensitive, trimmed, 'PINNED:' prefix ignored; pinned " +
            "match wins). Returns { thread: { topicId, title, url, pinned } | null } — the create-vs-edit decision " +
            "point for the workshop-backlog skill. Read-only.",
        inputSchema: {
            type: "object",
            properties: { ...fileIdProp, title: { type: "string", description: "Exact thread title to find." }, ...portProp },
            required: ["fileId", "title"],
        },
    },
    {
        name: "swh_get_discussion",
        description:
            "Read one discussion thread: the OP and every reply as { postId ('op' for the opener), author, authorHref, " +
            "timestamp, bbcode, bbcodeSource }. For posts THIS session may edit (own posts), the RAW BBCode is read " +
            "from Steam's inline edit form (bbcodeSource:'raw' — the form is opened read-only, never saved); other " +
            "posts return rendered text (bbcodeSource:'rendered'). Pass raw:false to skip the edit-form reads and " +
            "return rendered text for everything (faster). Read-only.",
        inputSchema: {
            type: "object",
            properties: {
                ...fileIdProp, ...topicIdProp,
                raw: { type: "boolean", description: "Read raw BBCode for editable posts via the edit form (default true)." },
                ...portProp,
            },
            required: ["fileId", "topicId"],
        },
    },
    {
        name: "swh_create_discussion",
        description:
            `Create a discussion thread (title + BBCode body) on a workshop item, optionally pinning it. DEFAULT IS A ` +
            `DRY RUN returning the exact title/body it would post; only confirm:true posts. Refuses bodies over the ` +
            `${DISCUSSION_POST_CAP}-character post cap and refuses a duplicate exact title (edit the existing thread ` +
            `instead — swh_find_discussion decides). Warns on links outside the well-known domains. Returns ` +
            `{ topicId, url, pinned } plus the item's moderation state (Steam re-scans on new content). Owner/DevTools.`,
        inputSchema: {
            type: "object",
            properties: {
                ...fileIdProp,
                title: { type: "string", description: "Thread title." },
                body: { type: "string", description: "Opening post (Steam BBCode)." },
                pin: { type: "boolean", description: "Pin the thread after creating (owner only; default false)." },
                ...confirmProps, ...portProp,
            },
            required: ["fileId", "title", "body"],
        },
    },
    {
        name: "swh_reply_discussion",
        description:
            `Post a reply on a discussion thread. DEFAULT IS A DRY RUN (shows the thread it would reply on and the ` +
            `exact body); only confirm:true posts. Re-reads the thread first, refuses bodies over the ` +
            `${DISCUSSION_POST_CAP}-character cap, warns on unfamiliar link domains. Returns { postId, url } plus the ` +
            `item's moderation state. DevTools route.`,
        inputSchema: {
            type: "object",
            properties: {
                ...fileIdProp, ...topicIdProp,
                body: { type: "string", description: "Reply body (Steam BBCode)." },
                ...confirmProps, ...portProp,
            },
            required: ["fileId", "topicId", "body"],
        },
    },
    {
        name: "swh_edit_discussion_post",
        description:
            `Edit a discussion post IN PLACE — the OP (postId omitted or 'op') or a reply — via Steam's inline edit ` +
            `form. Always re-reads the current RAW BBCode first and returns it next to the proposed body (diff before ` +
            `you confirm); a body identical to the current text is a no-op. The OP edit can also retitle the thread ` +
            `(newTitle). DEFAULT IS A DRY RUN; only confirm:true saves. Refuses bodies over the ` +
            `${DISCUSSION_POST_CAP}-character cap, warns on unfamiliar domains, returns the thread URL + moderation ` +
            `state after saving. Only posts this session owns are editable. DevTools route.`,
        inputSchema: {
            type: "object",
            properties: {
                ...fileIdProp, ...topicIdProp,
                postId: { type: "string", description: "The reply's post id (from swh_get_discussion). Omit (or 'op') to edit the opening post." },
                body: { type: "string", description: "New full body (Steam BBCode) — replaces the post's text." },
                newTitle: { type: "string", description: "New thread title (OP edits only — the OP form carries the title)." },
                ...confirmProps, ...portProp,
            },
            required: ["fileId", "topicId", "body"],
        },
    },
    {
        name: "swh_pin_discussion",
        description:
            "Pin or unpin a discussion thread from the owner's admin menu. Idempotent — a thread already in the " +
            "wanted state is a no-op. Verifies against the thread listing afterwards and returns { pinned, url }. " +
            "Owner only; DevTools route.",
        inputSchema: {
            type: "object",
            properties: {
                ...fileIdProp, ...topicIdProp,
                pinned: { type: "boolean", description: "true to pin, false to unpin." },
                ...portProp,
            },
            required: ["fileId", "topicId", "pinned"],
        },
    },
];

const okText = (obj: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] });

async function requireChrome(port?: number) {
    if (!(await chromeUp(port))) {
        throw new Error(`No RimAgentic Chrome answers on the DevTools port ${port || DEFAULT_CDP_PORT}. Run launch_chrome first (its profile is already signed into Steam).`);
    }
}

async function withPage<T>(url: string, port: number | undefined, fn: (page: Page) => Promise<T>): Promise<T> {
    const page = await openPage(url, port);
    try { return await fn(page); } finally { await page.close(); }
}

/** Moderation state of the item's public page — Steam re-scans on every edit, so writes report it. */
async function moderationAfter(fileId: string, port?: number) {
    try {
        const pub = await readPublicPage(fileId, port);
        return parseModeration(pub.bodyText);
    } catch (e: any) {
        return { state: "unknown", notice: `public page not checked: ${e?.message || e}` };
    }
}

interface ListedThread { topicId: string | null; title: string; url: string; pinned: boolean; replies: string | number; lastActivity: string; author: string; }

function mapThreads(threads: any[]): ListedThread[] {
    return (threads || []).map((t: any) => ({
        topicId: parseTopicId(t.href),
        title: String(t.name || "").replace(/^PINNED:\s*/i, "").trim(),
        url: t.href || "",
        pinned: !!t.pinned,
        replies: t.replies ?? "",
        lastActivity: t.lastActivity ?? "",
        author: t.author ?? "",
    }));
}

async function listOn(fileId: string, port?: number) {
    return await withPage(discussionsUrl(fileId), port, async page => {
        const listing = await listThreads(page);
        if (!listing.loggedIn) throw new Error("The RimAgentic Chrome is not signed into Steam (no #account_pulldown on the discussions page).");
        return listing;
    });
}

function gate(a: any): { dryRun: boolean } {
    const confirm = a.confirm === true;
    const dryRun = !confirm && a.dryRun !== false;
    if (!confirm && !dryRun) throw new Error("Refusing to post without confirm:true (dryRun:false alone is not consent).");
    return { dryRun };
}

/** Cap + domain guardrails for a post body; throws on cap, returns warnings for domains. */
function checkBody(body: string): { warnings: string[] } {
    const cap = checkDiscussionPostCap(body);
    if (!cap.ok) throw new Error(cap.message!);
    const domains = checkLinkDomains(body);
    return { warnings: domains.ok ? [] : [domains.warning!] };
}

export async function handleDiscussionsTool(name: string, args: any) {
    const a = args || {};
    const port = Number(a.port) > 0 ? Math.round(Number(a.port)) : undefined;
    const fileId = String(a.fileId || "").trim();
    if (!fileId) throw new Error("fileId is required");
    await requireChrome(port);

    // ---- reads -----------------------------------------------------------------------------
    if (name === "swh_list_discussions") {
        const listing = await listOn(fileId, port);
        return okText({
            fileId, url: listing.url, forumId: listing.forumId, canStart: listing.canStart,
            threads: mapThreads(listing.threads),
        });
    }

    if (name === "swh_find_discussion") {
        const title = String(a.title || "").trim();
        if (!title) throw new Error("title is required");
        const listing = await listOn(fileId, port);
        const hit = findThreadByTitle(listing.threads, title);
        return okText({ fileId, title, thread: hit ? mapThreads([hit])[0] : null, threadsSeen: listing.threads.length });
    }

    if (name === "swh_get_discussion") {
        const topicId = String(a.topicId || "").trim();
        if (!topicId) throw new Error("topicId is required");
        const raw = a.raw !== false;
        return okText(await withPage(topicUrl(fileId, topicId), port, async page => {
            const t = await readThread(page);
            if (!t.loggedIn) throw new Error("The RimAgentic Chrome is not signed into Steam.");
            if (!t.posts.length) throw new Error(`No posts found at ${topicUrl(fileId, topicId)} — wrong topicId, or the thread was deleted.`);
            const posts: any[] = [];
            for (const p of t.posts) {
                let bbcode = p.text, source = "rendered", note: string | undefined;
                if (raw && p.editable) {
                    const r = await openPostEdit(page, p.postId);   // read-only: the form is never saved
                    if (r.ok) { bbcode = r.raw; source = "raw"; }
                    else note = r.note;
                }
                posts.push({ postId: p.postId, author: p.author, authorHref: p.authorHref, timestamp: p.timestamp, bbcode, bbcodeSource: source, ...(note ? { rawNote: note } : {}) });
            }
            return { fileId, topicId, url: topicUrl(fileId, topicId), title: t.title, posts };
        }));
    }

    // ---- writes ----------------------------------------------------------------------------
    if (name === "swh_create_discussion") {
        const title = String(a.title || "").trim();
        const body = String(a.body || "").replace(/\r\n/g, "\n");
        if (!title || !body.trim()) throw new Error("title and body are required");
        const { dryRun } = gate(a);
        const { warnings } = checkBody(body);

        const listing = await listOn(fileId, port);
        const existing = findThreadByTitle(listing.threads, title);
        const base = { fileId, title, chars: body.length, cap: DISCUSSION_POST_CAP, warnings, pin: a.pin === true };
        if (existing) {
            const t = mapThreads([existing])[0];
            return okText({
                ...base, ok: false, refused: true, existing: t,
                error: `A thread titled "${t.title}" already exists (${t.url}) — edit it in place with swh_edit_discussion_post instead of creating a duplicate.`,
            });
        }
        if (dryRun) {
            return okText({
                dryRun: true, ...base, body,
                would: `create thread "${title}" on ${listing.url}${a.pin === true ? ", then pin it" : ""}`,
                note: "Nothing was posted. Re-run with confirm:true to post exactly this.",
            });
        }
        if (!listing.forumId || !listing.canStart) throw new Error("Cannot start a discussion here: no newtopic area / Forum_CreateTopic on the page (discussions disabled, or not logged in).");

        return okText(await withPage(discussionsUrl(fileId), port, async page => {
            const r = await createThread(page, listing.forumId!, title, body);
            if (r.error) throw new Error(`Steam refused the new thread: ${r.error}`);
            let threadHref = /\/discussion\/\d+\/\d+/.test(r.url) ? r.url : "";
            if (!threadHref) {
                await page.navigate(discussionsUrl(fileId));
                const again = await listThreads(page);
                const found = findThreadByTitle(again.threads, title);
                if (!found) throw new Error("The new thread was submitted but does not appear in the list yet — check the Discussions tab before retrying (a retry would create a duplicate).");
                threadHref = found.href;
            }
            const topicId = parseTopicId(threadHref);

            let pinned = false, pinNote = "pin not requested";
            if (a.pin === true) {
                if (page.url !== threadHref) await page.navigate(threadHref);
                const pr = await setThreadPinned(page, true);
                pinNote = pr.note;
                await page.navigate(discussionsUrl(fileId));
                const after = await listThreads(page);
                pinned = !!after.threads.find(t => t.href === threadHref && t.pinned);
                if (pr.acted && !pinned) pinNote = `clicked the admin-menu item (${pr.note}) but the listing does not show it pinned — pin by hand`;
            }
            return { ok: true, ...base, topicId, url: threadHref, pinned, pinNote, moderation: await moderationAfter(fileId, port) };
        }));
    }

    if (name === "swh_reply_discussion") {
        const topicId = String(a.topicId || "").trim();
        const body = String(a.body || "").replace(/\r\n/g, "\n");
        if (!topicId || !body.trim()) throw new Error("topicId and body are required");
        const { dryRun } = gate(a);
        const { warnings } = checkBody(body);

        return okText(await withPage(topicUrl(fileId, topicId), port, async page => {
            const t = await readThread(page);                       // the re-read: know what you reply on
            if (!t.loggedIn) throw new Error("The RimAgentic Chrome is not signed into Steam.");
            if (!t.posts.length) throw new Error(`No posts at ${topicUrl(fileId, topicId)} — wrong topicId?`);
            const base = { fileId, topicId, threadTitle: t.title, url: topicUrl(fileId, topicId), postsBefore: t.posts.length, chars: body.length, cap: DISCUSSION_POST_CAP, warnings };
            if (dryRun) {
                return { dryRun: true, ...base, body, would: `reply on "${t.title}"`, note: "Nothing was posted. Re-run with confirm:true to post exactly this." };
            }
            const r = await replyOnThread(page, body);
            if (r.error) throw new Error(`Steam refused the reply: ${r.error}`);
            return {
                ok: true, ...base, postId: r.postId, postUrl: r.postUrl, postConfirmed: !!r.postId,
                moderation: await moderationAfter(fileId, port),
                ...(r.postId ? {} : { note: "Reply submitted but no new post element observed within 10s — open the thread to confirm before retrying." }),
            };
        }));
    }

    if (name === "swh_edit_discussion_post") {
        const topicId = String(a.topicId || "").trim();
        const body = String(a.body || "").replace(/\r\n/g, "\n");
        if (!topicId || !body.trim()) throw new Error("topicId and body are required");
        const postId = String(a.postId || "op").trim() || "op";
        const newTitle = a.newTitle !== undefined ? String(a.newTitle) : null;
        if (newTitle !== null && postId !== "op") throw new Error("newTitle only applies to the OP (the topic form carries the title).");
        const { dryRun } = gate(a);
        const { warnings } = checkBody(body);

        return okText(await withPage(topicUrl(fileId, topicId), port, async page => {
            const t = await readThread(page);
            if (!t.loggedIn) throw new Error("The RimAgentic Chrome is not signed into Steam.");
            const post = t.posts.find(p => p.postId === postId);
            if (!post) throw new Error(`Post '${postId}' not found on ${topicUrl(fileId, topicId)} (posts: ${t.posts.map(p => p.postId).join(", ")}).`);
            if (!post.editable) throw new Error(`Post '${postId}' has no edit affordance — it is not this session's post.`);

            // Mandatory re-read: the edit form yields the current RAW BBCode before anything is written.
            const cur = await openPostEdit(page, postId);
            if (!cur.ok) throw new Error(`Could not open the edit form to re-read post '${postId}': ${cur.note}`);
            const unchanged = cur.raw.replace(/\r\n/g, "\n") === body && (newTitle === null || newTitle === cur.title);
            const base = {
                fileId, topicId, postId, url: topicUrl(fileId, topicId), threadTitle: t.title,
                currentChars: cur.raw.length, chars: body.length, cap: DISCUSSION_POST_CAP, warnings,
                ...(newTitle !== null ? { currentTitle: cur.title, newTitle } : {}),
            };
            if (unchanged) return { ok: true, upToDate: true, ...base, note: "The post already has exactly this body — nothing to save." };
            if (dryRun) {
                return {
                    dryRun: true, ...base, current: cur.raw, proposed: body,
                    would: `replace post '${postId}' on "${t.title}"${newTitle !== null ? ` and retitle the thread to "${newTitle}"` : ""}`,
                    note: "Nothing was saved (the edit form was opened read-only). Diff current vs proposed, then re-run with confirm:true.",
                };
            }
            const saved = await saveOpenEdit(page, postId, body, newTitle);
            if (!saved.ok) throw new Error(saved.note);
            return { ok: true, ...base, saveNote: saved.note, moderation: await moderationAfter(fileId, port) };
        }));
    }

    if (name === "swh_pin_discussion") {
        const topicId = String(a.topicId || "").trim();
        if (!topicId) throw new Error("topicId is required");
        if (typeof a.pinned !== "boolean") throw new Error("pinned (boolean) is required");
        const want = a.pinned;

        const listing = await listOn(fileId, port);
        const rows = mapThreads(listing.threads);
        const row = rows.find(r => r.topicId === topicId);
        if (!row) throw new Error(`Topic ${topicId} not in the thread listing for item ${fileId}.`);
        if (row.pinned === want) return okText({ ok: true, upToDate: true, fileId, topicId, pinned: row.pinned, url: row.url });

        const acted = await withPage(row.url, port, page => setThreadPinned(page, want));
        const after = await listOn(fileId, port);
        const now = mapThreads(after.threads).find(r => r.topicId === topicId);
        const pinned = !!now?.pinned;
        return okText({
            ok: pinned === want, fileId, topicId, pinned, url: row.url, note: acted.note,
            ...(pinned !== want ? { warning: `The listing still shows pinned=${pinned} — ${want ? "pin" : "unpin"} it by hand from the thread's admin menu.` } : {}),
        });
    }

    throw new Error(`Unknown discussions tool: ${name}`);
}
