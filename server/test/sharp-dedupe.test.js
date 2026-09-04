/*
 * Regression guard: exactly ONE copy of sharp may exist in the dependency tree.
 *
 *   cd server && npm run test:sharp
 *
 * @xenova/transformers declares sharp@^0.32 while the server uses sharp@^0.35. Without the
 * `overrides` block in package.json npm nests a second sharp (0.32.x) under
 * node_modules/@xenova/transformers/node_modules/. Both copies ship a DLL named libvips-42.dll;
 * Windows loads DLLs by name once per process, so whichever sharp loads first wins and the other
 * one fails with ERR_DLOPEN_FAILED "The specified procedure could not be found". In practice the
 * corpus/embedding tools load transformers (and its old sharp) first, and every sharp-backed
 * workshop-image tool then breaks for the life of that server process.
 *
 * This test loads transformers BEFORE sharp - the order that used to fail - and asserts that sharp
 * still loads and renders, and that the tree really is deduped.
 */
const fs = require("fs");
const path = require("path");

const serverDir = path.resolve(__dirname, "..");
const nodeModules = path.join(serverDir, "node_modules");
const failures = [];
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures.push(msg); };

(async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(serverDir, "package.json"), "utf8"));
    check(pkg.overrides?.["@xenova/transformers"]?.sharp === "$sharp",
        "package.json overrides @xenova/transformers -> sharp to the top-level copy");

    const nested = path.join(nodeModules, "@xenova", "transformers", "node_modules", "sharp");
    check(!fs.existsSync(nested), `no nested sharp at ${path.relative(serverDir, nested)}`);

    const topSharp = require.resolve("sharp", { paths: [serverDir] });
    const fromTransformers = require.resolve("sharp", { paths: [path.join(nodeModules, "@xenova", "transformers")] });
    check(topSharp === fromTransformers, "sharp resolves to the same file from transformers and from the server");

    // Load order that used to break: transformers (and whatever sharp it sees) first, then sharp.
    const transformers = await import("@xenova/transformers");
    let sharp;
    try {
        sharp = require("sharp");
        check(true, `sharp ${sharp.versions.sharp} (libvips ${sharp.versions.vips}) loads after transformers`);
    } catch (err) {
        check(false, `sharp loads after transformers: ${err.message.split("\n")[0]}`);
    }

    if (sharp) {
        const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#ff0000" } }).png().toBuffer();
        check(png.length > 0, "sharp renders a PNG");
        const img = await transformers.RawImage.fromBlob(new Blob([png], { type: "image/png" }));
        check(img.width === 4 && img.height === 4, "transformers decodes an image through the shared sharp");
    }

    if (failures.length) {
        console.error(`\n${failures.length} failure(s)`);
        process.exit(1);
    }
    console.log("\nall sharp dedupe checks passed");
})().catch(err => { console.error(err); process.exit(1); });
