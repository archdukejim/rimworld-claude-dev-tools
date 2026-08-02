/*
 * Steam Workshop Helper — core API (MAIN world)
 * -------------------------------------------------
 * Runs in the *page* context of steamcommunity.com so it can:
 *   - read the page's session globals (g_sessionID) and same-origin cookies
 *   - issue same-origin fetch() calls to Steam's comment / edit endpoints
 *     with the user's credentials automatically attached
 *
 * It exposes `window.SWH`, an async API that an automation client
 * (e.g. Claude via the "Claude in Chrome" browser tools, or a future MCP
 * bridge) can call. Every method returns a Promise that resolves to plain
 * JSON-serialisable data so it survives the browser tool boundary.
 *
 * Design notes (Hybrid mechanism, per project spec):
 *   - Comments use Steam's AJAX endpoints (render/post/delete). These are
 *     stable and confirmed against live workshop pages.
 *   - Title/description edits clone the owner's real edit <form> and re-POST
 *     it. Cloning the live form means every hidden field and session token
 *     Steam requires is carried along automatically — robust against form
 *     changes and safer than a hand-built request. If the AJAX/form route
 *     ever fails, callers can fall back to driving the edit page UI directly.
 */
(function () {
  "use strict";

  if (window.SWH && window.SWH.__installed) return; // idempotent (re-inject safe)

  const VERSION = "0.1.0";
  const ORIGIN = "https://steamcommunity.com";
  const COMMENT_FEATURE = "PublishedFile_Public";

  // ---- small utilities ----------------------------------------------------

  function getSessionId() {
    // page global first (most authoritative), then the sessionid cookie
    if (typeof window.g_sessionID === "string" && window.g_sessionID) {
      return window.g_sessionID;
    }
    const m = document.cookie.match(/(?:^|;\s*)sessionid=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  }

  function requireSession() {
    const sid = getSessionId();
    if (!sid) {
      throw new Error(
        "No Steam session found. Open/log in to steamcommunity.com in this browser first."
      );
    }
    return sid;
  }

  async function postForm(url, params) {
    const body = new URLSearchParams(params);
    const res = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
      },
      body,
    });
    return res;
  }

  async function fetchDoc(url) {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) {
      throw new Error(`GET ${url} failed: HTTP ${res.status}`);
    }
    const html = await res.text();
    return new DOMParser().parseFromString(html, "text/html");
  }

  // ---- item metadata resolution ------------------------------------------
  //
  // Given a workshop fileId, resolve the owner SteamID64 (needed for the
  // comment endpoints), the consumer appId (needed for the edit page) and the
  // current title. Results are cached for the page lifetime.

  const metaCache = new Map();

  function parseMetaFromDoc(doc, fileId) {
    const meta = { fileId: String(fileId) };

    // Owner + fileId live in the comment-thread token that Steam prints into
    // an inline <script>: PublishedFile_Public_<owner>_<fileId>
    const scriptText = Array.from(doc.querySelectorAll("script:not([src])"))
      .map((s) => s.textContent)
      .join("\n");
    const tok = scriptText.match(
      new RegExp(`${COMMENT_FEATURE}_([0-9]+)_${fileId}\\b`)
    );
    if (tok) meta.ownerSteamId = tok[1];

    // appId from the app breadcrumb: /app/<id>
    const appLink = doc.querySelector('.breadcrumbs a[href*="/app/"]');
    if (appLink) {
      const am = appLink.href.match(/\/app\/(\d+)/);
      if (am) meta.appId = am[1];
    }
    if (!meta.appId) {
      const am2 = scriptText.match(/g_AppID\s*=\s*parseInt\(\s*(\d+)/) ||
        scriptText.match(/"appid"\s*:\s*(\d+)/);
      if (am2) meta.appId = am2[1];
    }

    const titleEl = doc.querySelector(".workshopItemTitle");
    if (titleEl) meta.title = titleEl.textContent.trim();

    // Creator link — always present, used as an owner fallback when the
    // thread token isn't in the (sometimes JS-hydrated) HTML.
    const creator = doc.querySelector(".creatorsBlock a[href*='/id/'], .creatorsBlock a[href*='/profiles/']");
    if (creator) meta.creatorUrl = creator.getAttribute("href") || creator.href;

    return meta;
  }

  // Resolve an owner SteamID64 from a creator profile URL.
  //   /profiles/<id>  -> id directly
  //   /id/<vanity>    -> fetch <url>?xml=1 and read <steamID64> (no auth)
  async function ownerFromCreatorUrl(url) {
    if (!url) return null;
    const prof = url.match(/\/profiles\/(\d+)/);
    if (prof) return prof[1];
    const xmlUrl = url.split("#")[0].split("?")[0] + "?xml=1";
    try {
      const res = await fetch(xmlUrl, { credentials: "include" });
      const text = await res.text();
      const m = text.match(/<steamID64>(\d+)<\/steamID64>/);
      return m ? m[1] : null;
    } catch (_) {
      return null;
    }
  }

  async function resolveMeta(fileId, opts = {}) {
    fileId = String(fileId);
    if (metaCache.has(fileId) && !opts.force) return metaCache.get(fileId);

    // If we're already sitting on this item's page, parse the live DOM.
    let meta;
    const here = getContextSync();
    if (here && here.fileId === fileId) {
      meta = { ...here };
    } else {
      const doc = await fetchDoc(
        `${ORIGIN}/sharedfiles/filedetails/?id=${encodeURIComponent(fileId)}`
      );
      meta = parseMetaFromDoc(doc, fileId);
    }

    // allow explicit overrides
    if (opts.ownerSteamId) meta.ownerSteamId = String(opts.ownerSteamId);
    if (opts.appId) meta.appId = String(opts.appId);

    // Fallback: resolve owner from the creator profile link (handles pages
    // where the comment-thread token is hydrated client-side and absent from
    // the fetched HTML).
    if (!meta.ownerSteamId && meta.creatorUrl) {
      meta.ownerSteamId = await ownerFromCreatorUrl(meta.creatorUrl);
    }

    metaCache.set(fileId, meta);
    return meta;
  }

  // ---- current-page context ----------------------------------------------

  function getContextSync() {
    const m = location.href.match(/\/sharedfiles\/filedetails\/.*[?&]id=(\d+)/) ||
      location.href.match(/\/sharedfiles\/filedetails\/(\d+)/);
    if (!m) return null;
    const fileId = m[1];
    return parseMetaFromDoc(document, fileId);
  }

  /** Return metadata about the workshop item on the current tab (or null). */
  async function getContext() {
    const ctx = getContextSync();
    if (!ctx) return null;
    return resolveMeta(ctx.fileId);
  }

  // ---- authentication state ----------------------------------------------
  //
  // The extension never logs in — it uses whatever Steam session already
  // exists in this browser. `g_steamID` is Steam's own authoritative page
  // global: `false` when logged out, the user's SteamID64 (string) when
  // logged in. (The `sessionid` cookie is present even when logged out, so it
  // is NOT a valid auth signal.) For browser-wide / cross-tab tracking and
  // login/logout events, see the background worker's cookie watcher.

  function getAuth() {
    const sid = typeof window.g_steamID !== "undefined" ? window.g_steamID : false;
    const loggedIn = !!sid && sid !== false && sid !== "0" && sid !== 0;
    const nameEl = document.getElementById("account_pulldown");
    return {
      loggedIn,
      steamId: loggedIn ? String(sid) : null,
      accountId:
        typeof window.g_AccountID !== "undefined" && window.g_AccountID
          ? String(window.g_AccountID)
          : null,
      accountName: nameEl ? nameEl.textContent.trim() : null,
    };
  }

  /** Throw a clear error if not logged in (used before write actions). */
  function requireAuth() {
    const auth = getAuth();
    if (!auth.loggedIn) {
      throw new Error(
        "Not logged in to Steam in this browser. Sign in at steamcommunity.com first."
      );
    }
    return auth;
  }

  // ---- comments -----------------------------------------------------------

  function commentUrl(action, meta) {
    return `${ORIGIN}/comment/${COMMENT_FEATURE}/${action}/${meta.ownerSteamId}/${meta.fileId}/`;
  }

  function parseComments(html) {
    const root = document.createElement("div");
    root.innerHTML = html;
    return Array.from(root.querySelectorAll(".commentthread_comment")).map((el) => {
      const idAttr = el.id || ""; // comment_<gid>
      const id = idAttr.replace(/^comment_/, "");
      const authorLink = el.querySelector(".commentthread_author_link");
      const ts = el.querySelector(".commentthread_comment_timestamp[data-timestamp]");
      const textEl = el.querySelector(".commentthread_comment_text");
      const author = authorLink ? authorLink.textContent.trim() : null;
      const authorUrl = authorLink ? authorLink.getAttribute("href") : null;
      const authorId = authorLink ? authorLink.getAttribute("data-miniprofile") : null;
      return {
        id,
        author,
        authorId,
        authorUrl,
        timestamp: ts ? Number(ts.getAttribute("data-timestamp")) : null,
        text: textEl ? textEl.textContent.trim() : "",
      };
    });
  }

  /**
   * List comments on a workshop item.
   * @param {{fileId:string|number, ownerSteamId?:string, start?:number, count?:number}} args
   * @returns {Promise<{fileId:string, total:number, start:number, count:number, comments:Array}>}
   */
  async function listComments(args = {}) {
    const meta = await resolveMeta(args.fileId, args);
    if (!meta.ownerSteamId) throw new Error(`Could not resolve owner for item ${meta.fileId}`);
    const start = args.start ?? 0;
    const count = args.count ?? 100;
    const res = await postForm(commentUrl("render", meta), {
      start: String(start),
      count: String(count),
      sessionid: requireSession(),
      feature2: "-1",
    });
    const j = await res.json();
    if (!j || !j.success) {
      throw new Error(`listComments failed (HTTP ${res.status}, success=${j && j.success})`);
    }
    return {
      fileId: meta.fileId,
      total: j.total_count,
      start,
      count,
      comments: parseComments(j.comments_html || ""),
    };
  }

  /**
   * Post a comment on a workshop item.
   * @param {{fileId:string|number, text:string, ownerSteamId?:string}} args
   * @returns {Promise<{ok:boolean, newCommentId:?string, total:?number}>}
   */
  async function postComment(args = {}) {
    if (!args.text || !String(args.text).trim()) throw new Error("postComment requires non-empty `text`");
    requireAuth();
    const meta = await resolveMeta(args.fileId, args);
    if (!meta.ownerSteamId) throw new Error(`Could not resolve owner for item ${meta.fileId}`);
    const res = await postForm(commentUrl("post", meta), {
      comment: String(args.text),
      count: "6",
      sessionid: requireSession(),
      feature2: "-1",
    });
    const j = await res.json();
    if (!j || !j.success) {
      throw new Error(`postComment failed: ${(j && j.error) || `HTTP ${res.status}`}`);
    }
    // The freshest comment is last in the rendered payload.
    const rendered = parseComments(j.comments_html || "");
    const mine = rendered.length ? rendered[rendered.length - 1] : null;
    return { ok: true, newCommentId: mine ? mine.id : null, total: j.total_count ?? null };
  }

  /**
   * Delete a comment. You must own the comment or the item.
   * @param {{fileId:string|number, commentId:string, ownerSteamId?:string}} args
   * @returns {Promise<{ok:boolean, total:?number}>}
   */
  async function deleteComment(args = {}) {
    if (!args.commentId) throw new Error("deleteComment requires `commentId`");
    requireAuth();
    const meta = await resolveMeta(args.fileId, args);
    if (!meta.ownerSteamId) throw new Error(`Could not resolve owner for item ${meta.fileId}`);
    const res = await postForm(commentUrl("delete", meta), {
      gidcomment: String(args.commentId),
      start: "0",
      count: "6",
      sessionid: requireSession(),
      feature2: "-1",
    });
    const j = await res.json();
    if (!j || !j.success) {
      throw new Error(`deleteComment failed: ${(j && j.error) || `HTTP ${res.status}`}`);
    }
    return { ok: true, total: j.total_count ?? null };
  }

  // ---- comment notifications ---------------------------------------------
  //
  // Steam aggregates "someone commented on your stuff" into a Comment
  // Notifications page. We parse it for which items have new activity, then
  // (in reviewNotifications) enrich each with the actual latest comments — the
  // notification page itself carries no comment text.

  const NOTIF_URL = `${ORIGIN}/my/commentnotifications`;

  function parseNotifications(doc) {
    const num = (s) => {
      const m = (s || "").match(/\d+/);
      return m ? parseInt(m[0], 10) : null;
    };
    return Array.from(doc.querySelectorAll(".commentnotification")).map((el) => {
      const a = el.querySelector("a.commentnotification_click_overlay, a[href]");
      const href = a ? a.getAttribute("href") || "" : "";
      const idm = href.match(/[?&]id=(\d+)/) || href.match(/filedetails\/(\d+)/);
      const desc = (el.querySelector(".commentnotification_description")?.textContent || "").trim();
      return {
        fileId: idm ? idm[1] : null,
        title: (el.querySelector(".commentnotification_title")?.textContent || "").trim(),
        description: desc,
        newPosts: num(el.querySelector(".commentnotification_newposts")?.textContent),
        dateText: (el.querySelector(".commentnotification_date")?.textContent || "")
          .replace(/\s+/g, " ")
          .trim(),
        isOwnItem: /your .*workshop item/i.test(desc),
      };
    });
  }

  /**
   * Raw comment-notifications list (items with new comment activity).
   * @returns {Promise<{count:number, notifications:Array}>}
   */
  async function getNotifications() {
    const doc = await fetchDoc(NOTIF_URL);
    const notifications = parseNotifications(doc);
    return { count: notifications.length, notifications };
  }

  /**
   * Comment notifications enriched with the actual latest comments per item —
   * the "review my recent notifications" digest.
   * @param {{ownItemsOnly?:boolean, perItem?:number}} args
   */
  async function reviewNotifications(args = {}) {
    const ownOnly = args.ownItemsOnly !== false; // default: only your items
    const perItem = args.perItem ?? 5;
    const { notifications } = await getNotifications();

    const targets = notifications.filter((n) => n.fileId && (!ownOnly || n.isOwnItem));
    const items = [];
    for (const n of targets) {
      let latestComments;
      try {
        const res = await listComments({ fileId: n.fileId, count: 30 });
        latestComments = res.comments
          .slice()
          .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
          .slice(0, perItem)
          .map((c) => ({
            id: c.id,
            author: c.author,
            authorId: c.authorId,
            timestamp: c.timestamp,
            text: c.text,
          }));
      } catch (err) {
        latestComments = [{ error: String((err && err.message) || err) }];
      }
      items.push({
        fileId: n.fileId,
        title: n.title,
        dateText: n.dateText,
        newPosts: n.newPosts,
        url: `${ORIGIN}/sharedfiles/filedetails/?id=${n.fileId}`,
        latestComments,
      });
    }

    const skipped = notifications
      .filter((n) => !n.fileId)
      .map((n) => ({ title: n.title, dateText: n.dateText, note: n.description }));

    return { itemCount: items.length, items, skipped };
  }

  // ---- title / description (edit-form clone) ------------------------------

  function editUrl(meta) {
    // Title & description are edited via the ItemEditText form.
    return `${ORIGIN}/sharedfiles/itemedittext/?id=${encodeURIComponent(meta.fileId)}`;
  }

  // Locate the form on the edit page that carries the title/description fields.
  function findEditForm(doc) {
    const forms = Array.from(doc.querySelectorAll("form"));
    // Prefer a form that actually contains a description control.
    let form =
      forms.find((f) => f.querySelector('[name="description"], #description')) ||
      forms.find((f) => /edititem/i.test(f.getAttribute("action") || "")) ||
      forms.find((f) => f.querySelector('[name="title"]'));
    return form || null;
  }

  // Serialise a form's current fields into a params object.
  function serializeForm(form) {
    const params = {};
    for (const el of form.elements) {
      if (!el.name || el.disabled) continue;
      const type = (el.type || "").toLowerCase();
      if (type === "checkbox" || type === "radio") {
        if (el.checked) params[el.name] = el.value;
      } else if (el.tagName === "SELECT") {
        params[el.name] = el.value;
      } else if (type !== "submit" && type !== "button" && type !== "file") {
        params[el.name] = el.value;
      }
    }
    return params;
  }

  /**
   * Read the current editable fields of a workshop item (from its edit form).
   * Requires ownership (Steam only serves the edit page to the owner).
   * @param {{fileId:string|number, appId?:string}} args
   * @returns {Promise<{fileId, appId, title, description, visibility, fields}>}
   */
  async function getItem(args = {}) {
    const meta = await resolveMeta(args.fileId, args);
    const doc = await fetchDoc(editUrl(meta));
    const form = findEditForm(doc);
    if (!form) {
      throw new Error(
        "Edit form not found. Are you logged in as the item owner? " +
          "(Steam only serves the edit page to the owner.)"
      );
    }
    const fields = serializeForm(form);
    return {
      fileId: meta.fileId,
      appId: meta.appId,
      title: fields.title ?? meta.title ?? null,
      description: fields.description ?? null,
      visibility: fields.visibility ?? null,
      fields,
    };
  }

  /**
   * Generic item update: clone the live edit form, override the given fields,
   * and re-POST. Returns success plus the resulting item (re-read).
   * @param {{fileId:string|number, appId?:string, fields:object}} args
   */
  async function updateItem(args = {}) {
    const overrides = args.fields || {};
    if (!Object.keys(overrides).length) throw new Error("updateItem requires `fields`");
    requireAuth();
    const meta = await resolveMeta(args.fileId, args);

    const url = editUrl(meta);
    const doc = await fetchDoc(url);
    const form = findEditForm(doc);
    if (!form) {
      throw new Error(
        "Edit form not found. Are you logged in as the item owner?"
      );
    }

    const params = serializeForm(form);
    Object.assign(params, overrides);
    // Ensure a valid session token / item id even if the form didn't carry one.
    if (!params.sessionid) params.sessionid = requireSession();
    if (!params.id) params.id = meta.fileId;

    const action = form.getAttribute("action");
    const postUrl = action ? new URL(action, url).href : url;
    const res = await postForm(postUrl, params);
    if (!res.ok) throw new Error(`updateItem POST failed: HTTP ${res.status}`);

    // Steam redirects to the item page on success; re-read to confirm.
    metaCache.delete(meta.fileId);
    let after = null;
    try {
      after = await getItem({ fileId: meta.fileId, appId: meta.appId });
    } catch (_) {
      /* re-read is best-effort */
    }
    return { ok: true, fileId: meta.fileId, item: after };
  }

  /** Update just the description (BBCode/plain text). */
  async function updateDescription(args = {}) {
    if (typeof args.description !== "string") {
      throw new Error("updateDescription requires string `description`");
    }
    const result = await updateItem({
      fileId: args.fileId,
      appId: args.appId,
      fields: { description: args.description },
    });
    const ok =
      result.item == null || result.item.description === args.description;
    return { ...result, verified: ok };
  }

  /** Update just the title. */
  async function updateTitle(args = {}) {
    if (typeof args.title !== "string" || !args.title.trim()) {
      throw new Error("updateTitle requires non-empty string `title`");
    }
    const result = await updateItem({
      fileId: args.fileId,
      appId: args.appId,
      fields: { title: args.title },
    });
    const ok = result.item == null || result.item.title === args.title;
    return { ...result, verified: ok };
  }

  // ---- public surface -----------------------------------------------------

  const SWH = {
    __installed: true,
    version: VERSION,
    // context / auth
    getContext,
    getAuth,
    resolveMeta,
    // comments
    listComments,
    postComment,
    deleteComment,
    // notifications
    getNotifications,
    reviewNotifications,
    // item text
    getItem,
    updateItem,
    updateDescription,
    updateTitle,
    // introspection
    methods() {
      return [
        "getContext",
        "getAuth",
        "resolveMeta",
        "listComments",
        "postComment",
        "deleteComment",
        "getNotifications",
        "reviewNotifications",
        "getItem",
        "updateItem",
        "updateDescription",
        "updateTitle",
      ];
    },
  };

  Object.defineProperty(window, "SWH", { value: SWH, writable: false, configurable: true });

  // ---- postMessage request handler (for the extension bridge / MCP) -------
  //
  // A relay content script (bridge.js, isolated world) can forward requests
  // here from the extension background / a native MCP host:
  //   window.postMessage({ __swh:true, dir:"req", id, method, args }, ORIGIN)
  // We answer with:
  //   window.postMessage({ __swh:true, dir:"res", id, ok, result|error }, ORIGIN)

  window.addEventListener("message", async (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__swh !== true || d.dir !== "req") return;
    const { id, method, args } = d;
    const respond = (payload) =>
      window.postMessage({ __swh: true, dir: "res", id, ...payload }, ORIGIN);
    try {
      if (typeof SWH[method] !== "function") {
        throw new Error(`Unknown SWH method: ${method}`);
      }
      const result = await SWH[method](args || {});
      respond({ ok: true, result });
    } catch (err) {
      respond({ ok: false, error: String((err && err.message) || err) });
    }
  });

  console.info(`[SWH] Steam Workshop Helper v${VERSION} ready — window.SWH available.`);
})();
