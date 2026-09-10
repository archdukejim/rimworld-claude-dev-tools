#!/usr/bin/env node
/**
 * SessionStart hook — per-session git worktree isolation.
 *
 * Every Claude session (and every FORK of a conversation, since a fork gets a fresh session id)
 * gets its OWN git worktree on its OWN branch (agent/<id>) based on `development`. Concurrent or
 * forked agents therefore never share a working tree or a branch, which makes the "two agents
 * stomping the same checkout" class of hazard impossible.
 *
 * This hook only PREPARES the worktree and tells the agent where it is (via additionalContext);
 * it cannot change the running session's cwd. The agent must cd into the worktree to work there.
 * It never blocks session start — any failure degrades to "work in the shared checkout" with a warning.
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function sh(cmd) {
    // windowsHide: the hook runs consoleless, so without it every git child would flash a window.
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
}
function ok(fn, dflt) { try { return fn(); } catch { return dflt; } }
function refExists(repo, ref) { return ok(() => { sh(`git -C "${repo}" rev-parse --verify --quiet ${ref}`); return true; }, false); }

function emit(text) {
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text }
    }));
}

let input = {};
try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { /* no stdin */ }

const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
if (ok(() => sh(`git -C "${projectDir}" rev-parse --is-inside-work-tree`), "") !== "true") process.exit(0);

const repoRoot = ok(() => sh(`git -C "${projectDir}" rev-parse --show-toplevel`), projectDir);
const repoName = path.basename(repoRoot);

const sessionId = String(input.session_id || input.sessionId || "").replace(/[^a-fA-F0-9]/g, "");
const shortId = (sessionId || "").slice(0, 8) || "nosess";

const wtRoot = process.env.CLAUDE_WORKTREE_ROOT || path.join(path.dirname(repoRoot), "worktrees", repoName);
const wtPath = path.join(wtRoot, shortId);
const branch = `agent/${shortId}`;

ok(() => sh(`git -C "${repoRoot}" fetch origin --quiet`));
const base =
    refExists(repoRoot, "refs/heads/development") ? "development" :
    refExists(repoRoot, "refs/remotes/origin/development") ? "origin/development" :
    refExists(repoRoot, "refs/heads/main") ? "main" : "origin/main";

let status = "reused";
if (!fs.existsSync(wtPath)) {
    try {
        fs.mkdirSync(wtRoot, { recursive: true });
        // core.longpaths=true is a harmless belt-and-braces for deep paths on Windows.
        const g = `git -c core.longpaths=true -C "${repoRoot}"`;
        if (refExists(repoRoot, `refs/heads/${branch}`)) {
            sh(`${g} worktree add "${wtPath}" ${branch}`);
        } else {
            sh(`${g} worktree add -b ${branch} "${wtPath}" ${base}`);
        }
        status = "created";
    } catch (e) {
        emit(
            `⚠️ ISOLATION: could not create a worktree (${String((e && e.message) || e).split("\n")[0]}). ` +
            `Working in the SHARED checkout ${repoRoot} — coordinate to avoid clobbering other agents. ` +
            `Create one manually: git worktree add -b ${branch} "${wtPath}" ${base}`
        );
        process.exit(0);
    }
}

/* server/node_modules is untracked (it used to be committed — that made every worktree add
 * check out ~8k dependency files and every session start crawl). Fresh worktrees get a
 * Windows JUNCTION to the main checkout's node_modules instead: instant, and deps are
 * already installed. The junction is shared by every session, so npm installs must run
 * ONLY in the main checkout — worktrees treat node_modules as read-only. */
let depsNote = "";
const wtDeps = path.join(wtPath, "server", "node_modules");
const mainDeps = path.join(repoRoot, "server", "node_modules");
if (!fs.existsSync(wtDeps)) {
    if (fs.existsSync(mainDeps)) {
        try { fs.symlinkSync(mainDeps, wtDeps, "junction"); }
        catch { depsNote = `\n  • server/node_modules: junction failed — run npm ci in ${wtPath}\\server before building.`; }
    } else {
        depsNote = `\n  • server/node_modules: main checkout has none — run npm install ONCE in ${repoRoot}\\server (the shared junction target), then re-launch or junction it into this worktree.`;
    }
}

/* Garbage-collect abandoned session worktrees so they can't pile up again. Detached and
 * best-effort: a GC failure must never slow or block session start. The GC itself only
 * removes worktrees that are >7 days idle, clean, and fully merged (see gc-worktrees.cjs). */
try {
    const { spawn } = require("child_process");
    const gc = path.join(repoRoot, ".claude", "hooks", "gc-worktrees.cjs");
    if (fs.existsSync(gc)) {
        spawn(process.execPath, [gc, "--exclude", wtPath], {
            cwd: repoRoot, detached: true, stdio: "ignore", windowsHide: true
        }).unref();
    }
} catch { /* GC is optional */ }

emit(
`ISOLATION (mandatory) — this session has its own git worktree:
  • Worktree:  ${wtPath}
  • Branch:    ${branch}   (based on ${base}; ${status})
  • DO ALL WORK HERE. cd into the worktree first; use absolute paths under it for Edit/Write.
  • 'main' is PROTECTED and 'development' is integration-only — NEVER commit/push directly to either (a hook will block it).
  • server/node_modules here is a JUNCTION to the main checkout's copy — treat it as read-only; npm install/ci runs ONLY in ${repoRoot}\\server.${depsNote}
  • See other sessions' worktrees:   git worktree list        (their branches are agent/<id>)
  • Pull a finished subtask into yours:   git -C "${wtPath}" merge agent/<other-id>
  • Land your work:  push ${branch}, then open a PR INTO development (never into main directly).
  • Full workflow + recipes: docs/AGENT-WORKTREES.md`
);
process.exit(0);
