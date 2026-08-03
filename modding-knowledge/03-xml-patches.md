# XML Patches (modifying other content)

**Never edit the base game's or another mod's files.** To change existing content,
put `PatchOperation`s under your mod's `Patches/` folder. Patches run after all Defs
load, applying XPath-targeted edits to the combined Def database.

## Anatomy

```xml
<Patch>
  <Operation Class="PatchOperationReplace">
    <xpath>/Defs/ThingDef[defName="Steel"]/stackLimit</xpath>
    <value>
      <stackLimit>1000</stackLimit>
    </value>
  </Operation>
</Patch>
```

XPath selects nodes in the merged Def XML; the operation edits them.

## The operations you'll use most

- **PatchOperationAdd** — append child node(s) to the target element.
  ```xml
  <Operation Class="PatchOperationAdd">
    <xpath>/Defs/ThingDef[defName="Steel"]</xpath>
    <value><comps><li Class="...">...</li></comps></value>
  </Operation>
  ```
- **PatchOperationReplace** — replace the target node with `<value>`.
- **PatchOperationInsert** — insert a sibling before/after (`order`: Prepend/Append).
- **PatchOperationRemove** — delete the target node.
- **PatchOperationAttributeSet/Add/Remove** — edit XML attributes.
- **PatchOperationAddModExtension** — attach a `DefModExtension` to a Def.

## Conditional & grouped patches (be a good citizen)

- **PatchOperationFindMod** — only apply if a given mod is (or isn't) loaded. Use its
  `<nomatch>` branch to no-op cleanly when a target mod is absent.
- **PatchOperationSequence** — run a list of operations in order.
- **PatchOperationConditional** — apply `<match>` / `<nomatch>` based on whether an
  xpath exists. Guards against errors when the target isn't present.
- **PatchOperationTest** — succeeds/fails based on an xpath; often used with `success`.

Prefer `mayRequire="othermod.packageId"` on a Def `<li>` or a FindMod guard over an
unconditional patch, so your mod doesn't error red when a target mod isn't installed.

## XPath tips

- Select by defName: `/Defs/ThingDef[defName="Steel"]`.
- Descend to a field: `.../thingDef/statBases/MarketValue`.
- Match on a child value: `/Defs/RecipeDef[ingredients/li/filter/thingDefs/li="Steel"]`.
- A wrong xpath silently matches nothing — test with `PatchOperationTest` or verify
  in-game (see 06-using-this-toolkit.md) rather than assuming it applied.
