using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json;
using Verse;

namespace RimAgentic
{
    /// <summary>
    /// Save/load tools so a dev session can be checkpointed and resumed instead of thrown away.
    ///
    /// Pairs with the launch side (RIMAGENTIC_AUTOLOAD_SAVE / launch_rimworld loadSave) and the MCP
    /// idle watchdog, which autosaves through <c>save_game</c> before it closes an unattended game —
    /// so "the pawns died overnight" becomes "reload where we left off and keep testing".
    ///
    /// These run on the Unity main thread: the IPC poller dispatches every tool handler through the
    /// GameComponent's main-thread queue, so calling the game's own save/load loaders here is safe.
    /// </summary>
    public static partial class SynapseToolRegistry
    {
        /// <summary>Strip any path/extension a caller may have included — saves are named, not pathed.</summary>
        private static string SanitizeSaveName(string raw)
        {
            if (string.IsNullOrEmpty(raw)) return null;
            string name = Path.GetFileNameWithoutExtension(raw.Trim());
            foreach (char c in Path.GetInvalidFileNameChars()) name = name.Replace(c, '_');
            return string.IsNullOrEmpty(name) ? null : name;
        }

        private static void RegisterSaveTools()
        {
            // Tool: save_game — checkpoint the running colony to a named slot.
            RegisterTool(
                "save_game",
                "Save the currently running game to a named slot (Saves/<name>.rws) so it can be reloaded later to continue testing. Requires a live game — does nothing at the main menu.",
                new Dictionary<string, object>
                {
                    ["type"] = "object",
                    ["properties"] = new Dictionary<string, object>
                    {
                        ["name"] = new Dictionary<string, object>
                        {
                            ["type"] = "string",
                            ["description"] = "Save slot name, without extension. Defaults to 'RimAgentic_dev'."
                        }
                    }
                },
                args =>
                {
                    try
                    {
                        if (Current.ProgramState != ProgramState.Playing || Current.Game == null)
                            return "{\"error\": \"No live game to save — RimWorld is at the main menu or still loading.\"}";

                        string name = "RimAgentic_dev";
                        var dict = JsonConvert.DeserializeObject<Dictionary<string, object>>(args);
                        if (dict != null && dict.TryGetValue("name", out var nameVal) && nameVal != null)
                            name = SanitizeSaveName(nameVal.ToString()) ?? name;

                        GameDataSaveLoader.SaveGame(name);

                        return JsonConvert.SerializeObject(new
                        {
                            success = true,
                            name,
                            path = GenFilePaths.FilePathForSavedGame(name),
                            message = $"Saved game to slot '{name}'."
                        });
                    }
                    catch (Exception ex)
                    {
                        return $"{{\"error\": \"Failed to save game: {ex.Message}\"}}";
                    }
                }
            );

            // Tool: load_game — switch the running instance to a saved colony without relaunching.
            // (To resume from a cold launch instead, use launch_rimworld's loadSave / the autoload env var.)
            RegisterTool(
                "load_game",
                "Load a saved game by name (Saves/<name>.rws) into the running instance, replacing the current session. To resume from a fresh launch instead, use launch_rimworld's loadSave option.",
                new Dictionary<string, object>
                {
                    ["type"] = "object",
                    ["properties"] = new Dictionary<string, object>
                    {
                        ["name"] = new Dictionary<string, object>
                        {
                            ["type"] = "string",
                            ["description"] = "Name of the save to load, without extension."
                        }
                    },
                    ["required"] = new List<string> { "name" }
                },
                args =>
                {
                    try
                    {
                        string name = null;
                        var dict = JsonConvert.DeserializeObject<Dictionary<string, object>>(args);
                        if (dict != null && dict.TryGetValue("name", out var nameVal) && nameVal != null)
                            name = SanitizeSaveName(nameVal.ToString());

                        if (string.IsNullOrEmpty(name))
                            return "{\"error\": \"Missing 'name' argument.\"}";

                        if (!SaveGameFilesUtility.SavedGameNamedExists(name))
                            return $"{{\"error\": \"No save named '{name}' exists. List saves with list_rimworld_saves.\"}}";

                        // LoadGame queues its own long event; the tear-down of the current game then
                        // runs on subsequent frames, so we return immediately having only scheduled it.
                        GameDataSaveLoader.LoadGame(name);

                        return JsonConvert.SerializeObject(new
                        {
                            success = true,
                            name,
                            message = $"Loading save '{name}' — the current session is being replaced."
                        });
                    }
                    catch (Exception ex)
                    {
                        return $"{{\"error\": \"Failed to load game: {ex.Message}\"}}";
                    }
                }
            );
        }
    }
}
