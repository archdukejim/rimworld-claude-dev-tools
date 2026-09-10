import { execFileSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

/*
 * sync_repo_wiki — mirror a mod repo's Learning/*.md (the in-game Learning Helper pages) into
 * the repo's GitHub wiki. The wiki lives beside the repo in WHATEVER org the repo is in, so the
 * `<owner>/<name>` slug is derived from the mod checkout's own `origin` remote — never from a
 * configured organisation (that hardcode is what made every Regions-and-societies publish fall
 * back to a manual clone). `dryRun` clones, stages, and prints the diffstat without committing.
 */

export const syncTools = [
    {
        name: "sync_repo_wiki",
        description:
            "Publish a mod repo's Learning/*.md pages to its GitHub wiki (<owner>/<repo>.wiki.git, derived from the checkout's " +
            "`origin` remote — any org). Adds new pages, updates changed ones; pass prune:true to also delete wiki pages whose " +
            "source file is gone (orphans are reported either way). dryRun:true clones and stages but only prints the diffstat. " +
            "Clones over HTTPS with the configured GitHub token, falling back to SSH.",
        inputSchema: {
            type: "object",
            properties: {
                localRepoPath: { type: "string", description: "Absolute path to the local mod repository clone." },
                repoName: { type: "string", description: "Optional. Only used when the origin remote cannot be parsed (then `<org>/<repoName>` from config)." },
                sourceDir: { type: "string", description: "Folder inside the repo holding the wiki pages (default 'Learning')." },
                message: { type: "string", description: "Commit message for the wiki (default 'Sync wiki from Learning/ (+a ~u -r)')." },
                prune: { type: "boolean", description: "Delete wiki pages with no source file (default false; orphans are listed regardless)." },
                dryRun: { type: "boolean", description: "Stage and print the diffstat, commit and push nothing (default false)." }
            },
            required: ["localRepoPath"]
        }
    }
];

const okText = (obj: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] });

/** `git@github.com:Org/Repo.git` / `https://github.com/Org/Repo(.git)` -> `Org/Repo`. */
export function slugFromRemote(url: string): string | null {
    const m = String(url || "").trim().match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i);
    return m ? m[1] : null;
}

function git(args: string[], cwd: string, opts: { allowFail?: boolean } = {}): { ok: boolean; out: string } {
    try {
        const out = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
        return { ok: true, out: String(out) };
    } catch (e: any) {
        if (opts.allowFail) return { ok: false, out: String(e?.stderr || e?.stdout || e?.message || e) };
        throw new Error(String(e?.stderr || e?.message || e));
    }
}

const redact = (s: string, token: string) => token ? s.split(token).join("***") : s;

