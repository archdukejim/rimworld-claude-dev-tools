import { execFileSync } from "child_process";
import { Octokit } from "@octokit/rest";
import { writeGitHubTokenFile, githubTokenFilePath } from "../config";

// Minimal MCP content helpers (kept local so this family stays independent of others).
function okText(obj: any) { return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] }; }
function errText(msg: string) { return { content: [{ type: "text" as const, text: msg }] }; }

export const authTools = [
    {
        name: "set_github_token",
        description:
            "Store your GitHub Personal Access Token (PAT) locally so the issue / project-board / codebase / sync " +
            "tools authenticate as YOU — not the gh CLI's keyring token, which lacks the `project` scope and makes " +
            "every org-board op fail. With no argument this opens a small window to paste your PAT into. The token is " +
            "saved to github_token.txt (gitignored), used immediately (no restart), and never shown in chat or " +
            "committed. Pass token:\"github_pat_...\" to set it without the window — but that puts the token in the " +
            "chat transcript, so prefer the window. GITHUB_TOKEN in the environment still takes precedence if set. " +
            "For org project boards the PAT needs classic `repo` + `read:org` + `project` scopes, or a fine-grained " +
            "PAT (authorized for the org) with Projects: Read and write, Issues RW, Contents RW, Metadata R.",
        inputSchema: {
            type: "object",
            properties: {
                token: { type: "string", description: "Optional. If given, store this PAT directly instead of opening the paste window." }
            }
        }
    }
];

/**
 * @param applyToken callback from index.ts that swaps the running process's token + octokit client,
 *                   so a freshly-pasted PAT takes effect without a server restart.
 */
export async function handleAuthTool(name: string, args: any, applyToken: (t: string) => void) {
    if (name === "set_github_token") return await setGitHubToken(args, applyToken);
    throw new Error(`Unknown auth tool: ${name}`);
}

async function setGitHubToken(args: any, applyToken: (t: string) => void) {
    let token = args.token ? String(args.token).trim() : "";
    const source = token ? "argument" : "window";
    if (!token) {
        try { token = promptForTokenWindow(); }
        catch (e: any) {
            return errText(`Couldn't open the paste window: ${e?.message || e}. Pass token:"github_pat_..." instead, or set GITHUB_TOKEN in the server env.`);
        }
    }
    if (!token) return okText({ ok: false, note: "No token entered (window cancelled). Nothing was saved." });
    // Classic PATs start ghp_; fine-grained start github_pat_. Reject anything else (e.g. a gho_ CLI token) early.
    if (!/^(ghp_|github_pat_)/.test(token)) {
        return errText(`That doesn't look like a GitHub PAT — it should start with "ghp_" (classic) or "github_pat_" (fine-grained). Nothing was saved.`);
    }

    let saved: string;
    try { saved = writeGitHubTokenFile(token); }
    catch (e: any) { return errText(`Failed to save the token to ${githubTokenFilePath()}: ${e?.message || e}`); }

    // Hot-swap the running process's client so board/issue tools use the new PAT with no restart.
    applyToken(token);

    // Live-verify the token by resolving the authenticated user. Never fatal — the token is already saved.
    let verify: any = { checked: false };
    try {
        const who = await new Octokit({ auth: token }).rest.users.getAuthenticated();
        verify = { checked: true, ok: true, login: who.data.login, tokenType: token.startsWith("github_pat_") ? "fine-grained" : "classic" };
    } catch (e: any) {
        verify = { checked: true, ok: false, error: e?.message || String(e), note: "Token saved, but GitHub rejected it — check it's valid and (for fine-grained) authorized for the org." };
    }

    const masked = `${token.slice(0, 10)}…${token.slice(-4)}`;
    const envShadow = (process.env.GITHUB_TOKEN && process.env.GITHUB_TOKEN.trim())
        ? "WARNING: GITHUB_TOKEN is set in the environment and takes precedence over this file on the next restart — unset it so the pasted PAT is used."
        : undefined;

    return okText({
        ok: true,
        source,
        saved,
        token: masked,
        verify,
        note: "Stored and applied to the running server — issue/project/board/sync tools use it right away, no restart needed.",
        ...(envShadow ? { envShadow } : {})
    });
}

/** Show a Windows input box and return the pasted text (empty string if cancelled). */
function promptForTokenWindow(): string {
    const ps =
        "Add-Type -AssemblyName Microsoft.VisualBasic; " +
        "$k=[Microsoft.VisualBasic.Interaction]::InputBox(" +
        "'Paste your GitHub PAT (github.com -> Settings -> Developer settings -> Personal access tokens). " +
        "It is saved locally and never shown in chat.'," +
        "'RimAgentic - GitHub PAT',''); " +
        "[Console]::Out.Write($k)";
    const out = execFileSync("powershell", ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", ps], { encoding: "utf8" });
    return String(out).trim();
}
