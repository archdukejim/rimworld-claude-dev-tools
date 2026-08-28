/*
 * The Steam-bridge port must be resilient across concurrent MCP servers.
 *
 *   cd server && npm run build && npm run test:bridge
 *
 * Every Claude session runs its own MCP server, but the extension long-polls ONE fixed port, so only
 * one server can own it. The old bridge bound once and rejected on EADDRINUSE, leaving `bridge` null
 * for the whole session — swh_* dead even after the port later freed. This asserts the new behavior:
 * a second bridge on a taken port does NOT throw, reports owner:false, its call() fails with a clear
 * "owned by another session" message, and it AUTOMATICALLY takes over once the first bridge closes.
 */
const assert = require("assert");
const { startBridge } = require("../build/bridge.js");

const PORT = 8799; // a free high port for the test, not the real 8766
const config = {
  bridgeHost: "127.0.0.1",
  bridgePort: PORT,
  pollTimeoutMs: 1000,
  callTimeoutMs: 400,
};
process.env.SWH_MCP_REBIND_MS = "150"; // fast takeover so the test is quick

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
function check(label, cond) { assert.ok(cond, label); passed++; console.log("  ok -", label); }

(async () => {
  const b1 = await startBridge(config);
  await sleep(200);
  check("first bridge owns the port", b1.status().owner === true);

  const b2 = await startBridge(config); // must NOT throw on EADDRINUSE
  await sleep(200);
  check("second bridge does not own the taken port", b2.status().owner === false);
  check("second bridge reports not connected", b2.status().connected === false);

  let rejected = null;
  try { await b2.call("get_auth", {}); } catch (e) { rejected = e.message; }
  check("non-owner call() rejects with an owned-by-another message", !!rejected && /owned by another/i.test(rejected));

  // Owner exits — the waiter must grab the port within a retry interval.
  await b1.close();
  await sleep(500);
  check("second bridge takes over the freed port automatically", b2.status().owner === true);

  await b2.close();
  console.log(`\nbridge-rebind: ${passed} checks passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
