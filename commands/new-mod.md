---
description: Scaffold a new RimWorld mod in the current folder — About.xml, folder layout, and (if needed) a C# project — then optionally deploy + launch to confirm it loads.
argument-hint: "<mod name / what it should do>"
allowed-tools: Bash, Read, Write, Edit, mcp__rimagentic__query_modding_docs, mcp__rimagentic__get_mod_metadata, mcp__rimagentic__deploy_rimworld_mods, mcp__rimagentic__configure_active_mods, mcp__rimagentic__launch_rimworld, mcp__rimagentic__read_rimworld_log
---

Scaffold a new RimWorld mod based on `$ARGUMENTS` (the user's description of what the mod
should be/do). If the description is thin, ask 1–2 clarifying questions max, then proceed.

## 1. Ground yourself
Read `query_modding_docs` `01-mod-structure.md` (and `02-defs-and-xml.md` if the mod is
content, `04-csharp-and-harmony.md` if it needs behavior). Decide: **pure XML** (Defs/
Patches only) or **needs C#** (new behavior/Harmony).

## 2. Identity
Pick a `packageId` (`<author>.<modname>`, lowercase, dotted — must be globally unique and
permanent). Confirm the author handle and target `supportedVersions` (default `1.5`, `1.6`).
Sanity-check the id isn't already taken with `get_mod_metadata`.

## 3. Create the layout (in the current folder)
```
About/About.xml            # identity; add the Harmony modDependency only if C# is used
Defs/                      # for new content
Patches/                   # for modifying other content (only if needed)
Textures/ Sounds/ Languages/   # create only what the mod actually uses
```
- Write a correct `About.xml` (see `01-mod-structure.md`): packageId, name, author,
  supportedVersions, description; `modDependencies` + `loadAfter` for Harmony **only if C#**.
- If **C#**: add `Source/` with a `.csproj` modeled on
  `${CLAUDE_PLUGIN_ROOT}/game-mod/Source/RimAgentic.csproj` (net48, RimWorld/Unity/Harmony
  references, `OutputPath ..\Assemblies\`), plus a `GamePath.props` for the local install
  path, and a minimal entry class (`[StaticConstructorOnStartup]` or `Mod`).

## 4. Author the first content
Implement the smallest real version of what the user asked — one Def, or one patch, or one
Harmony patch — following the docs. Prefix defNames with the mod to avoid collisions.

## 5. Verify it loads (offer, don't force)
Offer to: `deploy_rimworld_mods` → `configure_active_mods` (this mod + Harmony + Core, the
RimAgentic mod auto-last) → `launch_rimworld` (quicktest) → `read_rimworld_log`. Confirm the
mod loads with no red errors before calling it done.

## 6. Report
List what you created, the packageId, XML-vs-C# decision, and the next step (what to add,
and that `/rimagentic:fix-from-log` triages any errors).
