#!/usr/bin/env node
/**
 * PreToolUse(Bash) hook — protected-branch guard.
 *
 * Hard-blocks (exit 2) any `git commit` / `git merge` / `git rebase` / `git push` that would land on a
 * PROTECTED branch (main, master, development). main is release-only; development is integration-only.
 * All real work happens on an agent/<id> branch in a per-session worktree (see session-worktree.cjs),
 * then merges into development via PR. Anything not touching a protected branch is allowed through.
 *
 * exit 0 = allow · exit 2 = block (stderr is shown to the model as the reason).
 */
const { execSync } = require("child_process");
const fs = require("fs");

let input = {};
try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { process.exit(0); }

const cmd = String((input.tool_input && input.tool_input.command) || "");
if (!cmd || !/\bgit\b/.test(cmd)) process.exit(0);

const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const PROTECTED = ["main", "master", "development"];

function sh(c) { try { return execSync(c, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; } }

// Resolve the directory the command targets: `git -C <dir>`, or a leading `cd <dir> &&`, else the project dir.
function firstArg(re) { const m = cmd.match(re); return m ? (m[2] || m[3] || m[4]) : null; }
const dir =
    firstArg(/git\s+-C\s+("([^"]+)"|'([^']+)'|(\S+))/) ||
    firstArg(/^\s*cd\s+("([^"]+)"|'([^']+)'|(\S+))\s*(?:&&|;)/) ||
    projectDir;

const branch = sh(`git -C "${dir}" rev-parse --abbrev-ref HEAD`);

const isCommit = /git\s+(?:-C\s+\S+\s+)?commit\b/.test(cmd);
const isMergeLike = /git\s+(?:-C\s+\S+\s+)?(?:merge|rebase)\b/.test(cmd);
const isPush = /git\s+(?:-C\s+\S+\s+)?push\b/.test(cmd);
const pushTargetsProtected = isPush && PROTECTED.some(b =>
    new RegExp(`(?:\\borigin\\s+(?:HEAD:)?${b}\\b|:${b}\\b|\\s${b}\\s*$)`).test(cmd));

function deny(reason) { process.stderr.write(reason + "\n"); process.exit(2); }

if ((isCommit || isMergeLike) && PROTECTED.includes(branch)) {
    deny(
        `🚫 Blocked: '${branch}' is a PROTECTED branch — never commit/merge/rebase onto it directly.\n` +
        `Work in your session worktree (run: git worktree list) on your agent/<id> branch, then open a PR into development.\n` +
        `Rejected command: ${cmd}`
    );
}
if (isPush && (PROTECTED.includes(branch) || pushTargetsProtected)) {
    deny(
        `🚫 Blocked: pushing to a PROTECTED branch (main/development).\n` +
        `Push your agent/<id> branch and open a PR into development. main is release-only (PR from development).\n` +
        `Rejected command: ${cmd}`
    );
}
process.exit(0);
