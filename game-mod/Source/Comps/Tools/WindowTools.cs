using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using UnityEngine;
using RimWorld;
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

                    // Report the UI-space screen dims too: window rects are in RimWorld UI pixels
                    // (physical pixels ÷ UI Scale), so a cropper can scale a rect to the captured
                    // image with (imageWidth / screen.width).
                    return JsonConvert.SerializeObject(new
                    {
                        count = list.Count,
                        screen = new { width = UI.screenWidth, height = UI.screenHeight },
                        windows = list
                    });
                }
            );

            // Tool: open_window — bring a menu up from code so it can be inspected/screenshotted
            // without mouse input (input injection doesn't reach RimWorld/Unity). The counterpart to
            // get_open_windows: open, confirm with get_open_windows, then capture_screen.
            RegisterTool(
                "open_window",
                "Open a RimWorld UI window from code so it can be inspected or screenshotted without mouse input. window: 'modsettings' (a mod's settings dialog — a real 'custom mod menu'), 'options' (game Options), or 'mods' (the mod list page). For modsettings, pass 'mod' to target a specific mod by settings-category / name / packageId; if omitted the first mod that exposes a settings window is used. Returns what opened and, for modsettings, every mod that has a settings window. Requires a live game (the bridge only runs then).",
                new Dictionary<string, object>
                {
                    ["type"] = "object",
                    ["properties"] = new Dictionary<string, object>
                    {
                        ["window"] = new Dictionary<string, object> { ["type"] = "string", ["description"] = "'modsettings' | 'options' | 'mods'. Default 'modsettings'." },
                        ["mod"] = new Dictionary<string, object> { ["type"] = "string", ["description"] = "For modsettings: target mod by settings-category, name, or packageId (substring, case-insensitive)." }
                    }
                },
                args =>
                {
                    try
                    {
                        var stack = Find.WindowStack;
                        if (stack == null) return "{\"error\": \"No WindowStack yet (UI not ready).\"}";

                        var d = JsonConvert.DeserializeObject<Dictionary<string, object>>(args);
                        string which = (ArgStr(d, "window") ?? "modsettings").ToLowerInvariant();

                        if (which == "options" || which == "settings")
                        {
                            stack.Add(new Dialog_Options());
                            return JsonConvert.SerializeObject(new { success = true, opened = "Dialog_Options" });
                        }
                        if (which == "mods" || which == "modlist" || which == "modsconfig")
                        {
                            stack.Add(new Page_ModsConfig());
                            return JsonConvert.SerializeObject(new { success = true, opened = "Page_ModsConfig" });
                        }

                        // modsettings (default) — a mod's own settings window is the truest "custom mod menu".
                        var withSettings = LoadedModManager.ModHandles
                            .Where(m => m != null && !string.IsNullOrEmpty(SafeSettingsCategory(m)))
                            .ToList();
                        var available = withSettings.Select(m => new
                        {
                            category = SafeSettingsCategory(m),
                            name = m.Content?.Name,
                            packageId = m.Content?.PackageId
                        }).ToList();

                        if (withSettings.Count == 0)
                        {
                            stack.Add(new Dialog_Options());
                            return JsonConvert.SerializeObject(new { success = true, opened = "Dialog_Options", note = "No loaded mod exposes a settings window; opened game Options instead.", modsWithSettings = available });
                        }

                        string want = ArgStr(d, "mod");
                        Mod target = null;
                        if (!string.IsNullOrEmpty(want))
                        {
                            string wl = want.ToLowerInvariant();
                            target = withSettings.FirstOrDefault(m =>
                                (SafeSettingsCategory(m)?.ToLowerInvariant().Contains(wl) ?? false) ||
                                (m.Content?.Name?.ToLowerInvariant().Contains(wl) ?? false) ||
                                (m.Content?.PackageId?.ToLowerInvariant().Contains(wl) ?? false));
                        }
                        if (target == null) target = withSettings[0];

                        stack.Add(new Dialog_ModSettings(target));
                        return JsonConvert.SerializeObject(new
                        {
                            success = true,
                            opened = "Dialog_ModSettings",
                            mod = new { category = SafeSettingsCategory(target), name = target.Content?.Name, packageId = target.Content?.PackageId },
                            modsWithSettings = available
                        });
                    }
                    catch (Exception ex)
                    {
                        return $"{{\"error\": \"Failed to open window: {ex.Message}\"}}";
                    }
                },
                isDebug: false, keywords: new List<string> { "open", "window", "menu", "dialog", "settings", "mods", "options", "screenshot", "capture" }
            );

            // Tool: read_float_menu — read the text options of an open float menu (what a gizmo or
            // right-click produces). The headless way to verify a menu's contents without OCR.
            RegisterTool(
                "read_float_menu",
                "Read the text options of the float menu currently open — the menu a gizmo (activate_gizmo) or right-click produces — returning each option's label and disabled state, plus the count. found:false if no float menu is open (a gizmo may have opened a custom dialog instead — screenshot that with capture_game_window). Use to verify what options a gizmo's menu offers.",
                new Dictionary<string, object> { ["type"] = "object", ["properties"] = new Dictionary<string, object>() },
                args =>
                {
                    try
                    {
                        var fm = Find.WindowStack?.WindowOfType<FloatMenu>();
                        if (fm == null)
                            return JsonConvert.SerializeObject(new { success = true, found = false, note = "No float menu open. If a gizmo opened a dialog instead, screenshot it with capture_game_window." });

                        var optsField = AccessTools.Field(typeof(FloatMenu), "options");
                        var opts = optsField?.GetValue(fm) as List<FloatMenuOption>;
                        var options = (opts ?? new List<FloatMenuOption>()).Select(o => new
                        {
                            label = SafeMenuLabel(o),
                            disabled = SafeMenuDisabled(o)
                        }).ToList();

                        return JsonConvert.SerializeObject(new { success = true, found = true, count = options.Count, options });
                    }
                    catch (Exception ex)
                    {
                        return $"{{\"error\": \"Failed to read float menu: {ex.Message}\"}}";
                    }
                },
                isDebug: false, keywords: new List<string> { "float", "menu", "options", "read", "contents", "dropdown", "choices" }
            );
        }

        private static string SafeMenuLabel(FloatMenuOption o) { try { return o?.Label; } catch { return null; } }
        private static bool SafeMenuDisabled(FloatMenuOption o) { try { return o?.Disabled ?? false; } catch { return false; } }

        /// <summary>Mod.SettingsCategory() can throw in a badly-behaved mod; never let that sink the enumeration.</summary>
        private static string SafeSettingsCategory(Mod m)
        {
            try { return m.SettingsCategory(); } catch { return null; }
        }
    }
}
