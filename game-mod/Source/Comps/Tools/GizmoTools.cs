using System;
using System.Collections.Generic;
using System.Linq;
using HarmonyLib;
using Newtonsoft.Json;
using UnityEngine;
using Verse;

namespace RimAgentic
{
    /// <summary>
    /// Gizmo capture: record the on-screen rect of each command button (draft, attack, toggles,
    /// designators, …) as it draws, so a headless caller can locate and screenshot them.
    ///
    /// Gizmos are immediate-mode UI drawn by GizmoGridDrawer through Command.GizmoOnGUI — they are
    /// NOT windows, so get_open_windows can't see them and there's no rect to crop to otherwise.
    /// A Harmony prefix on Command.GizmoOnGUI stamps each one's rect into a per-frame buffer that
    /// get_gizmos reads back. Non-Command gizmos (sliders, mech power cells, and ability renderers
    /// that fully override GizmoOnGUI without calling base) are not recorded — Commands cover the
    /// standard command bar.
    ///
    /// Gizmos only draw while something selectable is selected, so select_thing_at is provided to
    /// summon them headlessly: select a thing → get_gizmos / capture_gizmo.
    /// </summary>
    internal struct GizmoRectRecord { public string label; public Rect rect; public Command cmd; }

    internal static class GizmoCapture
    {
        private const float GizmoHeight = 75f; // Verse.Gizmo standard height
        private static int _lastFrame = -1000;
        private static List<GizmoRectRecord> _current = new List<GizmoRectRecord>();
        private static List<GizmoRectRecord> _last = new List<GizmoRectRecord>();

        /// <summary>Append a command's rect for the current frame (clearing the buffer when the frame rolls over).</summary>
        public static void Record(Command cmd, Vector2 topLeft, float maxWidth)
        {
            int f = Time.frameCount;
            if (f != _lastFrame) { _last = _current; _current = new List<GizmoRectRecord>(); _lastFrame = f; }

            float w;
            try { w = cmd.GetWidth(maxWidth); } catch { w = GizmoHeight; }

            string label = null;
            try { label = cmd.Label; } catch { }
            if (string.IsNullOrEmpty(label)) { try { label = cmd.defaultLabel; } catch { } }
            if (string.IsNullOrEmpty(label)) label = cmd.GetType().Name;

            _current.Add(new GizmoRectRecord { label = label, rect = new Rect(topLeft.x, topLeft.y, w, GizmoHeight), cmd = cmd });
        }

        /// <summary>
        /// The gizmos drawn in the most recent frame. Returns empty when nothing has drawn for a few
        /// frames (i.e. the selection was cleared) rather than returning stale rects.
        /// </summary>
        public static List<GizmoRectRecord> Latest()
        {
            if (Time.frameCount - _lastFrame > 3) return new List<GizmoRectRecord>();
            return (_current != null && _current.Count > 0) ? _current : _last;
        }

        /// <summary>Find the most-recently-drawn gizmo whose label contains the query (case-insensitive).</summary>
        public static GizmoRectRecord? FindByLabel(string q)
        {
            if (string.IsNullOrEmpty(q)) return null;
            string ql = q.ToLowerInvariant();
            foreach (var r in Latest())
                if (!string.IsNullOrEmpty(r.label) && r.label.ToLowerInvariant().Contains(ql)) return r;
            return null;
        }
    }

    [HarmonyPatch(typeof(Command), nameof(Command.GizmoOnGUI))]
    internal static class Patch_Command_GizmoOnGUI
    {
        static void Prefix(Command __instance, Vector2 topLeft, float maxWidth)
        {
            try { GizmoCapture.Record(__instance, topLeft, maxWidth); } catch { }
        }
    }

