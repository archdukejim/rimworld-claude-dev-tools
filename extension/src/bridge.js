/*
 * Steam Workshop Helper — bridge (ISOLATED world content script)
 * --------------------------------------------------------------
 * Relays SWH calls between the extension (popup / background / a future
 * native MCP host) and the page-context `window.SWH` API defined in
 * swh-api.js (which lives in the MAIN world and cannot use chrome.* APIs).
 *
 *   chrome.runtime message  <->  window.postMessage  <->  window.SWH
 *
 * This is the seam the Phase-2 MCP native-messaging host plugs into: the
 * background worker forwards a native-host request here, we invoke SWH in
 * the page, and pass the result back. Phase 1 (Claude in Chrome) can ignore
 * this entirely and call window.SWH directly via the browser's JS tool.
 */
(function () {
  "use strict";

  const ORIGIN = "https://steamcommunity.com";
  let seq = 0;
  const pending = new Map(); // requestId -> {resolve, reject, timer}

  // Receive responses coming back from the MAIN-world SWH.
  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__swh !== true || d.dir !== "res") return;
    const p = pending.get(d.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(d.id);
    if (d.ok) p.resolve(d.result);
    else p.reject(new Error(d.error || "SWH error"));
  });

  // Invoke an SWH method in the page context and await its result.
  function callSWH(method, args, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const id = `b${Date.now().toString(36)}_${seq++}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`SWH.${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      window.postMessage({ __swh: true, dir: "req", id, method, args }, ORIGIN);
    });
  }

  // Expose to the extension (popup / background / native MCP host).
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== "SWH_CALL") return false;
    callSWH(msg.method, msg.args, msg.timeoutMs)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true; // keep the message channel open for the async response
  });
})();
