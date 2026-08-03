# Build Plan — RimAgentic Agent Package (turnkey Claude Code modding agent)

**Supersedes `orchestrator-agent.md`** (which predated the pivot and framed a
separate SDK app / RimSynapse CI). The real product: a modder **installs RimAgentic,
links it to Claude Code, and starts a session** — Claude Code already knows how to do
everything. The agent *is* Claude Code; RimAgentic is the tools + game mod + knowledge
+ **the instruction layer that makes Claude Code a complete modding agent out of the box.**

## What "the agent knows how to do everything" means

Not a separate runtime — a bundled **agent-instruction layer** that ships with the
package so a fresh Claude Code session is immediately a RimWorld modding expert:

1. **Project instructions** — a `CLAUDE.md` (dropped into the modder's project, or a
   template) teaching the RimAgentic workflow: discover → know-how (`query_modding_docs`)
   → author Defs/XML/C# → resolve load order → deploy → launch → test → read logs →
   inspect the running game → deconflict → iterate.
2. **Skills / slash commands** for the common jobs (e.g. `/new-mod`, `/test-mod`,
   `/fix-from-log`, `/deconflict`), so the workflow is one command, not re-explained.
3. **One-step install** — register the MCP server, symlink the game mod into `Mods/`
   (loaded last), set env, verify the bridge. "Install + link Claude Code" is the
   whole setup.

## Capability map (owner's list → what exists vs. new)

| Capability | Status | Backed by |
|---|---|---|
| **Author mod content** (Defs/XML/C#) | agent skill + docs | `query_modding_docs` + Claude Code editing; needs the instruction layer. |
| **Read Steam Workshop content** (descriptions, deps, comments) | partial | `swh_*` tools (browser bridge) + `list_installed_mods` (Workshop folder scan). Needs: agent guidance + maybe a lighter read path. |
| **Bug-log analysis** | ✅ | `read_rimworld_log` (classified triage). |
| **In-game testing** | ✅ proven | `launch_rimworld`/`run_rimworld_tests` + the game bridge (`execute_game_tool`). |
| **Check window mapping in-game** | ✅ (structural) | `get_open_windows` game tool reads `Find.WindowStack` → open windows' type/id/layer/rect. Verified live. `pcControl` `capture_screen`/`get_ui_element_info` remain for pixel-level fallback. |
| **Deconflict mod package features** | partial | `resolve_mod_load_order` (cycles/ambiguous), `get_mod_metadata` (`incompatibleWith`). **New: `detect_mod_conflicts`** — duplicate packageIds (the Biotech collision we hit), incompatible pairs, patch-target overlaps. |

## New MCP tools implied (build as gaps hit)

- **`detect_mod_conflicts`** — given the active set, report: duplicate `packageId`s
  (shadowing), `incompatibleWith` pairs both active, load-order cycles, and (stretch)
  XML patches targeting the same def from different mods. The deconfliction surface.
- **Window/UI navigation** — a named-window lookup + screenshot (roadmap #1) so the
  agent can "check window mapping" by name, not pixel-hunting.
- **Workshop read helper** — thin content read if the `swh_*` browser path is too heavy
  for a fresh install.

## Distribution = a Claude Code **plugin** (confirmed mechanism)

`.mcpb` is Claude *Desktop* only. For Claude Code, a **plugin** bundles the MCP server +
skills + slash commands + subagents together, installable per-project or user-wide:

```
/plugin marketplace add archdukejim/rimworld-claude-dev-tools
/plugin install rimagentic@rimworld-claude-dev-tools
```

"Per project but easily available" = install **user scope once** (available in every
project); the per-project brain is the bundled **`/rimagentic:setup`** command that does the
machine steps a plugin can't (build server, symlink the game mod last, write project
`CLAUDE.md`, verify). "Click to launch" = a `claude-cli://open?repo=…&q=/plugin install …`
deep link in the README (prefills the command; no mechanism silently auto-installs — the
user presses enter). A plugin cannot symlink the mod / build C# / drop a `CLAUDE.md`, so
those live in `/rimagentic:setup`.

**Scaffolded (P1/P2, untested as a plugin):** `.claude-plugin/plugin.json`,
`.claude-plugin/marketplace.json`, `.mcp.json` (server via `${CLAUDE_PLUGIN_ROOT}`),
`commands/setup.md` (`/rimagentic:setup`). **Verify on first install:** exact `.mcp.json`
placement + `${CLAUDE_PLUGIN_ROOT}` resolution, and that a root `.mcp.json` doesn't
double-register when this repo is opened directly.

## Build order

- **P1 — Agent-instruction layer.** The `CLAUDE.md` (modder-project template) + a core
  skill for the dev loop. This is the "knows everything" brain and the highest leverage;
  everything else is a tool it calls. **Start here.**
- **P2 — One-step install.** A setup script: register MCP, build + symlink the game mod
  last, set env, run the Tier-1/Tier-3 verification we just did by hand.
- **P3 — ✅ `detect_mod_conflicts` tool + `/rimagentic:deconflict` command.** Tool verified
  on the live install (found 12 real duplicate packageIds). Command explains + resolves.
- **P4 — window mapping ✅** (`get_open_windows`, verified live). Remaining: Workshop
  content read + pixel-level window *navigation* (drive UI to a named window, roadmap #1/#2).
- **P5 — ✅ Authoring commands** `/rimagentic:new-mod` (scaffold + first content + verify)
  and `/rimagentic:fix-from-log` (triage Player.log → fix → re-verify). README install
  section + deep-link added.
- **P6 — ✅ Parallelism** via the async job broker: `submit_test_job` / `get_job` /
  `list_jobs` / `cancel_job`. Embedded in the MCP server (not a daemon); async submit,
  serial game-run lane, per-job isolated savedatafolder. Verified.

## Open questions

1. **Where does the modder's `CLAUDE.md` come from?** Shipped as a template they copy,
   or an `install`/`init` command that writes it into their mod project?
2. **Workshop reads** — reuse the `swh_*` browser extension (needs the extension
   installed) or add a no-extension HTTP read path for a lighter install?
3. **Autonomy** — how far does the agent go before checking in (build/test = free;
   Workshop publish / git push = propose)?
