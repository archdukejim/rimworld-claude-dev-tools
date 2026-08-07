/*
 * Steam Workshop Helper — background service worker
 * -------------------------------------------------
 * Phase 1: thin helper for the popup — finds the active Steam Workshop tab
 * and forwards SWH calls to its content-script bridge.
 *
 * Phase 2 (see docs/MCP-PHASE2.md): this worker is where a native-messaging
 * connection to a local MCP host is established. The host exposes SWH methods
 * as MCP tools; this worker routes each tool call to the right workshop tab
 * via `callActiveTab` / `callTabForItem` and returns the JSON result. The
 * plumbing below is intentionally small and reusable for that.
 */

const STEAM_ITEM_RE = /^https:\/\/steamcommunity\.com\/sharedfiles\/filedetails\/.*[?&]id=(\d+)/;

// Send an SWH call to a specific tab's bridge.
function callTab(tabId, method, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(
      tabId,
      { type: "SWH_CALL", method, args, timeoutMs },
      (resp) => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error(err.message));
        if (!resp) return reject(new Error("No response from content script"));
        if (resp.ok) resolve(resp.result);
        else reject(new Error(resp.error));
      }
    );
  });
}

// Find a steamcommunity.com tab (prefers the active one) to run calls in.
async function findSteamTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active && /^https:\/\/steamcommunity\.com\//.test(active.url || "")) return active;
  const tabs = await chrome.tabs.query({ url: "https://steamcommunity.com/*" });
  return tabs[0] || null;
}

// Convenience used by the popup and (later) the MCP host.
async function callActiveTab(method, args, timeoutMs) {
  const tab = await findSteamTab();
  if (!tab) {
    throw new Error("No steamcommunity.com tab open. Open a Steam Workshop page first.");
  }
  return callTab(tab.id, method, args, timeoutMs);
}

// ---- Steam login tracking ------------------------------------------------
//
// The extension never performs a login. It observes the browser's existing
// Steam session so it always knows whether you're authenticated.
//
// The authoritative, browser-wide signal is the `steamLoginSecure` cookie on
// steamcommunity.com. It is httpOnly (invisible to page scripts) but readable
// here via the chrome.cookies API. Its value is `<steamID64>||<token>`, so it
// also tells us *who* is logged in. We watch it live via cookies.onChanged and
// reflect the state on the toolbar badge + chrome.storage, so login/logout is
// picked up the instant it happens — no page reload needed.

const STEAM_URL = "https://steamcommunity.com";
const AUTH_COOKIE = "steamLoginSecure";

function parseAuthCookie(cookie) {
  if (!cookie || !cookie.value) return { loggedIn: false, steamId: null };
  const val = decodeURIComponent(cookie.value);
  const steamId = (val.split("||")[0] || "").match(/^\d{17}$/) ? val.split("||")[0] : null;
  return { loggedIn: !!steamId, steamId };
}

async function readAuth() {
  try {
    const cookie = await chrome.cookies.get({ url: STEAM_URL, name: AUTH_COOKIE });
    return parseAuthCookie(cookie);
  } catch (e) {
    return { loggedIn: false, steamId: null, error: String(e && e.message) };
  }
}

async function reflectAuth(auth) {
  await chrome.storage.local.set({ swhAuth: { ...auth, checkedAt: Date.now() } });
  try {
    await chrome.action.setBadgeText({ text: auth.loggedIn ? "●" : "" });
    await chrome.action.setBadgeBackgroundColor({ color: auth.loggedIn ? "#4c9e2f" : "#d9534f" });
    await chrome.action.setTitle({
      title: auth.loggedIn
        ? `Steam Workshop Helper — logged in (${auth.steamId})`
        : "Steam Workshop Helper — logged out",
    });
  } catch (_) {
    /* action APIs unavailable in some contexts; storage is the source of truth */
  }
}

async function refreshAuth() {
  const auth = await readAuth();
  await reflectAuth(auth);
  return auth;
}

// React the instant the login cookie changes (login, logout, expiry, switch).
chrome.cookies.onChanged.addListener((info) => {
  const c = info.cookie;
  if (!c || c.name !== AUTH_COOKIE) return;
  if (!/(^|\.)steamcommunity\.com$/.test(c.domain)) return;
  refreshAuth();
});

chrome.runtime.onInstalled.addListener(refreshAuth);
chrome.runtime.onStartup.addListener(refreshAuth);
refreshAuth(); // on worker spin-up

