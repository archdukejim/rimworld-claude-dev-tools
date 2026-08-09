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

## Debug actions (REQUIRED to validate any mechanic — part of the testing gate)

A mechanic you build or change is **not done** until a debug command has exercised it and
you've confirmed it behaves as intended. This is a definition-of-done gate, not optional
polish: assuming the code works is not validation. For every mechanic you touch you **MUST**
(1) build a `[DebugAction]` that forces the behavior and/or dumps state, (2) trigger it — from
the in-game **Debug Actions menu** (dev mode → "wrench") or headlessly via `execute_game_tool`
— and (3) read the result / log to prove intent. Many mechanics only fire under conditions you
can't reproduce on demand, so the forced command is the fastest path from "wrote it" to
"watched it work." (Required for what you touch — not a mandate to retrofit untouched mechanics.)

Declare them as **static methods with `[DebugAction]`** (namespace `LudeonTK` on
RimWorld 1.5+). Group everything under the mod's category so it's one menu section:

```csharp
using LudeonTK;
using Verse;

public static class DebugActions_MyMechanic
{
    // Fires from the menu with no target.
    [DebugAction("RimSynapse", "MyMechanic: dump state",
        actionType = DebugActionType.Action,
        allowedGameStates = AllowedGameStates.PlayingOnMap)]
    private static void DumpState() { /* Log.Message(...) */ }

    // Gives a targeting cursor, then runs once per clicked pawn (human clicks in the menu).
    [DebugAction("RimSynapse", "MyMechanic: force-trigger on pawn",
        actionType = DebugActionType.ToolMapForPawns,
        allowedGameStates = AllowedGameStates.PlayingOnMap)]
    private static void ForceTrigger(Pawn p) { /* mutate/exercise the mechanic on p */ }
}
```

A validation command usually does one of: **inspect** (dump current state to the log),
**force** (make the mechanic happen now, bypassing its trigger conditions), or **reset/clear**
state so you can re-run cleanly. Pick `actionType` to fit: `Action` (no target),
`ToolMap` (click a cell), `ToolMapForPawns` (click pawns).

**A plain `[DebugAction]` is now headlessly triggerable** — you do NOT need a per-mod
`RegisterTool` just to validate. The generic toolkit game mod (`archdukejim.rimagentic`) exposes
two bridge tools that reflect over EVERY loaded assembly:

- **`list_debug_actions`** — discover any mod's debug actions (name, category, `signature`).
- **`run_debug_action`** — invoke one by name. It dispatches on the method signature: no-arg
  (`DebugActionType.Action`) runs immediately; single-`Pawn` (`ToolMapForPawns`) takes `pawnName`;
  single-`IntVec3` (`ToolMap`) takes `x`/`z`. So writing the `[DebugAction]` gives you BOTH the
  in-game menu entry a human clicks AND the headless hook the agent fires — from one method.

Call them via the MCP `execute_game_tool`. This requires the **toolkit mod to be the active
bridge** (it polls `%LOCALAPPDATA%\RimAgentic\ipc`, matching the MCP default; it force-loads last
so its scan sees every mod). Note the older `RegisterDynamicDebugActions()` in both Core and the
toolkit only auto-exposes RimWorld's **vanilla** debug actions (it scans
`DebugActionAttribute.Assembly`) — `run_debug_action` is what covers mod-defined ones.

Still reach for `SynapseToolRegistry.RegisterTool(...)` when you want a *first-class* tool with a
structured argument schema and JSON return (richer than a debug action's fire-and-log) — reference
`Conversations/Source/API/ConversationMcpTools.cs`.

## Compatibility discipline

- Patch the smallest method that does the job. Don't destructively replace with a
  Prefix `return false` unless you must.
- Guard optional-mod integration behind `ModsConfig.IsActive("packageId")` /
  Harmony's `TargetMethod` returning null when a type is absent.
- Log through the game's `Verse.Log`; a red error at startup is how users notice breakage.
