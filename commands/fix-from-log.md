---
description: Run (or read) a RimWorld test, triage Player.log, and fix the mod's errors — then re-verify.
argument-hint: "[what you were testing / a specific error, optional]"
allowed-tools: Bash, Read, Write, Edit, mcp__rimagentic__read_rimworld_log, mcp__rimagentic__run_rimworld_tests, mcp__rimagentic__deploy_rimworld_mods, mcp__rimagentic__launch_rimworld, mcp__rimagentic__configure_active_mods, mcp__rimagentic__query_modding_docs, mcp__rimagentic__list_game_tools, mcp__rimagentic__execute_game_tool
---

Diagnose and fix errors from a RimWorld run. Context: `$ARGUMENTS`.

## 1. Get a fresh log
If the game isn't already running the thing under test, run `run_rimworld_tests` (or
`deploy_rimworld_mods` → `launch_rimworld` quicktest). Then `read_rimworld_log` for the
classified triage: exceptions, Harmony patch failures, XML/Def errors, missing
dependencies, version warnings.

## 2. Triage — fix in this priority order
1. **XML/Def errors** — a `Could not resolve`/`Def named X not found`/`Config error` points
   at a bad defName, wrong field, or a patch whose xpath matched nothing. Open the mod's
   `Defs/`/`Patches/` and fix; check `query_modding_docs` `02`/`03` for the correct shape.
2. **Missing dependencies** — a required mod isn't active or isn't loaded before this one.
   Fix load order (`configure_active_mods`) or add the `modDependencies`/`loadAfter` entry.
3. **Harmony patch failures** — a patch target moved or the signature is wrong. Check the
   patched type/method against the current game version (`04-csharp-and-harmony.md`); prefer
   a Postfix; guard optional-mod targets.
4. **Exceptions** — read the stack, map the top frame to the mod's code, fix the cause
   (null ref, bad cast, missing null-guard). Use `inspect_csharp_field` /
   `search_game_definitions` via the game bridge to check real runtime values/def names.
5. **Version / metadata warnings** — usually non-blocking; note them, fix if trivial.

Attribute each error to a specific file/line where possible. Ignore red herrings: a bare
`at Foo.Bar ()` frame with no exception headline is deliberate trace logging, not a crash.

## 3. Re-verify
After fixing, re-run (rebuild C# if changed) and `read_rimworld_log` again. Loop until the
blocking count is 0, or until you hit something that needs the user (a design decision, a
missing asset). Don't declare success while `read_rimworld_log` still reports blocking entries.

## 4. Report
For each error: what it was, the file/cause, the fix. End with the final log state
(clean vs. remaining) — quote the counts, don't hand-wave.
