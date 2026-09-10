#!/usr/bin/env node
/**
 * PreToolUse(Bash) hook — protected-branch guard.
 *
 * Hard-blocks (exit 2) git operations that would land on / overwrite a PROTECTED branch
 * (main, master, development). main is release-only; development is integration-only. Real work
 * happens on an agent/<id> branch in a per-session worktree, then merges into development via PR.
 *
 * Precise by design — it must NOT block legitimate work done while merely standing on a protected
 * branch (e.g. deleting a merged feature branch, or pushing some other branch):
 *   - commit / merge / rebase: blocked only when the CURRENT branch is protected.
 *   - push: blocked only when it (a) explicitly targets a protected branch, (b) pushes all refs
 *     (--all/--mirror), or (c) is a "bare" push (no explicit refspec) while on a protected branch,
 *     which would push that branch. `git push origin --delete <feature>` or `git push origin <feature>`
 *     from main are ALLOWED.
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

// windowsHide: the hook runs consoleless, so without it the git child would flash a window per Bash call.
function sh(c) { try { return execSync(c, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim(); } catch { return ""; } }

// Resolve the directory the command targets: `git -C <dir>`, or a leading `cd <dir> &&`, else the project dir.
function firstArg(re) { const m = cmd.match(re); return m ? (m[2] || m[3] || m[4]) : null; }
const dir =
    firstArg(/git\s+-C\s+("([^"]+)"|'([^']+)'|(\S+))/) ||
    firstArg(/^\s*cd\s+("([^"]+)"|'([^']+)'|(\S+))\s*(?:&&|;)/) ||
    projectDir;

const branch = sh(`git -C "${dir}" rev-parse --abbrev-ref HEAD`);
const onProtected = PROTECTED.includes(branch);

const isCommit = /git\s+(?:-C\s+\S+\s+)?commit\b/.test(cmd);
const isMergeLike = /git\s+(?:-C\s+\S+\s+)?(?:merge|rebase)\b/.test(cmd);
const isPush = /git\s+(?:-C\s+\S+\s+)?push\b/.test(cmd);

function deny(reason) { process.stderr.write(reason + "\n"); process.exit(2); }

if ((isCommit || isMergeLike) && onProtected) {
    deny(
        `🚫 Blocked: '${branch}' is a PROTECTED branch — never commit/merge/rebase onto it directly.\n` +
        `Work in your session worktree (run: git worktree list) on your agent/<id> branch, then open a PR into development.\n` +
        `Rejected command: ${cmd}`
    );
}

if (isPush) {
    const afterPush = (cmd.match(/\bpush\b\s+([^\n]*)$/) || [, ""])[1].trim();
    const pushesAllRefs = /(?:^|\s)(--all|--mirror)\b/.test(afterPush);
    // Explicit protected target: `origin main`, `main`, `HEAD:main`, `feat:main`, `--delete main`.
    const targetsProtected = PROTECTED.some(b => new RegExp(`(?::${b}\\b|(?:^|\\s)${b}(?:\\s|$))`).test(afterPush));
    // Any explicit refspec at all? (a 2nd non-flag token after the remote, a ref:ref spec, or a delete)
    const nonFlags = afterPush.split(/\s+/).filter(t => t && !t.startsWith("-"));
    const hasExplicitRef = nonFlags.length >= 2 || /:/.test(afterPush) || /(?:^|\s)(--delete|-d)\b/.test(afterPush);

    let reason = null;
    if (pushesAllRefs) reason = "pushes all refs (--all/--mirror), which includes protected branches";
    else if (targetsProtected) reason = "explicitly targets a protected branch";
    else if (!hasExplicitRef && onProtected) reason = `is a bare push while on protected branch '${branch}', which would push it`;

    if (reason) {
        deny(
            `🚫 Blocked: this push ${reason}.\n` +
            `Push your agent/<id> branch and open a PR into development. main is release-only (PR from development).\n` +
            `(Pushing or deleting a NON-protected branch — e.g. \`git push origin --delete <feature>\` — is allowed.)\n` +
            `Rejected command: ${cmd}`
        );
    }
}
process.exit(0);
