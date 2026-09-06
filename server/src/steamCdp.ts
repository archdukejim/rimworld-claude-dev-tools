/*
 * Steam Workshop over the DevTools protocol — the zero-dependency route.
 * ------------------------------------------------------------------------
 * The RimAgentic Chrome (chromeCtl.ts) runs with --remote-debugging-port=9222 and holds the
 * logged-in Steam session. Node >= 22 has a global WebSocket, so nothing here needs a package:
 *
 *   PUT  http://127.0.0.1:9222/json/new?<url>      -> { id, webSocketDebuggerUrl }
 *   ws   Page.enable / Runtime.enable / Page.loadEventFired / Runtime.evaluate(returnByValue)
 *   GET  http://127.0.0.1:9222/json/close/<id>
 *
 * This is the fallback the swh_* tools take when the extension loopback bridge is not connected
 * (which, with several MCP servers running, is the normal case — see bridge.ts). It is also the
 * ONLY route for the Discussions tools, which the extension never implemented.
 *
 * Every Runtime.evaluate expression starts with a `swh:<probe>` block-comment marker. The unit tests run a
 * stub CDP endpoint that cannot execute JavaScript, so it answers by probe name; keep the marker
 * on any expression you add, and keep the returned shapes in sync with test/steam-cdp-stub.test.js.
 *
 * Page anatomy (captured 2026-09-05, logged in as the owner):
 *   edit page   https://steamcommunity.com/sharedfiles/itemedittext/?id=<fileId>
 *               #account_pulldown (logged in) · #description textarea · a.btn_green_white_innerfade "Save"
 *               after save: navigates to /sharedfiles/itemedittext/ (no id), no error text
 *   public page https://steamcommunity.com/sharedfiles/filedetails/?id=<fileId>
 *               .workshopItemDescription; moderation notices are plain body text (steamLogic.ts)
 *   discussions https://steamcommunity.com/workshop/filedetails/discussions/<fileId>/
 *               div#forum_<forumId>_newtopic_area, forumId = PublishedFile_<appForumId>_<fileId>
 *               "Start a New Discussion" = javascript:Forum_CreateTopic('<forumId>')
 *               form#forum_<forumId>_newtopic_form: input[name=topic] (title), #forum_<forumId>_textarea,
 *               button[id$=_submit] inside [id$=_submit_container]; errors in #forum_<forumId>_newtopic_error
 *               rows: .forum_topic (class "sticky" when pinned) .forum_topic_name .forum_topic_reply_count a.forum_topic_overlay
 *   thread      https://steamcommunity.com/workshop/filedetails/discussion/<fileId>/<topicId>/
 *               reply: textarea#commentthread_ForumTopic_<a>_<b>_<topicId>_textarea (.forumtopic_reply_textarea)
 *               submit: button#commentthread_ForumTopic_<a>_<b>_<topicId>_submit; posts: .forum_op, [id^=comment_]
 *               owner admin menu: img.admin_option_icon -> popup items (pin/unpin, lock, delete)
 */

export const DEFAULT_CDP_PORT = 9222;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Base URL of the DevTools HTTP endpoint. RIMAGENTIC_CDP_BASE lets the tests point at a stub. */
export function cdpBase(port?: number): string {
    const env = process.env.RIMAGENTIC_CDP_BASE?.trim();
    if (env) return env.replace(/\/$/, "");
    return `http://127.0.0.1:${port && port > 0 ? Math.round(port) : DEFAULT_CDP_PORT}`;
}

/** Post-load settle (Steam's forum/edit widgets initialise after the load event). Tests shrink it. */
function settleMs(): number {
    const env = process.env.RIMAGENTIC_CDP_SETTLE_MS?.trim();
    return env && /^\d+$/.test(env) ? parseInt(env, 10) : 1500;
}

export async function chromeUp(port?: number): Promise<boolean> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 2500);
    try {
        const res = await fetch(`${cdpBase(port)}/json/version`, { signal: ac.signal });
        return res.ok;
    } catch { return false; }
    finally { clearTimeout(t); }
}

