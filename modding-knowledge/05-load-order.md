# Load order & dependencies

RimWorld loads mods in the order listed in `ModsConfig.xml` (the active-mods list).
That order decides which Defs/patches/assemblies win and whether inter-mod C#
references resolve. Getting it wrong fails **silently** more often than loudly.

## The declarations (in About.xml)

- **`modDependencies`** — hard requirement; the game warns the user if the named
  `packageId` isn't active. Implies "load me after it."
- **`loadAfter`** / **`loadBefore`** — advisory ordering hints. The game *does not*
  enforce them beyond nudging the auto-sorter; the actual order is whatever
  `ModsConfig.xml` lists.
- **`forceLoadAfter`** / **`forceLoadBefore`** — stronger hints for the auto-sorter.
- **`incompatibleWith`** — declare known conflicts.

## The canonical base order

`brrainz.harmony` → `Ludeon.RimWorld` (Core) → official DLCs
(`Ludeon.RimWorld.Royalty`, `.Ideology`, `.Biotech`, `.Anomaly`, `.Odyssey`) →
frameworks/libraries → content mods → patches-over-everything mods.

## Why order matters (two silent failure modes)

1. **Patches**: a patch only sees Defs that already loaded. If mod B patches mod A's
   Def but loads before A, the target doesn't exist yet and the patch no-ops.
2. **C# assembly binding**: if mod B's DLL is compiled against mod A's assembly, A
   must load first so its DLL is in memory. Loaded in the wrong order, *every* type
   from B fails to resolve — B sits in the list looking active while doing nothing,
   with only a few "could not find type" lines as evidence.

`loadAfter` is advisory: a mod-list sorter that ignores it (e.g. sorts
alphabetically) can produce the broken order. This toolkit's `resolve_mod_load_order`
reads each mod's declarations and computes a correct order; `configure_active_mods`
writes it to `ModsConfig.xml`.

## Practical rules

- Declare `loadAfter` for anything whose Defs you patch or whose assembly you bind.
- Make a hard requirement a `modDependencies` entry, not just `loadAfter`.
- Guard optional integrations so a wrong/missing order degrades gracefully, not red.
- Verify the *effective* order in `ModsConfig.xml`, not just your declarations.
