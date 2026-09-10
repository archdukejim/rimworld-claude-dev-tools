/*
 * Unit coverage for the Layer 1.5 session context: identity resolution, the per-session modlist
 * cache, and the clean-template modlist builder.
 *
 *   cd server && npm run build && npm run test:session
 *
 * Pure functions only (no game, no loadConfig): identity/store from build/sessionContext.js, the
 * builder from build/tools/session.js against a throwaway Mods/ dir of About.xml fixtures. Touches
 * only temp dirs.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "session-"));
// Isolate the session store + live marker under the temp root (sessionContext keys off the lease dir's parent).
process.env.RIMAGENTIC_LEASE_DIR = path.join(scratch, "lease");

const ctx = require("../build/sessionContext.js");
const { buildSessionActiveMods } = require("../build/tools/session.js");

let passed = 0;
function check(label, cond) { assert.ok(cond, label); passed++; console.log("  ok -", label); }

// --- Identity ----------------------------------------------------------------
check("inferSessionId reads the worktree short-id from a path",
  ctx.inferSessionId({ repoPath: "C:\\github\\worktrees\\rimworld-claude-dev-tools\\d2029542\\game-mod" }) === "d2029542");
check("inferSessionId reads it from an agent/<id> branch ref",
  ctx.inferSessionId({ note: "on branch agent/ab12cd34 now" }) === "ab12cd34");
check("inferSessionId returns null when nothing matches",
  ctx.inferSessionId({ foo: "no id here" }) === null);

check("pinSession normalises to hex", ctx.pinSession("D2029542") === "d2029542");
check("resolveSessionId returns the pinned id", ctx.resolveSessionId({}, { required: true }) === "d2029542");
check("explicit sessionId arg overrides the pin",
  ctx.resolveSessionId({ sessionId: "beef01" }, { required: true }) === "beef01");

// --- Store round-trip --------------------------------------------------------
ctx.setSessionConfig("cafe12", { mods: ["a.b", "c.d", "a.b"], dlcs: ["Biotech", "royalty"] });
const got = ctx.getSessionConfig("cafe12");
check("store dedupes + lowercases mods", JSON.stringify(got.mods) === JSON.stringify(["a.b", "c.d"]));
check("store lowercases dlcs", JSON.stringify(got.dlcs) === JSON.stringify(["biotech", "royalty"]));
check("unknown session reads back null", ctx.getSessionConfig("nope99") === null);

// --- Clean-template builder --------------------------------------------------
const mods = path.join(scratch, "Mods");
function fixture(pkg, ordering = "") {
  const f = path.join(mods, pkg);
  fs.mkdirSync(path.join(f, "About"), { recursive: true });
  fs.writeFileSync(path.join(f, "About", "About.xml"),
    `<?xml version="1.0"?>\n<ModMetaData>\n  <packageId>${pkg}</packageId>\n  <name>${pkg}</name>\n${ordering}\n</ModMetaData>\n`, "utf8");
}
// The clean base, a DLC, and two content mods where beta must load after alpha.
["brrainz.harmony", "ludeon.rimworld", "ludeon.rimworld.royalty", "archdukejim.rimagentic", "test.alpha"].forEach((p) => fixture(p));
fixture("test.beta", "  <loadAfter>\n    <li>test.alpha</li>\n  </loadAfter>");

const built = buildSessionActiveMods({ mods: ["test.beta", "test.alpha"], dlcs: ["royalty"] }, { rimworldModsDir: mods });
const a = built.activeMods;
const idx = (id) => a.indexOf(id);

check("clean base is always injected (harmony, core, toolkit)",
  idx("brrainz.harmony") !== -1 && idx("ludeon.rimworld") !== -1 && idx("archdukejim.rimagentic") !== -1);
check("requested DLC is included", idx("ludeon.rimworld.royalty") !== -1);
check("requested content mods are included", idx("test.alpha") !== -1 && idx("test.beta") !== -1);
check("official block ordered harmony -> core -> DLC", idx("brrainz.harmony") < idx("ludeon.rimworld") && idx("ludeon.rimworld") < idx("ludeon.rimworld.royalty"));
check("toolkit is forced dead last", a[a.length - 1] === "archdukejim.rimagentic");
check("loadAfter within content mods is honoured (alpha before beta)", idx("test.alpha") < idx("test.beta"));
check("nothing flagged uninstalled (all fixtures on disk)", built.uninstalled.length === 0);

fs.rmSync(scratch, { recursive: true, force: true });
console.log(`\nsession: ${passed} checks passed`);
