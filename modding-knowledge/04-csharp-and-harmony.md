# C# & Harmony

Reach for C# when data (Defs/patches) can't express the behavior. Compile a .dll
into your mod's `Assemblies/` folder; RimWorld loads it at startup.

## Project setup

- Target **.NET Framework 4.8** (`<TargetFramework>net48</TargetFramework>`).
- Reference the game's `Assembly-CSharp.dll` and the `UnityEngine.*` modules from
  `RimWorld/RimWorldWin64_Data/Managed/`, plus `0Harmony.dll` from the Harmony mod.
  Mark them `<Private>false</Private>` (loaded by the game, never bundled).
- Bundle only genuinely-extra libraries (e.g. Newtonsoft) into `Assemblies/`.
- This toolkit's `game-mod/Source/RimAgentic.csproj` is a working reference csproj.

## Entry points

- **`[StaticConstructorOnStartup]`** on a class runs its static constructor once at
  startup (after Defs load) — the usual place to apply Harmony patches and cache Defs.
  ```csharp
  [StaticConstructorOnStartup]
  public static class MyModStartup {
      static MyModStartup() {
          new Harmony("yourname.mymod").PatchAll();
      }
  }
  ```
- **`Verse.Mod`** subclass — instantiated once; use for mod settings UI (`GetSettings`,
  `DoSettingsWindowContents`) and to hold a static `Instance`.
- **`GameComponent` / `WorldComponent` / `MapComponent`** — auto-instantiated per
  game/world/map (need a matching constructor). Good for per-save state and update ticks.
- Custom behavior on things via **`ThingComp`** (+ `CompProperties`) attached in a
  ThingDef's `<comps>`, or a custom `thingClass`.

## Harmony (patching vanilla methods)

Harmony rewrites method calls at runtime — the standard way to change how existing
game code behaves without editing it.

```csharp
[HarmonyPatch(typeof(Pawn_HealthTracker), nameof(Pawn_HealthTracker.HealthTick))]
public static class Patch_HealthTick {
    // Runs before the original; return false to skip the original.
    static bool Prefix(Pawn_HealthTracker __instance) { return true; }
    // Runs after the original; can read/alter __result.
    static void Postfix(Pawn ___pawn) { }
}
```

- **Prefix** (pre-check / skip), **Postfix** (adjust results — safest, most compatible),
  **Transpiler** (rewrite IL — powerful, fragile, last resort).
- `__instance`, `__result`, `___privateField` (triple underscore), and named original
  parameters are injected by matching name.
- Prefer Postfix; prefer patching narrow methods; avoid Transpilers unless necessary —
  they break across game versions and conflict with other mods.

## Compatibility discipline

- Patch the smallest method that does the job. Don't destructively replace with a
  Prefix `return false` unless you must.
- Guard optional-mod integration behind `ModsConfig.IsActive("packageId")` /
  Harmony's `TargetMethod` returning null when a type is absent.
- Log through the game's `Verse.Log`; a red error at startup is how users notice breakage.
