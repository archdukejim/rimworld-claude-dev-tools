# AGENT-HANDOFF — `agent/85a44357-mod-corpus`

## What this branch adds

**`build_mod_def_corpus`** (defCorpus family, `server/src/tools/modDefCorpus.ts`) — a registered, graphable
corpus over any set of MODS' Def XML + Patches, with base game + DLC defs mixed in (default) so mod→vanilla
edges resolve. One call = parse → register_corpus → graph_corpus.

- Select mods by packageId / name / folder (`mods`) or `packageIdPattern` regex.
- Honours `loadFolders.xml` (version block ≤ game version from Version.txt; `IfModActive`/`IfModNotActive`
  judged against corpus mods + installed DLCs + `activeMods`), else RimWorld's default root + Common + best
  version folder. Skipped conditional folders are reported per mod.
- Relations: `extends`, `requiresResearch`, `produces`, `consumes`, `costs`, `craftedAt`, `race`, `patches`
  (PatchOperation record → the defs its xpaths target), `references` (any def id mentioned anywhere in the def,
  incl. statBases keys → StatDefs).
- Ids: defNames are unique per DEF TYPE in RimWorld, so the first record keeps the bare name; a same-name def
  of another type is `defName@DefType` (`sameNameAs`), a same-type duplicate from another mod is
  `defName@packageId` (`overrides` — reported as a real override). Typed relations resolve to the exact typed
  record; `references` resolves by bare name (first wins).
- Defs added by `PatchOperationAdd` into `/Defs` become real def records (`viaPatch:true`).
- `modRoots`: scan folders of mod checkouts (About/About.xml at the repo root or one level down) — how the
  full Vanilla Expanded series was built from sparse clones of the 125 `Vanilla-Expanded` GitHub repos
  (`%LOCALAPPDATA%RimAgenticmod-sourcesanilla-expanded`, blob-filtered to About/Defs/Patches/loadFolders).
  Handles a duplicated `<vX.Y>` block in loadFolders.xml (Vanilla Backgrounds Expanded has one).
- **NEW `server/src/tools/defXml.ts`** — helpers shared with `build_def_corpus` (moved out of defCorpus.ts).
- **CHANGED** `defCorpus.ts` (imports helpers, registers the tool), `manifest.json`, `CLAUDE.md`.

## Built this session (in `%LOCALAPPDATA%\RimAgentic\corpora`)
- `world-domination` — World Domination 2.0 (`tsa.worlddominationexperimental`) + game: 14,160 records.
- `vanilla-expanded` — ALL 124 mods in the Vanilla-Expanded GitHub org (sparse clones, `modRoots`) + game:
  36,988 records. Two repos are empty shells (VanillaTemplateExpanded, VIESAS). Third-party add-ons excluded.

## Verified
- Live MCP: `list_corpora` shows both graphed; `search_corpus` (filterField source=mod) returns VPE defs and
  patch records; `query_corpus_graph` `patches` reverse on `Player_Outpost` finds the WD2 patch; transitive
  `extends` walks `TSA_WD_Hayball_2a → TSA_WD_HayballBase → TSA_WD_PropBase → BuildingBase` (vanilla).
