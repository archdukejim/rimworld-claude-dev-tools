import { execFileSync } from "child_process";
import { Octokit } from "@octokit/rest";
import { writeGitHubTokenFile, githubTokenFilePath } from "../config";
import {
    KeyService, addKey, listKeys, deleteKey, setActive, getActiveKey, isExpired, maskSecret
} from "../keystore";

// Minimal MCP content helpers (kept local so this family stays independent of others).
function okText(obj: any) { return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] }; }
function errText(msg: string) { return { content: [{ type: "text" as const, text: msg }] }; }

const nowIso = () => new Date().toISOString();

export const authTools = [
    {
        name: "set_github_token",
        description:
            "Store a GitHub Personal Access Token (PAT) in the local keyring so the issue / project-board / codebase / " +
            "sync tools authenticate as YOU — not the gh CLI's keyring token, which lacks the `project` scope and makes " +
            "every org-board op fail. With no argument this opens a small window to paste your PAT into. Saved locally, " +
            "used immediately (no restart), never shown in chat or committed. Supports MULTIPLE PATs (e.g. one per org): " +
            "pass a `label` to name each; the newly-added key becomes active. GITHUB_TOKEN in the environment still takes " +
            "precedence if set. For org boards the PAT needs classic `repo`+`read:org`+`project`, or a fine-grained PAT " +
            "(authorized for the org) with Projects/Issues/Contents RW + Metadata R. Use list_keys / set_active_key / delete_key to manage them.",
        inputSchema: {
            type: "object",
            properties: {
                token: { type: "string", description: "Optional. If given, store this PAT directly instead of opening the paste window." },
                label: { type: "string", description: "Optional name for this key (e.g. 'rimsynapse-org', 'personal'). Defaults to 'default' / auto." },
                note: { type: "string", description: "Optional free-text note (what this key is for)." },
                expiresAt: { type: "string", description: "Optional ISO date (YYYY-MM-DD) the PAT expires, so list_keys can flag it." }
            }
        }
    },
    {
        name: "list_keys",
        description:
            "List the stored GitHub PATs, Anthropic API keys, and imgur credentials (values MASKED). Shows each key's " +
            "service, label, whether it's active, when it was added, any expiry you recorded, and an expired flag. Pass " +
            "verify:true to live-check each key against GitHub/Anthropic/imgur and report valid/invalid. Use this to find " +
            "expired or irrelevant keys, then delete_key them.",
        inputSchema: {
            type: "object",
            properties: {
                service: { type: "string", enum: ["github", "anthropic", "imgur"], description: "Optional. Limit to one service." },
                verify: { type: "boolean", description: "Live-check each key's validity (default false)." }
            }
        }
    },
    {
        name: "delete_key",
        description:
            "Delete a stored key by service + label (find labels with list_keys). If the deleted key was active, the first " +
            "remaining key of that service is promoted to active and applied to the running server. Use to remove expired or irrelevant keys.",
        inputSchema: {
            type: "object",
            properties: {
                service: { type: "string", enum: ["github", "anthropic", "imgur"], description: "Which service the key belongs to." },
                label: { type: "string", description: "The key's label (from list_keys)." }
            },
            required: ["service", "label"]
        }
    },
    {
        name: "set_active_key",
        description:
            "Choose which stored key is active for a service (e.g. switch between a RimSynapse-org PAT and a personal PAT, " +
            "or between two imgur accounts). The chosen key is applied to the running server immediately — no restart. " +
            "Find labels with list_keys.",
        inputSchema: {
            type: "object",
            properties: {
                service: { type: "string", enum: ["github", "anthropic", "imgur"], description: "Which service to switch." },
                label: { type: "string", description: "The key's label to make active (from list_keys)." }
            },
            required: ["service", "label"]
        }
    }
];

/**
 * @param applyToken callback from index.ts that swaps the running process's GitHub token + octokit,
 *                   so a freshly-set/switched PAT takes effect without a server restart.
 */
