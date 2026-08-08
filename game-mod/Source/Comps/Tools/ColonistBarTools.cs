using System;
using System.Collections.Generic;
using System.Linq;
using HarmonyLib;
using Newtonsoft.Json;
using RimWorld;
using UnityEngine;
using Verse;

namespace RimAgentic
{
    /// <summary>
    /// Colonist-bar capture: record the on-screen rect of each colonist portrait at the top of the
    /// screen, so a headless caller can locate and crop the bar (or a single pawn).
    ///
    /// Like gizmos, the colonist bar is immediate-mode UI (ColonistBarColonistDrawer), not a window,
    /// so there's no rect to crop to otherwise. A Harmony prefix on DrawColonist — which is handed the
    /// exact draw rect per pawn — stamps each into a per-frame buffer that get_colonist_bar reads
    /// back. Unlike gizmos, the bar draws whenever colonists exist, so no selection is required.
    /// </summary>
    internal struct BarEntryRecord { public string label; public Rect rect; }

    internal static class ColonistBarCapture
    {
        private static int _lastFrame = -1000;
        private static List<BarEntryRecord> _current = new List<BarEntryRecord>();
        private static List<BarEntryRecord> _last = new List<BarEntryRecord>();

        public static void Record(string label, Rect rect)
        {
            int f = Time.frameCount;
            if (f != _lastFrame) { _last = _current; _current = new List<BarEntryRecord>(); _lastFrame = f; }
            _current.Add(new BarEntryRecord { label = label, rect = rect });
        }

        /// <summary>Entries drawn in the most recent frame; empty when the bar hasn't drawn for a few frames.</summary>
        public static List<BarEntryRecord> Latest()
        {
            if (Time.frameCount - _lastFrame > 3) return new List<BarEntryRecord>();
            return (_current != null && _current.Count > 0) ? _current : _last;
        }
    }

    // DrawColonist(Rect rect, Pawn colonist, Map pawnMap, bool highlight, bool reordering) — the rect
    // arg is the portrait's on-screen rect. Argument types are pinned so PatchAll never trips on an
    // overload.
    [HarmonyPatch(typeof(ColonistBarColonistDrawer), "DrawColonist",
        new Type[] { typeof(Rect), typeof(Pawn), typeof(Map), typeof(bool), typeof(bool) })]
    internal static class Patch_ColonistBarColonistDrawer_DrawColonist
    {
        static void Prefix(Rect rect, Pawn colonist)
        {
            try
            {
                string label = null;
                try { label = colonist?.LabelShortCap; } catch { }
                if (string.IsNullOrEmpty(label)) { try { label = colonist?.LabelCap; } catch { } }
                if (string.IsNullOrEmpty(label)) label = colonist?.ThingID ?? "pawn";
                ColonistBarCapture.Record(label, rect);
            }
            catch { }
        }
    }

    public static partial class SynapseToolRegistry
    {
        private static void RegisterColonistBarTools()
        {
            RegisterTool(
                "get_colonist_bar",
                "List the colonist bar entries drawn at the top of the screen, each with its pawn label and on-screen rect (UI pixels), plus the bar's bounding box and UI screen dims (for crop scaling). The bar draws whenever colonists exist — no selection needed. Feeds capture_colonist_bar.",
                new Dictionary<string, object> { ["type"] = "object", ["properties"] = new Dictionary<string, object>() },
                args =>
                {
                    try
                    {
                        var list = ColonistBarCapture.Latest();
                        var entries = list.Select(e => new
                        {
                            label = e.label,
                            x = Mathf.RoundToInt(e.rect.x),
                            y = Mathf.RoundToInt(e.rect.y),
                            width = Mathf.RoundToInt(e.rect.width),
                            height = Mathf.RoundToInt(e.rect.height)
                        }).ToList();

                        object bounds = null;
                        if (list.Count > 0)
                        {
                            float minX = list.Min(e => e.rect.x), minY = list.Min(e => e.rect.y);
                            float maxX = list.Max(e => e.rect.xMax), maxY = list.Max(e => e.rect.yMax);
                            bounds = new { x = Mathf.RoundToInt(minX), y = Mathf.RoundToInt(minY), width = Mathf.RoundToInt(maxX - minX), height = Mathf.RoundToInt(maxY - minY) };
                        }

                        return JsonConvert.SerializeObject(new
                        {
                            success = true,
                            count = entries.Count,
                            screen = new { width = UI.screenWidth, height = UI.screenHeight },
                            bounds,
                            entries,
                            note = entries.Count == 0 ? "No colonist bar drawn — are there colonists, and is the bar enabled (Options > show colonist bar)?" : null
                        });
                    }
                    catch (Exception ex)
                    {
                        return $"{{\"error\": \"Failed to read colonist bar: {ex.Message}\"}}";
                    }
                },
                isDebug: false, keywords: new List<string> { "colonist", "bar", "portrait", "pawn", "top" }
            );
        }
    }
}
