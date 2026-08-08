using System;
using HarmonyLib;
using Verse;

namespace RimAgentic
{
    /// <summary>
    /// Resume a colony straight from launch. When the RIMAGENTIC_AUTOLOAD_SAVE environment variable
    /// names an existing save, the game loads it as soon as the main menu comes up — the automated
    /// equivalent of clicking "Continue" — so a dev loop can close the game and jump back into the
    /// exact same state instead of the menu.
    ///
    /// The launch tools set that variable (launch_rimworld's loadSave); the MCP idle watchdog names
    /// the slot it autosaves to, so a killed-overnight session is one relaunch away from resuming.
    ///
    /// Fires exactly once, on the first entry menu after the process starts. Quitting to the menu
    /// later must not silently reload — that would trap the player, so a one-shot guard bars it.
    /// </summary>
    [HarmonyPatch(typeof(UIRoot_Entry), nameof(UIRoot_Entry.Init))]
    public static class AutoLoadSavePatch
    {
        private static bool _fired;

        private static void Postfix()
        {
            if (_fired) return;
            _fired = true;

            string name;
            try { name = Environment.GetEnvironmentVariable("RIMAGENTIC_AUTOLOAD_SAVE"); }
            catch { return; }
            if (string.IsNullOrEmpty(name)) return;
            name = name.Trim();

            if (!SaveGameFilesUtility.SavedGameNamedExists(name))
            {
                ToolkitLog.Warning($"Autoload requested save '{name}' (RIMAGENTIC_AUTOLOAD_SAVE) but it does not exist — staying at the menu.");
                return;
            }

            ToolkitLog.Message($"Autoloading save '{name}' from launch (RIMAGENTIC_AUTOLOAD_SAVE).");
            // LoadGame schedules its own long event; safe to call while the entry UI initializes.
            GameDataSaveLoader.LoadGame(name);
        }
    }
}
