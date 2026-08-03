using System.Collections.Generic;
using System.Reflection;
using UnityEngine;
using Verse;
using HarmonyLib;
using Newtonsoft.Json;

namespace RimAgentic
{
    /// <summary>
    /// Tool handler: get_open_windows
    /// Maps RimWorld's live UI by reading Find.WindowStack — which windows are open, their C#
    /// type, id, layer and on-screen rect. Structural window mapping through the game itself,
    /// rather than screenshotting and guessing at pixels.
    /// </summary>
    public static partial class SynapseToolRegistry
    {
        // WindowStack keeps its list in a private field; read it once via reflection.
        private static readonly FieldInfo WindowsField = AccessTools.Field(typeof(WindowStack), "windows");

        private static void RegisterWindowTools()
        {
            RegisterTool(
                "get_open_windows",
                "List the RimWorld UI windows currently open (dialogs, menus, main-tab windows), each " +
                "with its C# type, id, layer, and on-screen rect (x, y, width, height in UI pixels). Use " +
                "this to map what UI is on screen — e.g. confirm a menu opened, find a window's position " +
                "before interacting, or see which dialog is in front. Reads the game's own window stack.",
                new Dictionary<string, object>
                {
                    ["type"] = "object",
                    ["properties"] = new Dictionary<string, object>()
                },
                args =>
                {
                    var stack = Find.WindowStack;
                    if (stack == null) return "{\"error\": \"No WindowStack yet (UI not ready).\"}";

                    List<Window> windows = null;
                    try { windows = WindowsField != null ? WindowsField.GetValue(stack) as List<Window> : null; }
                    catch { }
                    if (windows == null) return "{\"error\": \"Could not read the window list from WindowStack.\"}";

                    var list = new List<object>();
                    foreach (var w in windows)
                    {
                        if (w == null) continue;
                        Rect r = w.windowRect;
                        list.Add(new
                        {
                            type = w.GetType().Name,
                            fullType = w.GetType().FullName,
                            id = w.ID,
                            layer = w.layer.ToString(),
                            rect = new
                            {
                                x = Mathf.RoundToInt(r.x),
                                y = Mathf.RoundToInt(r.y),
                                width = Mathf.RoundToInt(r.width),
                                height = Mathf.RoundToInt(r.height)
                            }
                        });
                    }

                    return JsonConvert.SerializeObject(new { count = list.Count, windows = list });
                }
            );
        }
    }
}
