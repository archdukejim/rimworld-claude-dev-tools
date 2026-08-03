# Mod structure & folder layout

A RimWorld mod is a folder under `RimWorld/Mods/` (or a Steam Workshop item). The
game scans each mod folder for a well-known layout.

## Minimum viable mod

```
MyMod/
  About/
    About.xml          # required — identity + metadata
    Preview.png        # optional — Workshop/mod-list thumbnail (512x512+)
  Defs/                # XML Defs (new content)
  Patches/             # XML PatchOperations (modify other content)
  Textures/            # PNGs, referenced by texPath in Defs
  Sounds/
  Assemblies/          # compiled C# .dll(s), loaded at startup
  Languages/           # translations / keyed strings
  Learning/            # (this ecosystem's convention) in-game help markdown
  LoadFolders.xml      # optional — per-version folder routing
```

Only `About/About.xml` is strictly required. Everything else is loaded if present.

## About/About.xml

```xml
<?xml version="1.0" encoding="utf-8"?>
<ModMetaData>
  <packageId>yourname.mymod</packageId>   <!-- unique, lowercase, dotted; the mod's identity -->
  <name>My Mod</name>
  <author>Your Name</author>
  <supportedVersions>
    <li>1.5</li>
    <li>1.6</li>
  </supportedVersions>
  <description>What the mod does.</description>
  <modDependencies>
    <li>
      <packageId>brrainz.harmony</packageId>
      <displayName>Harmony</displayName>
      <steamWorkshopUrl>steam://url/CommunityFilePage/2009463077</steamWorkshopUrl>
    </li>
  </modDependencies>
  <loadAfter>
    <li>brrainz.harmony</li>
  </loadAfter>
</ModMetaData>
```

- `packageId` is the permanent identity used everywhere (load order, dependencies,
  `ModsConfig.xml`). Never change it after release.
- `modDependencies` = hard requirements (the game warns if missing). `loadAfter` /
  `loadBefore` = advisory ordering only (see 05-load-order.md).

## Version folders & LoadFolders.xml

RimWorld supports per-version content. By default the game looks for version
folders (`1.5/`, `1.6/`) each containing their own `Defs/`, `Patches/`, `Assemblies/`.
`LoadFolders.xml` lets you route which folders load for which version explicitly:

```xml
<loadFolders>
  <v1.6>
    <li>/</li>            <!-- common root -->
    <li>1.6</li>          <!-- 1.6-specific overrides -->
  </v1.6>
</loadFolders>
```

Use version folders when a mod must differ between game versions; otherwise a flat
layout (Defs/ at the root) is simpler.

## Assemblies

Compiled C# DLLs go in `Assemblies/` (or `<version>/Assemblies/`). RimWorld loads
every DLL there at startup, in mod load order. See 04-csharp-and-harmony.md.
