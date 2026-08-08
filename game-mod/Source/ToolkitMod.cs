using HarmonyLib;
using Verse;

namespace RimAgentic
{
    /// <summary>
    /// RimWorld mod entry point for the standalone agent tool bridge.
    /// Applies Harmony patches and initializes the tool registry.
    /// </summary>
    public class ToolkitMod : Mod
    {
        public static ToolkitMod Instance { get; private set; }

        private const string HarmonyId = "archdukejim.rimagentic";

        public ToolkitMod(ModContentPack content) : base(content)
        {
            Instance = this;

            // Keep Unity's Update loop — and therefore the GameComponent file-bridge poller — running
            // while the window is NOT focused. Unity suspends Update on focus loss by default, which is
            // why every bridge tool call previously needed the game brought to the foreground first and
            // still raced load-time timeouts. A dev/test instance should tick regardless of focus; the
            // idle watchdog is what prevents it from running unattended.
            try { UnityEngine.Application.runInBackground = true; } catch { }

            var harmony = new Harmony(HarmonyId);
            harmony.PatchAll();
            PerfProfiler.InstallTickPatch();   // always-on per-tick timer, patched imperatively (Harmony is loaded by now)

            LongEventHandler.ExecuteWhenFinished(() =>
            {
                SynapseToolRegistry.EnsureInitialized();
            });

            ToolkitLog.Message("Core initialized. Harmony patches applied.");
        }

        /// <summary>Exposes the mod's content root so the GameComponent can fall back to it for the IPC directory.</summary>
        public string RootDir => Content?.RootDir;
    }
}