export async function handleAuthTool(name: string, args: any, applyToken: (t: string) => void) {
    if (name === "set_github_token") return await setGitHubToken(args, applyToken);
    if (name === "list_keys") return await listKeysTool(args);
    if (name === "delete_key") return deleteKeyTool(args, applyToken);
    if (name === "set_active_key") return setActiveKeyTool(args, applyToken);
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
    if (!/^(ghp_|github_pat_)/.test(token)) {
        return errText(`That doesn't look like a GitHub PAT — it should start with "ghp_" (classic) or "github_pat_" (fine-grained). Nothing was saved.`);
    }

    let entry;
    try {
        entry = addKey("github", token, { label: args.label, note: args.note, expiresAt: args.expiresAt, nowIso: nowIso() });
        // Keep the legacy github_token.txt in sync with the active key, for the documented file path + older readers.
        writeGitHubTokenFile(token);
    } catch (e: any) { return errText(`Failed to save the token: ${e?.message || e}`); }

    applyToken(token); // hot-swap the running client — no restart

    let verify: any = { checked: false };
    try {
        const who = await new Octokit({ auth: token }).rest.users.getAuthenticated();
        verify = { checked: true, ok: true, login: who.data.login, tokenType: token.startsWith("github_pat_") ? "fine-grained" : "classic" };
    } catch (e: any) {
        verify = { checked: true, ok: false, error: e?.message || String(e), note: "Token saved, but GitHub rejected it — check it's valid and (for fine-grained) authorized for the org." };
    }

    const envShadow = (process.env.GITHUB_TOKEN && process.env.GITHUB_TOKEN.trim())
        ? "WARNING: GITHUB_TOKEN is set in the environment and takes precedence over stored keys on the next restart — unset it so the keyring is used."
        : undefined;

    return okText({
        ok: true, source, service: "github", label: entry.label, active: true,
        token: maskSecret(token), verify,
        note: "Stored in the keyring and applied to the running server — no restart needed.",
        ...(envShadow ? { envShadow } : {})
    });
}

async function listKeysTool(args: any) {
    const services: KeyService[] = args.service ? [args.service] : ["github", "anthropic", "imgur"];
    const verify = !!args.verify;
    const now = nowIso();
    const out: any = {};
    for (const svc of services) {
        const entries = listKeys(svc);
        out[svc] = await Promise.all(entries.map(async e => {
            const row: any = {
                label: e.label, active: e.active, masked: maskSecret(e.value),
                addedAt: e.addedAt, expiresAt: e.expiresAt ?? null, expired: isExpired(e, now),
                note: e.note ?? null
            };
            // imgur stores a JSON credential blob, not a bare secret — summarise it instead of
            // masking the raw JSON (which would leak field names and part of the client id).
            if (svc === "imgur") Object.assign(row, describeImgur(e.value));
            if (verify) row.valid = await verifyKey(svc, e.value);
            return row;
        }));
        if (!entries.length) out[svc] = [];
    }
    out.keystoreNote = "Values are masked. Active key is the one the tools use. GITHUB_TOKEN / ANTHROPIC_API_KEY env vars, if set, still override the keyring.";
    return okText(out);
}

function deleteKeyTool(args: any, applyToken: (t: string) => void) {
    const service = args.service as KeyService;
    const label = String(args.label || "");
    const removed = deleteKey(service, label);
    if (!removed) return errText(`No ${service} key labelled "${label}". Run list_keys to see labels.`);
    if (service === "github") applyToken(getActiveKey("github") || ""); // promote/clear active on the running server
    return okText({ ok: true, deleted: { service, label }, newActive: activeLabel(service), note: "Deleted. Active key re-applied to the running server." });
}

function setActiveKeyTool(args: any, applyToken: (t: string) => void) {
    const service = args.service as KeyService;
    const label = String(args.label || "");
    const ok = setActive(service, label);
    if (!ok) return errText(`No ${service} key labelled "${label}". Run list_keys to see labels.`);
    if (service === "github") applyToken(getActiveKey("github") || "");
    return okText({ ok: true, active: { service, label }, note: "Active key switched and applied to the running server — no restart." });
}

function activeLabel(service: KeyService): string | null {
    return listKeys(service).find(e => e.active)?.label ?? null;
}

async function verifyKey(service: KeyService, value: string): Promise<boolean> {
    try {
        if (service === "github") { await new Octokit({ auth: value }).rest.users.getAuthenticated(); return true; }
        if (service === "imgur") {
            // Cheap validity ping: /3/credits accepts either auth mode and costs nothing.
            const c = JSON.parse(value);
            const header = c.accessToken ? `Bearer ${c.accessToken}` : `Client-ID ${c.clientId}`;
            const res = await fetch("https://api.imgur.com/3/credits", { headers: { Authorization: header } });
            return res.ok;
        }
        // anthropic: cheap validity ping via a tiny models list call
        const Anthropic = require("@anthropic-ai/sdk");
        const Ctor = Anthropic.default || Anthropic;
        await new Ctor({ apiKey: value }).models.list({ limit: 1 });
        return true;
    } catch { return false; }
}

/** Summarise an imgur credential blob for list_keys: identity + mode, never the tokens. */
function describeImgur(value: string): Record<string, unknown> {
    try {
        const c = JSON.parse(value);
        return {
            masked: maskSecret(String(c.clientId || "")),
            account: c.accountUsername ?? null,
            mode: c.refreshToken ? "account" : "anonymous",
            tokenExpiresAt: c.expiresAt ?? null
        };
    } catch {
        return { masked: "(unparseable imgur credential blob)", mode: "unknown" };
    }
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
