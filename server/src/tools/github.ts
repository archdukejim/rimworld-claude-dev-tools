import { getGitHubToken, requireGitHubToken, loadRepoMap, RepoRef } from "../config";

/*
 * GitHub issue tools for the comment-triage routine. These run in the MCP
 * server (Node) and talk to the GitHub REST API directly — they do NOT use the
 * browser loopback bridge (that's only for Steam actions).
 *
 * Convention matches the other tool modules: export a `githubTools` array and a
 * `handleGithubTool(name, args)` dispatcher.
 *
 * Steam item -> repo comes from mcp-config/repo-map.json. Tools accept either a
 * `fileId` (resolved via the map) or explicit `owner`/`repo`.
 */

const API = "https://api.github.com";

function resolveRepo(args: any): RepoRef {
  if (args.owner && args.repo) return { owner: args.owner, repo: args.repo };
  if (args.fileId) {
    const map = loadRepoMap();
    const ref = map[String(args.fileId)];
    if (ref) return ref;
    throw new Error(
      `No repo mapping for workshop item ${args.fileId}. Add it to mcp-config/repo-map.json, ` +
        `or pass owner/repo explicitly.`
    );
  }
  throw new Error("Provide either `fileId` (mapped in repo-map.json) or explicit `owner` and `repo`.");
}

async function gh(path: string, init: RequestInit, token: string): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "steam-workshop-helper-mcp",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg = body && body.message ? body.message : `HTTP ${res.status}`;
    throw new Error(`GitHub API ${path} failed: ${msg}`);
  }
  return body;
}

export const githubTools = [
  {
    name: "swh_repo_for_item",
    description:
      "Resolve which GitHub repo a workshop item's issues belong to, from mcp-config/repo-map.json. Returns { owner, repo, title } or an 'unmapped' result.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "The Steam Workshop published file ID." },
      },
      required: ["fileId"],
    },
  },
  {
    name: "swh_find_issue",
    description:
      "Search a repo's issues (open and closed) for ones matching a comment — use this to avoid filing duplicates. Give a fileId (mapped to a repo) or owner/repo, plus a search query built from the comment's gist. Returns candidate issues { number, title, url, state }.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "Workshop file ID (resolved via repo-map)." },
        owner: { type: "string", description: "Repo owner (if not using fileId)." },
        repo: { type: "string", description: "Repo name (if not using fileId)." },
        query: {
          type: "string",
          description: "Free-text search built from the comment's core idea (keywords, not the whole comment).",
        },
        state: {
          type: "string",
          description: "Filter by 'open', 'closed', or 'all' (default 'all').",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "swh_create_issue",
    description:
      "Create a GitHub issue for a triaged comment. Give a fileId (mapped to a repo) or owner/repo, a title, a body (include the original comment quote, author, category, and Steam link), and labels. Returns { number, url }. Only call after dedup (swh_find_issue) and approval.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "Workshop file ID (resolved via repo-map)." },
        owner: { type: "string", description: "Repo owner (if not using fileId)." },
        repo: { type: "string", description: "Repo name (if not using fileId)." },
        title: { type: "string", description: "Issue title (concise, derived from the comment)." },
        body: { type: "string", description: "Issue body (Markdown)." },
        labels: {
          type: "array",
          items: { type: "string" },
          description: "Labels, e.g. ['bug'], ['enhancement'], ['qol'].",
        },
      },
      required: ["title", "body"],
    },
  },
];

export async function handleGithubTool(name: string, args: any) {
  const wrap = (obj: any) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });

  if (name === "swh_repo_for_item") {
    const map = loadRepoMap();
    const ref = map[String(args.fileId)];
    return wrap(ref ? { ...ref, fileId: String(args.fileId) } : { unmapped: true, fileId: String(args.fileId) });
  }

  const token = getGitHubToken();
  requireGitHubToken(token, name);

  if (name === "swh_find_issue") {
    const { owner, repo } = resolveRepo(args);
    const state = args.state && args.state !== "all" ? ` state:${args.state}` : "";
    const q = `repo:${owner}/${repo} is:issue${state} ${args.query || ""}`.trim();
    const result = await gh(`/search/issues?q=${encodeURIComponent(q)}&per_page=10`, { method: "GET" }, token);
    const items = (result.items || []).map((i: any) => ({
      number: i.number,
      title: i.title,
      url: i.html_url,
      state: i.state,
      body: (i.body || "").slice(0, 200),
    }));
    return wrap({ owner, repo, query: args.query, count: items.length, issues: items });
  }

  if (name === "swh_create_issue") {
    const { owner, repo } = resolveRepo(args);
    if (!args.title) throw new Error("swh_create_issue requires `title`");
    const payload: any = { title: args.title, body: args.body || "" };
    if (Array.isArray(args.labels) && args.labels.length) payload.labels = args.labels;
    const created = await gh(
      `/repos/${owner}/${repo}/issues`,
      { method: "POST", body: JSON.stringify(payload) },
      token
    );
    return wrap({ ok: true, number: created.number, url: created.html_url, owner, repo });
  }

  throw new Error(`Unknown GitHub tool: ${name}`);
}
