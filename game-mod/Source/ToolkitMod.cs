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

            var harmony = new Harmony(HarmonyId);
            harmony.PatchAll();

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
