#!/usr/bin/env node
/**
 * Watch Harmony (and RimWorld) versions; on a CHANGE, record a diff and rebuild the Harmony RAG
 * corpus. Deterministic and self-contained (no LLM, no MCP) so it runs unattended from a scheduled
 * task.
 *
 * Change-triggered, not unconditional: it compares against a stored baseline (.refresh-state.json)
 * and does nothing on a quiet run. On the FIRST run it seeds the baseline (rebuild, no diff file).
 *
 *   - Harmony: fetches the GitHub releases API. New release(s) -> rewrite the SEPARATE auto file
 *     (harmony-releases.auto.jsonl; the curated harmony-corpus.jsonl is never touched) and rebuild.
 *   - RimWorld: reads the installed game's Version.txt. A game-version change is recorded too, with a
 *     reminder to re-run the in-game dump_game_api + build_api_index (that corpus can't be rebuilt
 *     headlessly).
 *
 * On any change it writes HARMONY-UPDATE.md (the diff to review) and logs it — no desktop popup.
 * Safe on failure: a failed fetch leaves everything untouched.
 *
 * Run manually:  node harmony-knowledge/refresh-harmony-releases.cjs
 */
const fs = require("fs");
const path = require("path");

const RELEASES_URL = "https://api.github.com/repos/pardeike/Harmony/releases";
const MAX_RELEASES = 12;
const BODY_CHARS = 320;

const DIR = __dirname;
const AUTO_FILE = path.join(DIR, "harmony-releases.auto.jsonl");
const STATE_FILE = path.join(DIR, ".refresh-state.json");
const UPDATE_FILE = path.join(DIR, "HARMONY-UPDATE.md");
const LOG = path.join(DIR, ".refresh.log");
const HARMONY_TOOL = path.resolve(DIR, "..", "server", "build", "tools", "harmony.js");
const RIMWORLD_VERSION_TXT =
    process.env.RIMWORLD_VERSION_TXT ||
    "C:\\Program Files (x86)\\Steam\\steamapps\\common\\RimWorld\\Version.txt";

function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    try { fs.appendFileSync(LOG, line + "\n"); } catch { /* best effort */ }
}

