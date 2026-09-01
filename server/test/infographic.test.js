/*
 * End-to-end exercise of the infographic family.
 *
 *   cd server && npm run build && npm run test:infographic
 *
 * Runs the real handlers from build/tools/infographic.js:
 *   - render_html_to_image against a fixture that trips every render gotcha at once: UTF-8
 *     symbols (mojibake canary), a DOM built entirely by <script> (virtual-time canary), a
 *     Google Font, and light/dark theme tokens (theme-forcing canary, asserted by pixel
 *     brightness). Skipped politely when no Chrome/Edge is installed.
 *   - compose_infographic template output (tokens + data present).
 *   - publish_infographic against two temp git "edition" repos with local bare remotes:
 *     dry-run stages without writing, real run commits+pushes, re-run is a no-op, and the
 *     steam target in dry-run writes handoff BBCode without touching imgur or Chrome.
 *
 * NOT covered (needs real services): imgur upload, the live CDP Steam description update.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "infographic-e2e-"));
process.env.LOCALAPPDATA = scratch; // outputs + handoff files land here, never in the real profile

const { handleInfographicTool } = require("../build/tools/infographic");

let passed = 0;
function ok(cond, msg) {
    if (cond) { passed++; console.log("  ok -", msg); }
    else { console.error("  FAIL -", msg); process.exitCode = 1; }
}
async function call(name, args) {
    const res = await handleInfographicTool(name, args);
    const text = res.content[0].text;
    try { return JSON.parse(text); } catch { return { _raw: text }; }
}

const FIXTURE = `
<title>Fixture</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@700&display=swap">
<style>
  :root { --ground: #f2f2f2; --ink: #101010; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --ground: #101210; --ink: #e8e8e8; } }
  :root[data-theme="dark"] { --ground: #101210; --ink: #e8e8e8; }
  body { margin: 0; background: var(--ground); color: var(--ink); font-family: "Chakra Petch", sans-serif; }
  .row { padding: 6px 20px; }
</style>
<h1 class="row">Symbols: → ✓ · ○ ◐</h1>
<div id="mount"></div>
<script>
  // DOM built by script: without a virtual-time budget this content never gets captured.
  const m = document.getElementById("mount");
  for (let i = 0; i < 30; i++) {
    const d = document.createElement("div");
    d.className = "row";
    d.textContent = "js row " + i + " → built at runtime ✓";
    m.appendChild(d);
  }
</script>`;

async function avgBrightness(png) {
    const { sharp } = require("../build/tools/pc/native");
    const stats = await sharp()(png).stats();
    const ch = stats.channels;
    return (ch[0].mean + ch[1].mean + ch[2].mean) / 3;
}

function git(repo, ...argv) {
    return execFileSync("git", ["-C", repo, ...argv], { encoding: "utf8" });
}

function makeEditionRepo(name, workshopId) {
    const repo = path.join(scratch, name);
    const bare = path.join(scratch, name + ".git");
    fs.mkdirSync(path.join(repo, "About"), { recursive: true });
    execFileSync("git", ["init", "-b", "main", repo], { encoding: "utf8" });
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Infographic Test");
    fs.writeFileSync(path.join(repo, "About", "PublishedFileId.txt"), workshopId + "\n");
    fs.writeFileSync(path.join(repo, "README.md"), `# ${name}\n\nHand-written intro that must survive.\n`);
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "initial");
    execFileSync("git", ["init", "--bare", bare], { encoding: "utf8" });
    git(repo, "remote", "add", "origin", bare);
    git(repo, "push", "-u", "origin", "main");
    return { repo, bare };
}

(async () => {
    // ---------------- render_html_to_image ----------------
    console.log("render_html_to_image:");
    const probe = await call("render_html_to_image", { html_string: FIXTURE, width: 700, name: "fixture-dark" });
    if (probe._raw && /No headless-capable browser/.test(probe._raw)) {
        console.log("  SKIP - no Chrome/Edge on this machine; render assertions skipped.");
    } else {
        ok(probe.ok === true, "render succeeded: " + (probe.path || probe._raw));
        ok(probe.width === 1400, `output is width x scale (1400px, got ${probe.width})`);
        ok(probe.cssWidth === 700, "css width preserved");
        ok(probe.bytes > 20000, `PNG is non-trivial (${probe.bytes} bytes)`);
        // 31 rows of content: measured height must cover the JS-built DOM but stay tight.
        ok(probe.cssHeight > 500 && probe.cssHeight < 2500, `height measured from content (${probe.cssHeight}px css)`);
        ok(probe.height === probe.cssHeight * 2, "pixel height = cssHeight x scale");

        const dark = await avgBrightness(probe.path);
        const light = await call("render_html_to_image", { html_string: FIXTURE, width: 700, theme: "light", name: "fixture-light" });
        const lightB = await avgBrightness(light.path);
        ok(dark < 90, `theme 'dark' forced (mean brightness ${dark.toFixed(0)})`);
        ok(lightB > 170, `theme 'light' forced (mean brightness ${lightB.toFixed(0)})`);
        ok(lightB - dark > 80, "themes render distinctly");

        const fixed = await call("render_html_to_image", { html_string: FIXTURE, width: 400, height: 300, scale: 1, theme: "light", name: "fixture-fixed" });
        ok(fixed.width === 400 && fixed.height === 300, "explicit height + scale 1 respected");

        // Regression: content SHORTER than the measure viewport must not be floored to it
        // (quirks-mode body stretch + headless window chrome used to inflate this to ~905px).
        const short = await call("render_html_to_image", {
            html_string: '<meta charset="utf-8"><body style="margin:0"><div style="height:120px">short</div>',
            width: 500, scale: 1, theme: "none", name: "fixture-short"
        });
        ok(short.cssHeight >= 120 && short.cssHeight < 200, `short page measured tight (${short.cssHeight}px, not viewport-floored)`);
    }

    // ---------------- compose_infographic ----------------
    console.log("compose_infographic:");
    const composed = await call("compose_infographic", {
        template: "roadmap", title: "Test Roadmap", eyebrow: "TEST — ROADMAP",
        items: [
            { label: "v1.0", title: "Shipped thing", status: "done", bullets: ["a", "b"] },
            { label: "v1.1", title: "Current thing", status: "active", body: "In flight." },
            { title: "Future thing <script>" }
        ]
    });
    ok(composed.ok === true, "roadmap composed: " + composed.path);
    const html = fs.readFileSync(composed.path, "utf8");
    ok(html.includes("Chakra+Petch"), "house fonts referenced");
    ok(html.includes('--brass') && html.includes('[data-theme="dark"]'), "theme tokens present (light+dark)");
    ok(html.includes("Shipped thing") && html.includes("v1.1"), "data rendered");
    ok(!html.includes("<script>Future") && html.includes("&lt;script&gt;"), "user data is HTML-escaped");
    const badTemplate = await call("compose_infographic", { template: "nope", title: "x" });
    ok(/must be one of/.test(badTemplate._raw || ""), "unknown template rejected");

    const ftl = await call("compose_infographic", {
        template: "timeline", title: "Feature Timeline",
        items: [
            { heading: "2025" },
            { label: "v1.0", title: "First feature", status: "done", desc: "one-liner" },
            { heading: "2026" },
            { label: "v1.1", title: "Second feature", status: "active" }
        ]
    });
    ok(ftl.ok === true, "feature timeline composed: " + ftl.path);
    const ftlHtml = fs.readFileSync(ftl.path, "utf8");
    ok(ftlHtml.includes('class="ftl"') && ftlHtml.includes("First feature") && ftlHtml.includes("one-liner"), "timeline entries rendered");
    ok(ftlHtml.includes('class="era"') && ftlHtml.includes("2026"), "era headings rendered");

    // ---------------- publish_infographic ----------------
    console.log("publish_infographic:");
    const png = path.join(scratch, "codex.png");
    // A tiny valid PNG (1x1) is enough — publish only copies/hashes it.
    fs.writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
    const A = makeEditionRepo("Core-AAA", "111111");
    const B = makeEditionRepo("Core-BBB", "222222");
    const editions = [A.repo, B.repo];

    // Dry run: stages, writes nothing, commits nothing.
    const dry = await call("publish_infographic", {
        image: png, name: "codex", section_title: "Faction Codex", section_body: "All factions at a glance.",
        editions, dryRun: true
    });
    ok(dry.dryRun === true && dry.github.length === 2, "dry-run covers both editions");
    ok(dry.github.every(g => g.status === "planned"), "github publishes are planned, not executed");
    ok(/<!-- infographic:codex -->/.test(dry.github[0].plannedSection), "planned README section is marker-fenced");
    ok(!fs.existsSync(path.join(A.repo, "About", "codex.png")), "dry-run copied no image");
    ok(git(A.repo, "rev-list", "--count", "HEAD").trim() === "1", "dry-run committed nothing");
    ok(dry.steam.items.length === 2 && dry.steam.items.every(i => i.status === "planned"), "steam items staged");
    ok(/\[h1\]Faction Codex\[\/h1\]/.test(dry.steam.bbcode) && /\[img\]/.test(dry.steam.bbcode), "BBCode block composed");
    const handoff = fs.readFileSync(dry.steam.items.find(i => i.workshopId === "111111").handoff, "utf8");
    ok(/DRY RUN/.test(handoff) && /itemedittext\/\?id=111111/.test(handoff), "handoff file names the item + flags the dry run");

    // Real run, github only (steam needs imgur/Chrome).
    const real = await call("publish_infographic", {
        image: png, name: "codex", section_title: "Faction Codex", section_body: "All factions at a glance.",
        editions, targets: ["github"]
    });
    ok(real.github.every(g => g.status === "published" && g.committed && g.pushed), "both editions committed + pushed");
    const readme = fs.readFileSync(path.join(A.repo, "README.md"), "utf8");
    ok(readme.includes("Hand-written intro that must survive."), "unrelated README content untouched");
    ok(readme.includes("<!-- infographic:codex -->") && readme.includes("![Faction Codex](About/codex.png)"), "section written with marker + image ref");
    ok(fs.existsSync(path.join(A.repo, "About", "codex.png")), "image landed at About/codex.png");
    ok(git(A.repo, "rev-list", "--count", "HEAD").trim() === "2", "exactly one publish commit");
    ok(execFileSync("git", ["-C", A.bare, "rev-list", "--count", "main"], { encoding: "utf8" }).trim() === "2", "pushed to the remote");

    // Idempotence: identical re-run changes nothing.
    const again = await call("publish_infographic", {
        image: png, name: "codex", section_title: "Faction Codex", section_body: "All factions at a glance.",
        editions, targets: ["github"]
    });
    ok(again.github.every(g => g.status === "up-to-date"), "re-run is a no-op");
    ok(git(A.repo, "rev-list", "--count", "HEAD").trim() === "2", "no duplicate commit");

    // Section refresh: changed body updates in place, no duplicate section.
    const refreshed = await call("publish_infographic", {
        image: png, name: "codex", section_title: "Faction Codex", section_body: "UPDATED body.",
        editions: [A.repo], targets: ["github"]
    });
    ok(refreshed.github[0].status === "published", "changed body republished");
    const readme2 = fs.readFileSync(path.join(A.repo, "README.md"), "utf8");
    ok(readme2.includes("UPDATED body.") && !readme2.includes("All factions at a glance."), "section refreshed in place");
    ok((readme2.match(/<!-- infographic:codex -->/g) || []).length === 1, "no duplicated section");

    console.log(`\n${passed} assertions passed${process.exitCode ? " (WITH FAILURES)" : ""}`);
})().catch(e => { console.error("test crashed:", e); process.exit(1); });
