/*
 * Unit coverage for the About.xml load-order handler: resolveModLoadOrder must honour
 * forceLoadAfter / forceLoadBefore, not just loadAfter / loadBefore.
 *
 *   cd server && npm run build && npm run test:loadorder
 *
 * RimWorld treats the "force" variants as the SAME ordering relationship as the plain ones (the
 * force only weights the in-game auto-sorter more heavily). The toolkit's own About.xml declares
 * forceLoadAfter, so if the resolver dropped it the test harness would write a ModsConfig.xml that
 * disagrees with RimSort / the in-game sorter. These fixtures use non-toolkit packageIds so they
 * exercise the GENERAL force-variant handling, independent of the toolkit's separate dead-last rule.
 *
 * Pure filesystem test: builds a throwaway Mods/ dir of About.xml fixtures, touches nothing real.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { resolveModLoadOrder } = require("../build/tools/testing.js");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "loadorder-"));

/** Write a fixture mod folder with the given packageId and raw ordering XML. */
function mod(packageId, orderingXml = "") {
    const folder = path.join(scratch, packageId);
    fs.mkdirSync(path.join(folder, "About"), { recursive: true });
    fs.writeFileSync(
        path.join(folder, "About", "About.xml"),
        `<?xml version="1.0" encoding="utf-8"?>\n<ModMetaData>\n  <packageId>${packageId}</packageId>\n  <name>${packageId}</name>\n${orderingXml}\n</ModMetaData>\n`,
        "utf8"
    );
}

const config = { rimworldModsDir: scratch };
let passed = 0;
function check(label, cond) {
    assert.ok(cond, label);
    passed++;
    console.log("  ok -", label);
}

// --- forceLoadAfter reorders, exactly like loadAfter -------------------------------------------
// patcher declares forceLoadAfter content; given [patcher, content] it must resolve [content, patcher].
mod("test.content");
mod("test.patcher", "  <forceLoadAfter>\n    <li>test.content</li>\n  </forceLoadAfter>");

{
    const { resolved } = resolveModLoadOrder(["test.patcher", "test.content"], config);
    check(
        "forceLoadAfter places the declarer after its target",
        resolved.indexOf("test.content") < resolved.indexOf("test.patcher")
    );
}

// --- forceLoadBefore reorders too --------------------------------------------------------------
// early declares forceLoadBefore content; given [content, early] it must resolve [early, content].
mod("test.early", "  <forceLoadBefore>\n    <li>test.content</li>\n  </forceLoadBefore>");

{
    const { resolved } = resolveModLoadOrder(["test.content", "test.early"], config);
    check(
        "forceLoadBefore places the declarer before its target",
        resolved.indexOf("test.early") < resolved.indexOf("test.content")
    );
}

// --- a mod declaring ONLY force variants is not treated as unordered/ambiguous ------------------
{
    const { ambiguous } = resolveModLoadOrder(["test.patcher", "test.content"], config);
    check(
        "a mod with only forceLoadAfter is not reported ambiguous",
        !ambiguous.map(m => m.toLowerCase()).includes("test.patcher")
    );
}

// --- plain loadAfter still works (no regression) -----------------------------------------------
mod("test.plainafter", "  <loadAfter>\n    <li>test.content</li>\n  </loadAfter>");
{
    const { resolved } = resolveModLoadOrder(["test.plainafter", "test.content"], config);
    check(
        "loadAfter still reorders after the fix",
        resolved.indexOf("test.content") < resolved.indexOf("test.plainafter")
    );
}

fs.rmSync(scratch, { recursive: true, force: true });
console.log(`\nloadorder: ${passed} checks passed`);
