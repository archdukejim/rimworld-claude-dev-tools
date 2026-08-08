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
    internal struct GizmoRectRecord { public string label; public Rect rect; }

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

            _current.Add(new GizmoRectRecord { label = label, rect = new Rect(topLeft.x, topLeft.y, w, GizmoHeight) });
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