function flattenBody(body) {
    return String(body || "")
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[#>*_`~-]+/g, " ")
        .replace(/\r?\n+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
function sanitizeTag(tag) { return String(tag).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase(); }

function readState() {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return null; }
}
function writeState(s) {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch (e) { log(`WARN: could not write state: ${e.message || e}`); }
}

function readRimworldVersion() {
    try { return fs.readFileSync(RIMWORLD_VERSION_TXT, "utf8").split(/\r?\n/)[0].trim() || null; }
    catch { return null; }
}

function releaseToRecord(rel) {
    const tag = rel.tag_name || rel.name || "unknown";
    const date = (rel.published_at || "").slice(0, 10);
    const name = (rel.name && rel.name !== tag) ? `${rel.name}. ` : "";
    let body = flattenBody(rel.body);
    if (body.length > BODY_CHARS) body = body.slice(0, BODY_CHARS).replace(/\s+\S*$/, "") + "…";
    return {
        id: `rel-auto-${sanitizeTag(tag)}`,
        kind: "release",
        category: "release-notes",
        title: `Harmony ${tag}${date ? ` (${date})` : ""}`,
        text: `Harmony ${tag}${date ? ` released ${date}` : ""}: ${name}${body}`.trim(),
        related: ["rel-source"]
    };
}

function writeUpdateFile(sections, newest) {
    const md =
`# Harmony / RimWorld version update

Detected ${new Date().toISOString()} by refresh-harmony-releases.cjs.

${sections.join("\n\n")}

---
Latest Harmony release: **${newest}**.
Review the changes above, then (if you want to curate) edit \`harmony-corpus.jsonl\` and run \`rebuild_harmony_corpus\`.
The auto release records in \`harmony-releases.auto.jsonl\` were already refreshed and the corpus rebuilt.
`;
    try { fs.writeFileSync(UPDATE_FILE, md); log(`Wrote diff to ${UPDATE_FILE}`); }
    catch (e) { log(`WARN: could not write update file: ${e.message || e}`); }
}

async function rebuildCorpus() {
    const { handleHarmonyTool } = require(HARMONY_TOOL);
    const res = await handleHarmonyTool("rebuild_harmony_corpus", {});
    return JSON.parse(res.content[0].text);
}

async function main() {
    // --- Fetch Harmony releases (fatal on failure; nothing is changed) ---
    let releases;
    try {
        const res = await fetch(RELEASES_URL, {
            headers: { "Accept": "application/vnd.github+json", "User-Agent": "rimagentic-harmony-refresh" }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        releases = await res.json();
    } catch (e) {
        log(`Fetch failed (${e.message || e}); nothing changed.`);
        process.exit(1);
    }
    if (!Array.isArray(releases) || releases.length === 0) { log("No releases returned; nothing changed."); process.exit(1); }

    const allTags = releases.map(r => r.tag_name || r.name).filter(Boolean);
    const latestTag = allTags[0];
    const rimworldVersion = readRimworldVersion();

    const prior = readState();
    const baseline = !prior;

    const knownTags = new Set(prior?.harmonyKnownTags || []);
    const newTags = baseline ? [] : allTags.filter(t => !knownTags.has(t));
    const harmonyChanged = baseline || newTags.length > 0 || latestTag !== prior?.harmonyLatest;
    const rimworldChanged = !baseline && rimworldVersion && rimworldVersion !== prior?.rimworldVersion;

    const nextState = {
        harmonyLatest: latestTag,
        harmonyKnownTags: allTags,
        rimworldVersion: rimworldVersion || prior?.rimworldVersion || null,
        updatedAt: new Date().toISOString()
    };

    if (!baseline && !harmonyChanged && !rimworldChanged) {
        writeState(nextState);
        log(`No change (Harmony ${latestTag}${rimworldVersion ? `, RimWorld ${rimworldVersion}` : ""}).`);
        return;
    }

    // --- Rewrite the auto release file when Harmony changed (or on baseline to populate it) ---
    if (harmonyChanged || !fs.existsSync(AUTO_FILE)) {
        const autoRecords = [
            {
                id: "rel-auto-current", kind: "release", category: "release-notes",
                title: "Harmony latest release (auto-updated)",
                text: `The current latest Harmony release is ${latestTag}${releases[0].published_at ? `, published ${releases[0].published_at.slice(0, 10)}` : ""}. Auto-refreshed from the GitHub releases API; see the rel-auto-* records for per-version notes.`,
                related: ["rel-source"]
            },
            ...releases.slice(0, MAX_RELEASES).map(releaseToRecord)
        ];
        fs.writeFileSync(AUTO_FILE, autoRecords.map(r => JSON.stringify(r)).join("\n") + "\n");
        log(`Wrote ${autoRecords.length} auto release records (latest ${latestTag}).`);

        try {
            const s = await rebuildCorpus();
            log(`Rebuilt corpus: ${s.records} records, indexed=${s.indexed}, graphed=${s.graphed}.`);
        } catch (e) {
            log(`Auto file written but rebuild failed (${e.message || e}); it will rebuild on next server use.`);
        }
    }

    writeState(nextState);

    // --- Baseline run: establish state quietly, no diff file ---
    if (baseline) { log(`Baseline established (Harmony ${latestTag}${rimworldVersion ? `, RimWorld ${rimworldVersion}` : ""}). First run — no diff written.`); return; }

    // --- A real change: build the diff and write it (no popup; the file + log are the record) ---
    const sections = [];
    if (harmonyChanged) {
        const bullets = newTags.length
            ? newTags.map(t => `- ${t}`).join("\n")
            : `- latest is now ${latestTag} (was ${prior.harmonyLatest || "unknown"})`;
        sections.push(`## Harmony\nNew release(s) since ${prior.harmonyLatest || "baseline"}:\n${bullets}`);
    }
    if (rimworldChanged) {
        sections.push(`## RimWorld\nGame version changed: ${prior.rimworldVersion || "unknown"} -> ${rimworldVersion}.\nThe C# API corpus is version-specific — re-run the in-game \`dump_game_api\`, then \`build_api_index\` and \`build_api_graph\`, to refresh search_game_api for the new version.`);
    }
    writeUpdateFile(sections, latestTag);

    const parts = [];
    if (harmonyChanged) parts.push(newTags.length ? `Harmony ${newTags.join(", ")}` : `Harmony ${latestTag}`);
    if (rimworldChanged) parts.push(`RimWorld ${rimworldVersion}`);
    log(`CHANGE: ${parts.join(" · ")} — see HARMONY-UPDATE.md; corpus rebuilt.`);
}

main().catch(e => { log(`Unexpected error: ${e.stack || e}`); process.exit(1); });
