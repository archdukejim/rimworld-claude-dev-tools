import { execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";

export const syncTools = [
    {
        name: "sync_repo_wiki",
        description: "Syncs a local Learning folder to its GitHub Wiki repository",
        inputSchema: {
            type: "object",
            properties: {
                repoName: { type: "string", description: "Name of the repository (e.g. Core)" },
                localRepoPath: { type: "string", description: "Absolute path to the local repository clone" }
            },
            required: ["repoName", "localRepoPath"]
        }
    }
];

export async function handleSyncTool(name: string, args: any, org: string, token: string) {
    if (name === "sync_repo_wiki") {
        const { repoName, localRepoPath } = args;
        const learningPath = path.join(localRepoPath, "Learning");
        
        if (!fs.existsSync(learningPath)) {
            throw new Error(`Learning folder not found at ${learningPath}`);
        }

        const tempWikiPath = path.join(localRepoPath, ".wiki_temp");
        
        try {
            // Clean up any old temp dir
            if (fs.existsSync(tempWikiPath)) {
                fs.rmSync(tempWikiPath, { recursive: true, force: true });
            }
            
            // The wiki lives wherever the repo actually lives — derive the owner/repo
            // slug from the checkout's origin remote (repos exist in more than one org,
            // e.g. Regions-and-societies). The configured org is only the fallback for
            // checkouts without a usable remote.
            let slug = `${org}/${repoName}`;
            try {
                const originUrl = execSync("git remote get-url origin", {
                    cwd: localRepoPath,
                    stdio: ["ignore", "pipe", "pipe"]
                }).toString().trim();
                const m = originUrl.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
                if (m) slug = m[1];
            } catch {
                // no origin remote — keep the configured-org fallback
            }

            // Clone the wiki repo using the token for auth
            const wikiUrl = `https://oauth2:${token}@github.com/${slug}.wiki.git`;
            execSync(`git clone ${wikiUrl} "${tempWikiPath}"`, { stdio: 'inherit' });
            
            // Copy contents from Learning to wiki
            // We use fs.cpSync for cross-platform recursive copy
            const files = fs.readdirSync(learningPath);
            for (const file of files) {
                const src = path.join(learningPath, file);
                const dest = path.join(tempWikiPath, file);
                fs.cpSync(src, dest, { recursive: true, force: true });
            }
            
            // Commit and push
            execSync(`git add .`, { cwd: tempWikiPath, stdio: 'inherit' });
            
            // Check if there are changes
            try {
                execSync(`git commit -m "Automated wiki sync from Learning folder"`, { cwd: tempWikiPath, stdio: 'pipe' });
                execSync(`git push origin HEAD`, { cwd: tempWikiPath, stdio: 'inherit' });
                return { content: [{ type: "text", text: `Wiki for ${repoName} synced successfully.` }] };
            } catch (commitErr: any) {
                if (commitErr.stdout && commitErr.stdout.toString().includes("nothing to commit")) {
                    return { content: [{ type: "text", text: `Wiki for ${repoName} is already up to date.` }] };
                }
                throw commitErr;
            }
        } finally {
            // Cleanup
            if (fs.existsSync(tempWikiPath)) {
                fs.rmSync(tempWikiPath, { recursive: true, force: true });
            }
        }
    }
    
    throw new Error(`Unknown sync tool: ${name}`);
}
