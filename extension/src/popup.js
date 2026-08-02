/* Steam Workshop Helper — popup UI */

const $ = (sel) => document.querySelector(sel);
const statusEl = $("#status");
const outputEl = $("#output");

// Ask the background worker to run an SWH method against the active Steam tab.
function proxy(method, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "SWH_PROXY", method, args, timeoutMs }, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      if (!resp) return reject(new Error("No response"));
      if (resp.ok) resolve(resp.result);
      else reject(new Error(resp.error));
    });
  });
}

function esc(s) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function showError(el, err) {
  el.innerHTML = `<div class="err">${esc(err.message || err)}</div>`;
}

// Ask the background worker for browser-wide Steam auth (reads the httpOnly
// steamLoginSecure cookie — works even with no workshop page open).
function getAuth() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "SWH_AUTH" }, (resp) => {
      if (chrome.runtime.lastError || !resp) return resolve({ loggedIn: false });
      resolve(resp.ok ? resp.result : { loggedIn: false });
    });
  });
}

async function renderAuth() {
  const el = $("#auth");
  const text = $("#auth-text");
  const auth = await getAuth();
  if (auth.loggedIn) {
    el.classList.remove("out");
    el.classList.add("in");
    text.innerHTML = `Logged in to Steam · <span class="muted">${esc(auth.steamId)}</span>`;
  } else {
    el.classList.remove("in");
    el.classList.add("out");
    text.innerHTML =
      `Not logged in — <a class="link" href="https://steamcommunity.com/login/home/" target="_blank" rel="noreferrer">sign in to Steam</a>`;
  }
  return auth;
}

let currentItem = null;

async function detect() {
  statusEl.innerHTML = `<div class="muted">Detecting…</div>`;
  try {
    const ctx = await proxy("getContext");
    if (!ctx) {
      currentItem = null;
      statusEl.innerHTML =
        `<div class="muted">No workshop item on the active tab.<br/>` +
        `Open a <b>steamcommunity.com/sharedfiles/filedetails</b> page.</div>`;
      return;
    }
    currentItem = ctx;
    statusEl.innerHTML =
      `<div class="title">${esc(ctx.title || "(untitled item)")}</div>` +
      `<div class="row"><span class="k">File ID</span><span class="v">${esc(ctx.fileId)}</span></div>` +
      `<div class="row"><span class="k">App ID</span><span class="v">${esc(ctx.appId || "?")}</span></div>` +
      `<div class="row"><span class="k">Owner</span><span class="v">${esc(ctx.ownerSteamId || "?")}</span></div>`;
  } catch (err) {
    showError(statusEl, err);
  }
}

async function listComments() {
  if (!currentItem) await detect();
  if (!currentItem) return;
  outputEl.hidden = false;
  outputEl.innerHTML = `<span class="muted">Loading comments…</span>`;
  try {
    const res = await proxy("listComments", { fileId: currentItem.fileId, count: 50 });
    if (!res.comments.length) {
      outputEl.innerHTML = `<span class="muted">No comments (total ${res.total}).</span>`;
      return;
    }
    outputEl.innerHTML =
      `<div class="muted">${res.total} comment(s):</div>` +
      res.comments
        .map((c) => {
          const when = c.timestamp ? new Date(c.timestamp * 1000).toLocaleString() : "";
          return (
            `<div class="comment"><div class="meta">${esc(c.author)} · ${esc(when)} · id ${esc(c.id)}</div>` +
            `<div class="body">${esc(c.text)}</div></div>`
          );
        })
        .join("");
  } catch (err) {
    showError(outputEl, err);
  }
}

const SNIPPET = `// Steam Workshop Helper — call from "Claude in Chrome" (javascript_tool),
// with a steamcommunity.com workshop page open. All methods are async.

// current item on the tab
await window.SWH.getContext();

// comments
await window.SWH.listComments({ fileId: "PUBLISHED_FILE_ID" });
await window.SWH.postComment({ fileId: "PUBLISHED_FILE_ID", text: "Thanks for the report!" });
await window.SWH.deleteComment({ fileId: "PUBLISHED_FILE_ID", commentId: "GIDCOMMENT" });

// title / description (must be logged in as the item owner)
await window.SWH.getItem({ fileId: "PUBLISHED_FILE_ID" });
await window.SWH.updateDescription({ fileId: "PUBLISHED_FILE_ID", description: "New BBCode body..." });
await window.SWH.updateTitle({ fileId: "PUBLISHED_FILE_ID", title: "New title" });`;

async function copySnippet() {
  try {
    await navigator.clipboard.writeText(SNIPPET);
    const btn = $("#btn-snippet");
    const old = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(() => (btn.textContent = old), 1500);
  } catch (err) {
    outputEl.hidden = false;
    showError(outputEl, err);
  }
}

$("#btn-refresh").addEventListener("click", detect);
$("#btn-comments").addEventListener("click", listComments);
$("#btn-snippet").addEventListener("click", copySnippet);

// initial
$("#version").textContent = "v" + chrome.runtime.getManifest().version;
renderAuth();
detect();