// Popup / other extension pages talk to the worker through this.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;
  if (msg.type === "SWH_AUTH") {
    refreshAuth()
      .then((auth) => sendResponse({ ok: true, result: auth }))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }
  if (msg.type === "SWH_PROXY") {
    callActiveTab(msg.method, msg.args, msg.timeoutMs)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }
  if (msg.type === "SWH_BRIDGE_SET") {
    // Re-enabling: kick the poll loop now. Disabling: the loop's while-check exits it.
    if (msg.enabled) bridgeLoop();
    sendResponse({ ok: true, enabled: !!msg.enabled });
    return true;
  }
  return false;
});

// ---- MCP loopback bridge client ------------------------------------------
//
// Connects out to the local MCP server's loopback bridge (see mcp/server) and
// executes SWH commands on its behalf. Everything stays on 127.0.0.1 — the
// extension never talks to the network here. The server long-polls model keeps
// this service worker alive (a poll fetch is almost always in flight); a 1-min
// alarm restarts the loop if the worker was ever torn down.

const BRIDGE = { host: "127.0.0.1", port: 8766 };
let bridgeRunning = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bridgeBase = () => `http://${BRIDGE.host}:${BRIDGE.port}`;

// Open (or focus + navigate) a browser tab directly on a workshop item, then
// wait until the content script is ready so follow-up SWH calls work. This is
// the bootstrap for the "no Steam tab open" case and lets an MCP client jump
// straight to a specific mod.
function itemUrl(fileId) {
  return `https://steamcommunity.com/sharedfiles/filedetails/?id=${encodeURIComponent(fileId)}`;
}

async function waitForTabReady(tabId, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (_) {
      throw new Error("Tab was closed before the workshop page finished loading.");
    }
    if (tab.status === "complete") {
      // Ping getContext to confirm window.SWH has been injected and is ready.
      try {
        return await callTab(tabId, "getContext", {}, 5000);
      } catch (_) {
        /* not ready yet — keep polling */
      }
    }
    await sleep(300);
  }
  throw new Error("Timed out waiting for the workshop page to load.");
}

async function openWorkshopItem(args) {
  const fileId = args && args.fileId;
  if (!fileId) throw new Error("openItem requires `fileId`");
  const url = itemUrl(fileId);
  const activate = args.activate !== false; // default: bring the tab to front
  let tab = await findSteamTab();
  if (tab) {
    tab = await chrome.tabs.update(tab.id, { url, active: activate });
  } else {
    tab = await chrome.tabs.create({ url, active: activate });
  }
  const context = await waitForTabReady(tab.id);
  return { ok: true, tabId: tab.id, url, context };
}

// Route a bridge command: tab-management actions run here in the background;
// everything else is forwarded to window.SWH in the active Steam tab.
async function runCommand(method, args) {
  if (method === "openItem") return await openWorkshopItem(args || {});
  return await callActiveTab(method, args, 25000);
}

async function bridgeEnabled() {
  const { swhBridgeEnabled } = await chrome.storage.local.get("swhBridgeEnabled");
  return swhBridgeEnabled !== false; // default on
}

async function bridgeLoop() {
  if (bridgeRunning) return;
  bridgeRunning = true;
  try {
    while (await bridgeEnabled()) {
      let resp;
      try {
        resp = await fetch(`${bridgeBase()}/poll`, { method: "GET", cache: "no-store" });
      } catch (_) {
        // Server not running yet; back off and let the alarm re-drive us.
        await sleep(3000);
        continue;
      }
      if (resp.status === 204) continue; // poll timeout, immediately re-poll
      if (!resp.ok) {
        await sleep(2000);
        continue;
      }
      let cmd;
      try {
        cmd = (await resp.json()).command;
      } catch (_) {
        continue;
      }
      if (!cmd) continue;

      let payload;
      try {
        const result = await runCommand(cmd.method, cmd.args);
        payload = { id: cmd.id, ok: true, result };
      } catch (err) {
        payload = { id: cmd.id, ok: false, error: String((err && err.message) || err) };
      }
      try {
        await fetch(`${bridgeBase()}/result`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } catch (_) {
        // Server went away mid-call; the loop will reconnect on the next poll.
      }
    }
  } finally {
    bridgeRunning = false;
  }
}

// Keep the loop alive across service-worker lifecycles.
chrome.alarms.create("swhBridge", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "swhBridge") bridgeLoop();
});

// Restart the poll loop the instant this profile is (re)enabled — covers the popup
// toggle setting storage directly, even if the SWH_BRIDGE_SET message is missed.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.swhBridgeEnabled && changes.swhBridgeEnabled.newValue !== false) {
    bridgeLoop();
  }
});
chrome.runtime.onStartup.addListener(bridgeLoop);
chrome.runtime.onInstalled.addListener(bridgeLoop);
bridgeLoop();

// Expose helpers for reuse / diagnostics.
self.SWH_BG = { callTab, findSteamTab, callActiveTab, readAuth, refreshAuth, bridgeLoop, STEAM_ITEM_RE };
