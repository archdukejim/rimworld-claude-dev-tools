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
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
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
        // core.longpaths=true: this repo tracks deep node_modules paths that can exceed Windows'
        // 260-char MAX_PATH in a nested worktree location; without it `worktree add` fails mid-checkout.
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

emit(
`ISOLATION (mandatory) — this session has its own git worktree:
  • Worktree:  ${wtPath}
  • Branch:    ${branch}   (based on ${base}; ${status})
  • DO ALL WORK HERE. cd into the worktree first; use absolute paths under it for Edit/Write.
  • 'main' is PROTECTED and 'development' is integration-only — NEVER commit/push directly to either (a hook will block it).
  • See other sessions' worktrees:   git worktree list        (their branches are agent/<id>)
  • Pull a finished subtask into yours:   git -C "${wtPath}" merge agent/<other-id>
  • Land your work:  push ${branch}, then open a PR INTO development (never into main directly).
  • Full workflow + recipes: docs/AGENT-WORKTREES.md`
);
process.exit(0);