export async function handleSyncTool(name: string, args: any, org: string, token: string) {
    if (name !== "sync_repo_wiki") throw new Error(`Unknown sync tool: ${name}`);
    const a = args || {};
    const localRepoPath = String(a.localRepoPath || "");
    if (!localRepoPath || !fs.existsSync(localRepoPath)) throw new Error(`localRepoPath not found: ${localRepoPath || "(empty)"}`);
    const sourceDir = String(a.sourceDir || "Learning");
    const learningPath = path.join(localRepoPath, sourceDir);
    if (!fs.existsSync(learningPath)) throw new Error(`${sourceDir}/ folder not found at ${learningPath}`);
    const prune = a.prune === true;
    const dryRun = a.dryRun === true;

    // Slug from the checkout's own origin — the wiki lives next to the repo, in that repo's org.
    const origin = git(["-C", localRepoPath, "remote", "get-url", "origin"], localRepoPath, { allowFail: true });
    let slug = origin.ok ? slugFromRemote(origin.out) : null;
    let slugSource = "origin remote";
    if (!slug) {
        if (!a.repoName) throw new Error(`Could not derive <owner>/<repo> from the origin remote of ${localRepoPath} (${origin.out.trim() || "no origin"}); pass repoName.`);
        slug = `${org}/${a.repoName}`;
        slugSource = `config organisation + repoName (origin unparsable: ${origin.out.trim()})`;
    }

    const work = fs.mkdtempSync(path.join(os.tmpdir(), "rimagentic-wiki-"));
    const clone = path.join(work, "wiki");
    const publicRemote = `https://github.com/${slug}.wiki.git`;
    try {
        // Clone: token over HTTPS (works on a runner with no SSH key), then SSH (the local dev box).
        const attempts: Array<{ label: string; url: string }> = [];
        if (token) attempts.push({ label: "https+token", url: `https://x-access-token:${token}@github.com/${slug}.wiki.git` });
        attempts.push({ label: "ssh", url: `git@github.com:${slug}.wiki.git` });
        let cloned = "";
        const failures: string[] = [];
        for (const at of attempts) {
            const r = git(["clone", "--quiet", at.url, clone], work, { allowFail: true });
            if (r.ok && fs.existsSync(path.join(clone, ".git"))) { cloned = at.label; break; }
            failures.push(`${at.label}: ${redact(r.out, token).trim().split(/\r?\n/).pop()}`);
            if (fs.existsSync(clone)) fs.rmSync(clone, { recursive: true, force: true });
        }
        if (!cloned) {
            throw new Error(
                `Could not clone ${publicRemote} (${failures.join("; ")}). GitHub creates the wiki repo only after the first page ` +
                `is made in the web UI — open https://github.com/${slug}/wiki and create Home once, then retry. If the wiki exists, ` +
                `the token/SSH key has no access to ${slug}.`
            );
        }

        // Copy every source page over the clone and let GIT say what changed: a byte comparison
        // reports CRLF/LF-only differences that git's normalisation makes vanish, so the
        // added/updated lists would disagree with the diffstat.
        const sourceFiles = fs.readdirSync(learningPath).filter(f => f.toLowerCase().endsWith(".md") && fs.statSync(path.join(learningPath, f)).isFile());
        for (const f of sourceFiles) fs.copyFileSync(path.join(learningPath, f), path.join(clone, f));
        const sourceSet = new Set(sourceFiles.map(f => f.toLowerCase()));
        const orphans: string[] = [];
        for (const f of fs.readdirSync(clone)) {
            if (!f.toLowerCase().endsWith(".md") || sourceSet.has(f.toLowerCase())) continue;
            if (prune) fs.rmSync(path.join(clone, f));
            else orphans.push(f);
        }

        git(["add", "-A"], clone);
        const added: string[] = [], updated: string[] = [], removed: string[] = [];
        for (const line of git(["status", "--porcelain"], clone).out.split(/\r?\n/)) {
            const code = line.slice(0, 2).trim(), file = line.slice(3).trim();
            if (!file) continue;
            if (code === "A") added.push(file);
            else if (code === "M") updated.push(file);
            else if (code === "D") removed.push(file);
            else if (code.startsWith("R")) updated.push(file);
        }
        const diffstat = git(["diff", "--cached", "--stat"], clone).out.trim();
        const summary = { slug, slugSource, wikiRemote: publicRemote, clonedVia: cloned, sourceDir, added, updated, removed, orphans, diffstat };
        if (!diffstat) return okText({ ok: true, upToDate: true, ...summary, note: `Wiki for ${slug} already matches ${sourceDir}/.` });
        if (dryRun) return okText({ ok: true, dryRun: true, ...summary, note: "Nothing committed or pushed. Re-run without dryRun to publish." });

        const message = String(a.message || `Sync wiki from ${sourceDir}/ (+${added.length} ~${updated.length} -${removed.length})`);
        git(["-c", "user.name=RimAgentic wiki sync", "-c", "user.email=rimagentic@localhost", "commit", "-q", "-m", message], clone);
        const push = git(["push", "origin", "HEAD"], clone, { allowFail: true });
        if (!push.ok) throw new Error(`Wiki commit created but push failed: ${redact(push.out, token).trim()}`);
        const sha = git(["rev-parse", "HEAD"], clone).out.trim();
        return okText({ ok: true, pushed: true, commit: sha, message, ...summary, wikiUrl: `https://github.com/${slug}/wiki` });
    } finally {
        try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* temp dir; best effort */ }
    }
}
