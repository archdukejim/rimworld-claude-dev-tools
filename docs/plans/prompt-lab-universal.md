# PromptLab — the universal, game-free RimSynapse prompt/response harness

**Status: Phase 1 IMPLEMENTED** (dev-tools branch `agent/bb82b711`). Phases 2–4 planned.

## Goal

A feedback loop for **any** RimSynapse LLM call site: compose the exact prompt the game would send → run it
against the same local model → return the **raw** response → iterate and tune — all with **no game launch**.
It replaces the `deploy → launch RimWorld → load save → force a debug action → read the log` round-trip
(~1–2 min, fragile) with an HTTP round-trip.

It **does not judge, and it does not source input data.** The harness returns the raw response (+ the composed
prompt, an optional family-specific parse, and metadata). Both *judging* the output and *supplying realistic
inputs* (real captures, synthetic values, hand-authored scenarios) are the job of whatever specific tester is
built on top, tuned to that tester's goal. The framework stays unopinionated: compose → run → return raw.

## Architecture

### Family registry (`promptlab/`, in dev-tools)
Each LLM call site is an `IPromptFamily` (`Contract.cs`): `Compose(inputs)→{system,user}`, optional
`ParseRaw`, an **input contract** (fields + types + provenance), and a scenario **catalog**. `Registry.cs`
discovers implementors by reflection — adding a family needs no central wiring.

**Faithful by construction:** a family `<Compile>`-links the PURE, Verse-free composer authored ONCE in its
mod (from the workspace), so a prompt change in the mod changes the lab too. A TS reimplementation would drift
— never build one. A mod absent from the workspace contributes no family (its linked source + adapter are
conditionally excluded by the csproj; the reflection registry never sees it).

Current families:
- **conversation** — Conversations dialogue. Links `ThinPromptComposer` / `IdentityComposer` /
  `LenientDialogueParser`. Catalog: 8 beats × 4 identity variants (the #44 register regression suite).
- **newspaper** — WorldNews broadsheet. Links `NewspaperPromptComposer`. Catalog: 5 event batches.
- **psychology.voice** — Psychology voice-profile derivation. Links `VoiceProfilePromptComposer`. This is the
  prompt that PRODUCES the `voiceProfile` the `conversation` family's #44 identity logic consumes, so the whole
  register loop is tunable game-free.
- **psychology.break** — extreme mental-break prediction. Links `BreakPromptComposer`.
- **psychology.childhood** — childhood backstory-memory. Links `ChildhoodMemoryPromptComposer`.

The other Psychology call sites (adulthood-memory, life-analysis, clinical evaluation, therapy summary,
internal monologue, adulthood-selector, visitor memories) follow the same shape and can be extracted the same
way as follow-ups.

### The console (dev-only)
`promptlab/PromptLab.csproj` (net8) hosts the registry, the generic runner (`Program.cs`), the faithful caller
(`LlmCaller.cs`), and the live-config reader (`CoreConfigReader.cs`). It reads the **live Core config**
(`Mod_Core_RimSynapseMod.xml`), auto-maps the loaded local model like the game, and POSTs the faithful
non-agentic body `{model, messages}` + thinking-disable flags — **no** temperature/max_tokens/response_format
(matching Core's non-agentic `ChatOptions`). Built on demand by `harness/promptlab.ps1`; never by the TS build
or the `.mcpb`.

Per-mod source roots default to `$RS_Root\<Mod>`, overridable via `*_SRC` env vars (`CONVERSATIONS_SRC`,
`WORLDNEWS_SRC`, …) so a family can be tested against a mod branch/worktree before it lands in the workspace.

### Surface (MCP)
- `simulate_llm_prompt { family, mode(suite|scenario), inputs|scenarios, suiteFilter, runs, dryRun, config }`
  → raw responses + composed prompts + optional parse + metadata.
- `list_prompt_families` → families + input contracts + catalog sizes.

## Faithful request shape (resolved)
Core's non-agentic prompt path passes a `ChatOptions` that sets **no** temperature/max_tokens/response_format,
so the faithful body is `{ model, messages:[system,user] }` + `thinking:false`/`think:false`/
`chat_template_kwargs.enable_thinking:false` when `disableThinking` is set. Model auto-mapped from `/v1/models`
(config default `autoMapModel=true`, empty `selectedModel`).

## Phasing
1. **DONE — registry + raw-return tool.** `simulate_llm_prompt` / `list_prompt_families`; live config;
   faithful body; auto-map.
2. **DONE — families across three mods.** conversation, newspaper, psychology.voice/break/childhood.
3. **Iteration ergonomics (optional).** A/B (two prompt variants / two models side by side), snapshot + diff vs
   a saved baseline, `runs>1` variance aggregation. (Still no judging — just structured raw for the consumer.)
4. **More families + agentic loops.** The remaining Psychology sites; other mods; then multi-step tool-using
   agents (Core's director) with mock tools.

**Explicitly out of scope (per direction):** input-data fixturing (capture-from-launch, corpus/type
inference) and response judging. Those belong to the specific testers built on top of the raw harness, tuned to
each tester's need — not to the universal framework.

## Cross-repo landing
- **Conversations** `feature/prompt-lab` (#54): the pure composer (mod-owned). Converges with the pending #44
  edits on `feature/multi-speaker-sessions` — merge to the single #44 implementation.
- **WorldNews** `feature/prompt-lab-composer`: the pure `NewspaperPromptComposer`.
- **dev-tools** `agent/bb82b711` (#29): the console + registry + families + tools.
Until the mod pure composers land in the workspace, point `CONVERSATIONS_SRC` / `WORLDNEWS_SRC` at their
checkouts.

## Validation (Phase 1)
Both mods compile with their refactors; the console builds with both families; end-to-end through the built MCP
handler against the live LAN model (`google/gemma-4-e2b`): conversation reproduces the #44 phenomenon
(voiced-clinical → clinical; voiceless-bare → plain speech); newspaper produces a full issue with a structured
parse (headline + wealth/strength deltas).
