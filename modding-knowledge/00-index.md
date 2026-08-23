# RimWorld Modding Knowledge Base

The agent reads these via the `query_modding_docs` MCP tool. Start here, then read
the specific doc for the task. This is a working starter set — expand it over time.

## Contents

- **01-mod-structure.md** — folder layout, `About/About.xml`, `LoadFolders.xml`,
  per-version and `Assemblies/` folders.
- **02-defs-and-xml.md** — the Def system: what Defs are, how XML maps to game
  classes, `defName`, `ThingDef`/`RecipeDef`/etc., inheritance with `ParentName`/`Abstract`.
- **03-xml-patches.md** — modifying *other* content without overwriting it:
  `PatchOperation` types and XPath.
- **04-csharp-and-harmony.md** — adding behavior: a C# assembly, `[StaticConstructorOnStartup]`,
  `Mod`/`ModSettings`, custom `Comp`/`ThingClass`, and Harmony patching vanilla methods.
- **05-load-order.md** — `packageId`, `loadAfter`/`loadBefore`, `modDependencies`,
  why order matters (and how it silently breaks compiles between mods).
- **06-using-this-toolkit.md** — how to drive THIS toolkit: discover the target
  mod, resolve load order, deploy, launch, run tests, read the log, and use the
  in-game tool bridge to inspect/act on a running game.
- **07-in-game-tests.md** — the in-game test host (RimAgentic bridge) and per-repo
  `Source.Tests` suites: where cases live, phases, writing rules, the sentinel
  cases, and the `[SYNAPSE-TEST]` wire contract.

## The core mental model

RimWorld content is **data (Defs, in XML)** plus **behavior (C#)**. Most mods are
mostly XML. You add new content by adding Defs; you change existing content by
*patching* it (never edit the base game's files); you add genuinely new behavior
with a C# assembly and, where you must change how vanilla code runs, Harmony.