    public static partial class SynapseToolRegistry
    {
        private static void RegisterGizmoTools()
        {
            // Tool: get_gizmos — read back the command buttons currently drawn for the selection.
            RegisterTool(
                "get_gizmos",
                "List the command buttons (gizmos) currently drawn on screen — the draft/attack/toggle/designator buttons that appear when a thing is selected — each with its label and on-screen rect (UI pixels). Also returns the bounding box of the whole gizmo bar and the UI screen dims (for crop scaling). Empty unless something with commands is selected (use select_thing_at first). Feeds capture_gizmo.",
                new Dictionary<string, object> { ["type"] = "object", ["properties"] = new Dictionary<string, object>() },
                args =>
                {
                    try
                    {
                        var list = GizmoCapture.Latest();
                        var gizmos = list.Select(g => new
                        {
                            label = g.label,
                            x = Mathf.RoundToInt(g.rect.x),
                            y = Mathf.RoundToInt(g.rect.y),
                            width = Mathf.RoundToInt(g.rect.width),
                            height = Mathf.RoundToInt(g.rect.height)
                        }).ToList();

                        object bounds = null;
                        if (list.Count > 0)
                        {
                            float minX = list.Min(g => g.rect.x), minY = list.Min(g => g.rect.y);
                            float maxX = list.Max(g => g.rect.xMax), maxY = list.Max(g => g.rect.yMax);
                            bounds = new { x = Mathf.RoundToInt(minX), y = Mathf.RoundToInt(minY), width = Mathf.RoundToInt(maxX - minX), height = Mathf.RoundToInt(maxY - minY) };
                        }

                        return JsonConvert.SerializeObject(new
                        {
                            success = true,
                            count = gizmos.Count,
                            screen = new { width = UI.screenWidth, height = UI.screenHeight },
                            bounds,
                            gizmos,
                            note = gizmos.Count == 0 ? "No gizmos drawn — select a pawn/building with commands first (select_thing_at)." : null
                        });
                    }
                    catch (Exception ex)
                    {
                        return $"{{\"error\": \"Failed to read gizmos: {ex.Message}\"}}";
                    }
                },
                isDebug: false, keywords: new List<string> { "gizmo", "command", "button", "draft", "attack", "toggle", "bar" }
            );

            // Tool: activate_gizmo — the "click". Fires a gizmo's behavior so its effect (toggle,
            // action, or the menu/dialog it opens) can then be read/verified. This is what turns
            // gizmo capture into gizmo *behavior* testing.
            RegisterTool(
                "activate_gizmo",
                "Trigger a gizmo (command button) as if clicked, by label substring — fires its behavior: toggles it, runs its action, or opens the menu/dialog it produces. Afterwards read the menu with read_float_menu (text) or screenshot it with capture_game_window. Select a thing first (select_thing_at); get_gizmos lists the labels. Changes game state.",
                new Dictionary<string, object>
                {
                    ["type"] = "object",
                    ["properties"] = new Dictionary<string, object>
                    {
                        ["label"] = new Dictionary<string, object> { ["type"] = "string", ["description"] = "Label substring of the gizmo to trigger (e.g. 'Set plant', 'Draft')." }
                    },
                    ["required"] = new List<string> { "label" }
                },
                args =>
                {
                    try
                    {
                        var d = JsonConvert.DeserializeObject<Dictionary<string, object>>(args);
                        string q = ArgStr(d, "label");
                        if (string.IsNullOrEmpty(q)) return "{\"error\": \"Missing 'label'.\"}";

                        var rec = GizmoCapture.FindByLabel(q);
                        if (rec == null)
                        {
                            var avail = string.Join(", ", GizmoCapture.Latest().Select(r => r.label));
                            return $"{{\"error\": \"No gizmo matching '{q}'. Currently drawn: {avail}. Select a thing (select_thing_at) so its gizmos draw.\"}}";
                        }
                        if (rec.Value.cmd == null) return "{\"error\": \"That gizmo is not an activatable Command.\"}";

                        // ProcessInput is the click path — runs the action / toggle, or adds the menu/
                        // dialog to the WindowStack. Runs on the main thread (bridge dispatch), so
                        // touching the WindowStack here is safe.
                        rec.Value.cmd.ProcessInput(new Event());

                        var fm = Find.WindowStack?.WindowOfType<FloatMenu>();
                        object menuOptions = null;
                        if (fm != null)
                        {
                            // A headless-opened float menu vanishes next frame because the cursor is
                            // "distant"; pin it open so read_float_menu / a screenshot can follow, and
                            // read its options now (same tick — guaranteed still open).
                            try { AccessTools.Field(typeof(FloatMenu), "vanishIfMouseDistant")?.SetValue(fm, false); } catch { }
                            try
                            {
                                var opts = AccessTools.Field(typeof(FloatMenu), "options")?.GetValue(fm) as List<FloatMenuOption>;
                                if (opts != null)
                                    menuOptions = opts.Select(o => new { label = SafeMenuLabel(o), disabled = SafeMenuDisabled(o) }).ToList();
                            }
                            catch { }
                        }

                        return JsonConvert.SerializeObject(new
                        {
                            success = true,
                            activated = rec.Value.label,
                            floatMenuOpen = fm != null,
                            menuOptions,
                            hint = fm != null
                                ? "A float menu opened (pinned open). Its options are in menuOptions; read_float_menu re-reads them, or capture_game_window window:'FloatMenu' screenshots it."
                                : "No float menu detected — the gizmo toggled/ran an action, or opened a custom dialog (check get_open_windows / capture_game_window)."
                        });
                    }
                    catch (Exception ex)
                    {
                        return $"{{\"error\": \"Failed to activate gizmo: {ex.Message}\"}}";
                    }
                },
                isDebug: false, keywords: new List<string> { "activate", "trigger", "click", "invoke", "gizmo", "command" }, isMutating: true
            );

            // Tool: select_thing_at — select a thing so its gizmos draw (and its inspect pane opens).
            RegisterTool(
                "select_thing_at",
                "Select a selectable thing at cell (x, z) — prefers a pawn — so its command buttons (gizmos) draw and its inspect pane opens, ready for get_gizmos / capture_gizmo / capture_game_window. Pass defName to disambiguate. This is the headless equivalent of clicking a thing.",
                new Dictionary<string, object>
                {
                    ["type"] = "object",
                    ["properties"] = new Dictionary<string, object>
                    {
                        ["x"] = new Dictionary<string, object> { ["type"] = "integer", ["description"] = "Cell X." },
                        ["z"] = new Dictionary<string, object> { ["type"] = "integer", ["description"] = "Cell Z." },
                        ["defName"] = new Dictionary<string, object> { ["type"] = "string", ["description"] = "Optional: only select a thing whose def matches this." }
                    },
                    ["required"] = new List<string> { "x", "z" }
                },
                args =>
                {
                    try
                    {
                        var err = RequireMapError();
                        if (err != null) return err;
                        var map = Find.CurrentMap;

                        var d = JsonConvert.DeserializeObject<Dictionary<string, object>>(args);
                        var cell = new IntVec3(ArgInt(d, "x", -1), 0, ArgInt(d, "z", -1));
                        if (!cell.InBounds(map)) return $"{{\"error\": \"Cell ({cell.x},{cell.z}) out of bounds.\"}}";
                        string only = ArgStr(d, "defName");

                        var things = cell.GetThingList(map)
                            .Where(t => t.def != null && t.def.selectable && (only == null || t.def.defName == only))
                            .ToList();
                        var pick = things.OfType<Pawn>().Cast<Thing>().FirstOrDefault() ?? things.FirstOrDefault();
                        if (pick == null) return $"{{\"error\": \"No selectable thing at ({cell.x},{cell.z}){(only != null ? $" matching '{only}'" : "")}.\"}}";

                        Find.Selector.ClearSelection();
                        Find.Selector.Select(pick, false, true);

                        return JsonConvert.SerializeObject(new
                        {
                            success = true,
                            selected = new { def = pick.def.defName, label = pick.Label, thingId = pick.ThingID },
                            hint = "Call get_gizmos to read its command buttons, or capture_gizmo to screenshot them."
                        });
                    }
                    catch (Exception ex)
                    {
                        return $"{{\"error\": \"Failed to select: {ex.Message}\"}}";
                    }
                },
                isDebug: false, keywords: new List<string> { "select", "click", "thing", "pawn", "selection" }
            );

            // Tool: clear_selection — deselect everything (hides the gizmo bar / inspect pane again).
            RegisterTool(
                "clear_selection",
                "Clear the current selection, so the inspect pane and gizmo bar close. Use between staged captures.",
                new Dictionary<string, object> { ["type"] = "object", ["properties"] = new Dictionary<string, object>() },
                args =>
                {
                    try { Find.Selector?.ClearSelection(); return "{\"success\": true}"; }
                    catch (Exception ex) { return $"{{\"error\": \"Failed to clear selection: {ex.Message}\"}}"; }
                },
                isDebug: false, keywords: new List<string> { "clear", "deselect", "selection" }
            );
        }
    }
}