export interface Page {
    url: string;
    /** Run an expression in the page. `probe` names it for the stub and for error messages. */
    evaluate<T = any>(probe: string, expression: string): Promise<T>;
    /** Resolve on the next Page.loadEventFired (or time out quietly), then settle. */
    waitLoad(timeoutMs?: number): Promise<boolean>;
    navigate(url: string): Promise<void>;
    /** Close the tab and the websocket. */
    close(): Promise<void>;
    /** Drop the websocket but LEAVE the tab open (swh_open_item). */
    detach(): Promise<void>;
}

interface Waiter { method: string; resolve: (e: any) => void }

/** Open a fresh tab on `url`, attach over the websocket, wait for load. Always `close()` it. */
export async function openPage(url: string, port?: number): Promise<Page> {
    const base = cdpBase(port);
    const res = await fetch(`${base}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
    if (!res.ok) throw new Error(`DevTools /json/new failed: HTTP ${res.status}`);
    const target = await res.json() as { id: string; webSocketDebuggerUrl: string };
    if (!target?.webSocketDebuggerUrl) throw new Error("DevTools /json/new returned no webSocketDebuggerUrl");

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    let seq = 0;
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    const waiters: Waiter[] = [];
    let closed = false;

    await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", () => reject(new Error(`websocket to ${target.webSocketDebuggerUrl} failed`)));
    });
    ws.addEventListener("message", (ev: any) => {
        let msg: any;
        try { msg = JSON.parse(String(ev.data)); } catch { return; }
        if (msg.id && pending.has(msg.id)) {
            const p = pending.get(msg.id)!;
            pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            else p.resolve(msg.result);
        } else if (msg.method) {
            for (let i = waiters.length - 1; i >= 0; i--) {
                if (waiters[i].method === msg.method) { const w = waiters[i]; waiters.splice(i, 1); w.resolve(msg); }
            }
        }
    });
    ws.addEventListener("close", () => {
        closed = true;
        for (const [, p] of pending) p.reject(new Error("DevTools websocket closed"));
        pending.clear();
    });

    const send = (method: string, params: any = {}): Promise<any> => new Promise((resolve, reject) => {
        if (closed) return reject(new Error("DevTools websocket closed"));
        const id = ++seq;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
    });

    const waitLoad = async (timeoutMs = 30_000): Promise<boolean> => {
        const hit = await new Promise<boolean>(resolve => {
            const timer = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); resolve(false); }, timeoutMs);
            const w: Waiter = { method: "Page.loadEventFired", resolve: () => { clearTimeout(timer); resolve(true); } };
            waiters.push(w);
        });
        await sleep(settleMs());
        return hit;
    };

    const page: Page = {
        url,
        async evaluate<T>(probe: string, expression: string): Promise<T> {
            const r = await send("Runtime.evaluate", { expression: `/* swh:${probe} */ ${expression}`, returnByValue: true, awaitPromise: true });
            if (r?.exceptionDetails) {
                const d = r.exceptionDetails;
                throw new Error(`page script '${probe}' threw: ${d.exception?.description || d.text || JSON.stringify(d).slice(0, 300)}`);
            }
            return r?.result?.value as T;
        },
        waitLoad,
        async navigate(next: string) {
            page.url = next;
            const p = waitLoad();
            await send("Page.navigate", { url: next });
            await p;
        },
        async detach() {
            try { ws.close(); } catch { /* already closed */ }
        },
        async close() {
            // Close the target over HTTP first: it is the part that matters, and it survives a
            // websocket that is already gone.
            try { await fetch(`${base}/json/close/${target.id}`); } catch { /* tab already gone */ }
            try { ws.close(); } catch { /* already closed */ }
        }
    };

    // Enable events, then wait for the initial load. The load may already have fired for a fast
    // page, so a quiet timeout here is fine — the settle covers it.
    const loading = waitLoad(20_000);
    await send("Page.enable");
    await send("Runtime.enable");
    await loading;
    return page;
}

// ---------------------------------------------------------------------------- Steam URLs

export const editUrl = (fileId: string) => `https://steamcommunity.com/sharedfiles/itemedittext/?id=${encodeURIComponent(fileId)}`;
export const publicUrl = (fileId: string) => `https://steamcommunity.com/sharedfiles/filedetails/?id=${encodeURIComponent(fileId)}`;
export const discussionsUrl = (fileId: string) => `https://steamcommunity.com/workshop/filedetails/discussions/${encodeURIComponent(fileId)}/`;

// ---------------------------------------------------------------------------- page scripts

export interface AuthInfo { loggedIn: boolean; steamId: string | null; accountId: string | null; accountName: string | null }

const AUTH_EXPR = `(() => {
  const sid = typeof window.g_steamID !== "undefined" ? window.g_steamID : false;
  const el = document.getElementById("account_pulldown");
  const loggedIn = !!el || (!!sid && sid !== "0" && sid !== 0);
  return {
    loggedIn,
    steamId: loggedIn && sid ? String(sid) : null,
    accountId: (typeof window.g_AccountID !== "undefined" && window.g_AccountID) ? String(window.g_AccountID) : null,
    accountName: el ? el.textContent.trim() : null
  };
})()`;

/** Login state as the RimAgentic Chrome sees it (same shape as the extension's SWH.getAuth). */
export async function readAuth(port?: number): Promise<AuthInfo & { route: "devtools" }> {
    const page = await openPage("https://steamcommunity.com/", port);
    try { return { ...(await page.evaluate<AuthInfo>("auth", AUTH_EXPR)), route: "devtools" }; }
    finally { await page.close(); }
}

export interface EditProbe {
    url: string; title: string; loggedIn: boolean; hasTextarea: boolean;
    description: string; itemTitle: string | null; visibility: string | null; error: string;
}

const EDIT_PROBE_EXPR = `(() => {
  const ta = document.querySelector('#description');
  const form = ta ? ta.closest('form') : null;
  const field = (n) => { const e = form ? form.querySelector('[name="' + n + '"]') : null; return e ? e.value : null; };
  return {
    url: location.href, title: document.title,
    loggedIn: !!document.querySelector('#account_pulldown'),
    hasTextarea: !!ta,
    description: ta ? ta.value : "",
    itemTitle: field('title'),
    visibility: field('visibility'),
    error: (document.body.innerText.match(/(Access Denied[^\\n]*|There was a problem[^\\n]*)/i) || [''])[0]
  };
})()`;

export async function probeEditPage(page: Page): Promise<EditProbe> {
    return await page.evaluate<EditProbe>("editProbe", EDIT_PROBE_EXPR);
}

/** Fill the description textarea and click Save. Resolves once the page has navigated (or timed out). */
export async function saveDescription(page: Page, text: string): Promise<{ clicked: string; navigated: boolean; url: string; error: string }> {
    await page.evaluate("setDescription", `(() => {
      const ta = document.querySelector('#description');
      if (!ta) throw new Error('no #description textarea');
      ta.value = ${JSON.stringify(text)};
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      return ta.value.length;
    })()`);
    const load = page.waitLoad(30_000);
    const clicked = await page.evaluate<string>("clickSave", `(() => {
      const b = [...document.querySelectorAll('a.btn_green_white_innerfade, #SubmitButton, input[type=submit], button[type=submit]')]
        .find(x => /save/i.test((x.innerText || x.value || '').trim())) || document.querySelector('a.btn_green_white_innerfade');
      if (!b) return 'no-button';
      b.click();
      return 'clicked:' + (b.id || b.className);
    })()`);
    if (clicked === "no-button") throw new Error("No Save button on the edit page (a.btn_green_white_innerfade) — is this the owner's session?");
    const navigated = await load;
    const after = await page.evaluate<{ url: string; error: string }>("afterSave", `(() => ({
      url: location.href,
      error: (document.body.innerText.match(/(Access Denied[^\\n]*|There was a problem[^\\n]*)/i) || [''])[0]
    }))()`);
    return { clicked, navigated, ...after };
}

export interface PublicRead { url: string; title: string; descriptionText: string; bodyText: string; updated: string }

const PUBLIC_EXPR = `(() => ({
  url: location.href, title: document.title,
  descriptionText: (document.querySelector('.workshopItemDescription') || {}).innerText || '',
  bodyText: document.body.innerText,
  // The stats box is two columns (labels, then values), so a text regex on "Updated" lands on the file
  // size. The values column is .detailsStatRight: [size, posted, updated?] - take the last.
  updated: ([...document.querySelectorAll('.detailsStatRight')].map(e => e.innerText.trim()).pop() || '')
}))()`;

/** The public item page as the logged-in owner sees it (anonymous fetches differ while flagged). */
export async function readPublicPage(fileId: string, port?: number): Promise<PublicRead> {
    const page = await openPage(publicUrl(fileId), port);
    try { return await page.evaluate<PublicRead>("publicRead", PUBLIC_EXPR); }
    finally { await page.close(); }
}

export interface ThreadListing {
    url: string; loggedIn: boolean; forumId: string | null;
    threads: Array<{ name: string; href: string; pinned: boolean; replies: string }>;
    canStart: boolean;
}

const THREADS_EXPR = `(() => {
  const area = document.querySelector('div[id$="_newtopic_area"]');
  const forumId = area ? area.id.replace(/^forum_/, '').replace(/_newtopic_area$/, '') : null;
  return {
    url: location.href,
    loggedIn: !!document.querySelector('#account_pulldown'),
    forumId,
    canStart: !!forumId && typeof window.Forum_CreateTopic === 'function',
    threads: [...document.querySelectorAll('.forum_topic')].map(x => ({
      name: (x.querySelector('.forum_topic_name') || {}).innerText || '',
      href: (x.querySelector('a.forum_topic_overlay') || {}).href || '',
      pinned: /\\bsticky\\b/.test(x.className),
      replies: ((x.querySelector('.forum_topic_reply_count') || {}).innerText || '').trim()
    })).map(t => ({ ...t, name: t.name.trim() }))
  };
})()`;

export async function listThreads(page: Page): Promise<ThreadListing> {
    return await page.evaluate<ThreadListing>("threads", THREADS_EXPR);
}

/**
 * Create a discussion thread from the Discussions tab. Steam's form posts over AJAX and then
 * navigates to the new topic; the caller re-lists threads to find it if that does not happen.
 */
export async function createThread(page: Page, forumId: string, title: string, body: string): Promise<{ error: string; url: string; navigated: boolean }> {
    const opened = await page.evaluate<string>("openNewTopic", `(() => {
      if (typeof window.Forum_CreateTopic !== 'function') return 'no-Forum_CreateTopic';
      window.Forum_CreateTopic(${JSON.stringify(forumId)});
      return 'ok';
    })()`);
    if (opened !== "ok") throw new Error("This page has no Forum_CreateTopic — not logged in, or discussions are disabled for the item.");
    await sleep(500);
    const filled = await page.evaluate<string>("fillNewTopic", `(() => {
      const form = document.querySelector('form#forum_' + ${JSON.stringify(forumId)} + '_newtopic_form');
      if (!form) return 'no-form';
      const title = form.querySelector('input[name="topic"], input[type=text]');
      const ta = document.querySelector('#forum_' + ${JSON.stringify(forumId)} + '_textarea') || form.querySelector('textarea');
      if (!title || !ta) return 'no-fields';
      title.value = ${JSON.stringify(title)};
      title.dispatchEvent(new Event('input', { bubbles: true }));
      ta.value = ${JSON.stringify(body)};
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok';
    })()`);
    if (filled !== "ok") throw new Error(`New-topic form not usable (${filled}) — expected form#forum_${forumId}_newtopic_form with input[name=topic] and #forum_${forumId}_textarea.`);
    const load = page.waitLoad(20_000);
    const clicked = await page.evaluate<string>("submitNewTopic", `(() => {
      const form = document.querySelector('form#forum_' + ${JSON.stringify(forumId)} + '_newtopic_form');
      const b = form && (form.querySelector('[id$="_submit_container"] button, [id$="_submit_container"] .btn_green_white_innerfade, button[id$="_submit"]'));
      if (!b) return 'no-button';
      b.click();
      return 'ok';
    })()`);
    if (clicked !== "ok") throw new Error("No submit button in the new-topic form ([id$=_submit_container]).");
    const navigated = await load;
    const after = await page.evaluate<{ url: string; error: string }>("afterNewTopic", `(() => ({
      url: location.href,
      error: ((document.querySelector('#forum_' + ${JSON.stringify(forumId)} + '_newtopic_error') || {}).innerText || '').trim()
    }))()`);
    return { ...after, navigated };
}

/** Reply on an open thread page. Steam posts over AJAX; the new post appears in place. */
export async function replyOnThread(page: Page, body: string): Promise<{ error: string; postId: string | null; postUrl: string }> {
    const before = await page.evaluate<string[]>("postsBefore", `[...document.querySelectorAll('[id^="comment_"]')].map(e => e.id)`);
    const filled = await page.evaluate<string>("fillReply", `(() => {
      const ta = [...document.querySelectorAll('textarea.forumtopic_reply_textarea')].find(t => /^commentthread_ForumTopic_/.test(t.id));
      if (!ta) return 'no-textarea';
      ta.value = ${JSON.stringify(body)};
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      const b = document.getElementById(ta.id.replace(/_textarea$/, '_submit'));
      if (!b) return 'no-button';
      b.click();
      return 'ok';
    })()`);
    if (filled !== "ok") throw new Error(`Reply form not usable (${filled}) — expected textarea#commentthread_ForumTopic_*_textarea and its _submit button.`);
    // AJAX post: poll for a new post element rather than a navigation.
    let postId: string | null = null;
    let error = "";
    for (let i = 0; i < 20 && !postId; i++) {
        await sleep(500);
        const now = await page.evaluate<{ ids: string[]; error: string }>("postsAfter", `(() => ({
          ids: [...document.querySelectorAll('[id^="comment_"]')].map(e => e.id),
          error: ((document.querySelector('[id$="_error"]:not([style*="display: none"])') || {}).innerText || '').trim()
        }))()`);
        error = now.error || "";
        const fresh = now.ids.filter(id => !before.includes(id));
        if (fresh.length) postId = fresh[fresh.length - 1].replace(/^comment_/, "");
        if (error) break;
    }
    const url = await page.evaluate<string>("threadUrl", `location.href`);
    return { error, postId, postUrl: postId ? `${url.replace(/#.*$/, "")}#c${postId}` : url };
}

/**
 * Best-effort pin from the owner's admin menu on the thread page. The menu is Steam's popup
 * (img.admin_option_icon -> items); we click the first item that reads "pin"/"sticky". Reports
 * false rather than guessing when no such item is present.
 */
export async function pinThread(page: Page): Promise<{ pinned: boolean; note: string }> {
    const opened = await page.evaluate<string>("openAdminMenu", `(() => {
      const icon = document.querySelector('.admin_option_icon, [class*="admin_option"]');
      if (!icon) return 'no-admin-menu';
      icon.click();
      return 'ok';
    })()`);
    if (opened !== "ok") return { pinned: false, note: "No owner admin menu (.admin_option_icon) on the thread page — not the owner, or Steam changed the markup." };
    await sleep(400);
    const clicked = await page.evaluate<string>("clickPin", `(() => {
      const items = [...document.querySelectorAll('.popup_menu_item, .popup_menu a, .popup_menu div, [class*="popup_menu"] *')]
        .filter(e => /\\b(pin|sticky|stick)\\b/i.test((e.innerText || '').trim()) && !/unpin|unstick/i.test(e.innerText || ''));
      if (!items.length) return 'no-pin-item';
      items[0].click();
      return 'clicked:' + items[0].innerText.trim();
    })()`);
    if (clicked === "no-pin-item") return { pinned: false, note: "Admin menu opened but had no pin/sticky item — pin it by hand from the thread's admin menu." };
    await sleep(1200);
    return { pinned: true, note: clicked };
}
