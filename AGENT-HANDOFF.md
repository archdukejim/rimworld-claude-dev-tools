# AGENT-HANDOFF — `agent/bb82b711`

## What this branch adds

**PromptLab — the universal, game-free RimSynapse prompt/response harness.** Compose the exact prompt any LLM
call site would send → run it against the same local model → return the **raw** response → iterate, with no
game launch. It does NOT judge (that's the consumer's job). See `docs/plans/prompt-lab-universal.md`.

- **NEW `promptlab/`** — a net8 console: a reflection-based family registry (`Contract.cs` `IPromptFamily`,
  `Registry.cs`), a generic runner (`Program.cs`), the faithful caller (`LlmCaller.cs`), and the live-Core-
  config reader (`CoreConfigReader.cs`). Families in `promptlab/Families/`: `ConversationFamily` (links
  Conversations' pure `ThinPromptComposer`/`IdentityComposer`/`LenientDialogueParser`) and `NewspaperFamily`
  (links WorldNews' pure `NewspaperPromptComposer`). Each family `<Compile>`-links its mod's pure composer from
  the workspace (`$RS_Root\<Mod>`, per-mod overridable via `*_SRC`), conditional on the source being present.
- **NEW `harness/promptlab.ps1`** — builds the console (passing `-p:WorkspaceRoot` + any `*_SRC` env
  overrides) and runs a job; emits ONLY the console's JSON on stdout.
- **CHANGED `server/src/tools/promptLab.ts`** — tool family `promptLab`:
  - `simulate_llm_prompt { family, mode, inputs|scenarios, suiteFilter, runs, dryRun, config }` → raw responses
    + composed prompts + optional family parse + metadata.
  - `list_prompt_families` → families + input contracts + catalog sizes.
- **CHANGED** `server/src/index.ts` (`promptLab` wired ×4 — unchanged since the family fns kept their names),
  `manifest.json`, `CLAUDE.md`, `.gitignore` (`promptlab/bin`,`obj`).

## Depends on the mod pure composers
- **Conversations** `feature/prompt-lab` (#54) — the pure `ThinPromptComposer` etc.
- **WorldNews** `feature/prompt-lab-composer` — the pure `NewspaperPromptComposer`.
Until those land in the workspace, set `CONVERSATIONS_SRC` / `WORLDNEWS_SRC` to their checkouts;
`promptlab.ps1` passes them through. A family whose source is absent simply isn't registered.

## Verify (done this session)
- `cd server && npm run build` clean; `manifest.json` valid; console builds with both families.
- End-to-end through the built MCP handler (with `*_SRC` set): `list_prompt_families` → conversation(32),
  newspaper(5); a conversation scenario returned parsed lines; a newspaper suite scenario returned a full issue
  (headline + wealth/strength deltas). #44 phenomenon reproduces (voiced-clinical → clinical; voiceless-bare →
  plain speech).

## Next (planned, not in this branch)
Phase 2 fixtures: `capture_prompt_fixtures` (game-launch-once dump of REAL inputs) then corpus/type inference;
Phase 3 A/B + snapshot/variance; Phase 4 Psychology families + agentic loops.

## Rollout note
Restart the running MCP server (`node server/build/index.js`) to expose the tools. The console is a dev-only
build (never in the TS build or `.mcpb`); it needs `dotnet` and the mod workspace present.
