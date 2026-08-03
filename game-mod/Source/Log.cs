namespace RimToolkit
{
    /// <summary>
    /// Tiny static logger. Wraps Verse.Log with a fixed prefix so every line from this
    /// mod is greppable. Replaces the narrative mod's SynapseLogger.
    /// </summary>
    public static class ToolkitLog
    {
        public static void Message(string m) { Verse.Log.Message("[RimToolkit] " + m); }
        public static void Warning(string m) { Verse.Log.Warning("[RimToolkit] " + m); }
        public static void Error(string m) { Verse.Log.Error("[RimToolkit] " + m); }
    }
}
