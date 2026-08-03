# Defs & XML

Most RimWorld content is **Defs** — data objects defined in XML and loaded into
typed C# classes at startup. Adding content = adding Defs under `Defs/`.

## What a Def is

Each XML Def maps to a C# class deriving from `Verse.Def`. The XML element name is
the class; child elements are its fields. Example — a simple item:

```xml
<Defs>
  <ThingDef ParentName="ResourceBase">
    <defName>MyMod_Crystal</defName>
    <label>crystal</label>
    <description>A shimmering crystal.</description>
    <graphicData>
      <texPath>Things/Item/Crystal</texPath>   <!-- Textures/Things/Item/Crystal.png -->
      <graphicClass>Graphic_Single</graphicClass>
    </graphicData>
    <statBases>
      <MarketValue>25</MarketValue>
      <Mass>0.2</Mass>
    </statBases>
    <stackLimit>75</stackLimit>
  </ThingDef>
</Defs>
```

- **`defName`** is the unique, code-facing id (no spaces; prefix with your mod to
  avoid collisions, e.g. `MyMod_Crystal`). **`label`** is the shown, lowercase name.
- File location under `Defs/` doesn't matter; the game reads them all. Organize by type.

## Common Def types

`ThingDef` (items, buildings, pawns, plants), `RecipeDef`, `ResearchProjectDef`,
`HediffDef` (health conditions), `TraitDef`, `JobDef`, `ThinkTreeDef`, `IncidentDef`,
`PawnKindDef`, `FactionDef`, `BiomeDef`, `TerrainDef`, `DesignationCategoryDef`, and
many more. Each has its own required fields — copy a vanilla example of the same type.

## Inheritance: Abstract + ParentName

Vanilla defines abstract base Defs you inherit from to avoid repetition:

```xml
<ThingDef Name="MyBase" Abstract="True">
  <thingClass>ThingWithComps</thingClass>
  <category>Item</category>
</ThingDef>

<ThingDef ParentName="MyBase">
  <defName>MyMod_Thing</defName>
  ...
</ThingDef>
```

`Abstract="True"` Defs are templates (never instantiated). `ParentName` pulls in the
parent's fields; child fields override. `ResourceBase`, `BuildingBase`, etc. are
vanilla abstract parents you'll use constantly.

## Finding what to write

The fastest way to author a Def is to copy a vanilla Def of the same type and edit
it. Vanilla Defs live in `RimWorld/Data/Core/Defs/` (and DLC `Data/<Dlc>/Defs/`).
Use this toolkit's `search_game_definitions` in-game tool (via `execute_game_tool`)
to look up def names and fields from the *running* game, including DLC content.

## Textures & assets

`texPath` is relative to any mod's `Textures/` folder (e.g. `Things/Item/Crystal`
→ `Textures/Things/Item/Crystal.png`). RimWorld auto-picks `_north/_east/_south`
variants for rotatable things. Keep power-of-two-ish sizes; the game handles atlasing.
