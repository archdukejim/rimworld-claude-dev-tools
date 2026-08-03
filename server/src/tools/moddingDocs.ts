import * as fs from "fs";
import * as path from "path";

/**
 * Locate the bundled modding-knowledge folder. Overridable with RIMAGENTIC_DOCS so a
 * developer can point the agent at their own extended docs. Compiles to build/tools/, so
 * the repo root is three levels up; also try a couple of fallbacks for packaged layouts.
 */
function docsDir(): string {
    const candidates = [
        process.env.RIMAGENTIC_DOCS,
        path.resolve(__dirname, "../../../modding-knowledge"),
        path.resolve(__dirname, "../../modding-knowledge"),
        path.resolve(process.cwd(), "modding-knowledge")
    ].filter(Boolean) as string[];
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    return candidates[1];
}

export const moddingDocsTools = [
    {
        name: "query_modding_docs",
        description:
            "Read the bundled RimWorld modding knowledge base — how to structure a mod, write " +
            "Defs and XML, author XML patches (PatchOperation/XPath), add C# with Harmony, manage " +
            "load order, and drive this toolkit to launch/test/evaluate. Start here when helping a " +
            "developer mod RimWorld. With no arguments it lists the available documents; pass " +
            "'documentName' to read one, or 'searchQuery' to search across all of them.",
        inputSchema: {
            type: "object",
            properties: {
                documentName: {
                    type: "string",
                    description: "A specific doc to read (e.g. '02-defs-and-xml.md'). Omit to list all docs."
                },
                searchQuery: {
                    type: "string",
                    description: "Keyword to search across the modding docs; returns matching excerpts."
                }
            }
        }
    }
];

export async function handleModdingDocsTool(name: string, args: any) {
    if (name !== "query_modding_docs") throw new Error(`Unknown modding-docs tool: ${name}`);

    const dir = docsDir();
    if (!fs.existsSync(dir)) {
        return { content: [{ type: "text", text: `Modding docs folder not found at ${dir}. Set RIMAGENTIC_DOCS to override.` }] };
    }

    const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith(".md")).sort();

    if (args.documentName) {
        const safe = path.basename(String(args.documentName));
        const docPath = path.join(dir, safe);
        if (!fs.existsSync(docPath)) {
            return { content: [{ type: "text", text: `Document '${safe}' not found. Available:\n${files.map(f => `- ${f}`).join("\n")}` }] };
        }
        return { content: [{ type: "text", text: fs.readFileSync(docPath, "utf-8") }] };
    }

    if (args.searchQuery) {
        const query = String(args.searchQuery).toLowerCase();
        const results: string[] = [];
        for (const file of files) {
            const content = fs.readFileSync(path.join(dir, file), "utf-8");
            if (content.toLowerCase().includes(query)) {
                const lines = content.split("\n");
                const idx = lines.findIndex(l => l.toLowerCase().includes(query));
                const snippet = lines.slice(Math.max(0, idx - 1), idx + 3).join("\n");
                results.push(`--- ${file} ---\n${snippet.trim()}`);
            }
        }
        return {
            content: [{
                type: "text",
                text: results.length ? results.join("\n\n") : `No matches for '${query}'.`
            }]
        };
    }

    return {
        content: [{
            type: "text",
            text: `RimWorld modding knowledge base (${files.length} docs):\n${files.map(f => `- ${f}`).join("\n")}\n\n` +
                  `Call again with 'documentName' to read one, or 'searchQuery' to search.`
        }]
    };
}
