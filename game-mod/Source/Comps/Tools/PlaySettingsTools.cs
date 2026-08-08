using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using HarmonyLib;
using Newtonsoft.Json;
using RimWorld;
using UnityEngine;
using Verse;

namespace RimAgentic
{
    /// <summary>
    /// Play-settings / map-overlay toggle capture: the bottom-right toggle buttons (roof, fertility,
    /// zones, beauty, terrain-affordance overlays, auto-home, and any mod-added toggles).
    ///
    /// These are immediate-mode toggles drawn by PlaySettings.DoPlaySettingsGlobalControls via
    /// WidgetRow.ToggleableIcon(ref bool, ...) — not windows, not gizmos. A Harmony prefix on
    /// ToggleableIcon does double duty: it records each toggle's rect + tooltip + current state, and,
    /// because the backing bool is passed BY REF, it can flip that bool on request — so the same hook
    /// both exposes and toggles every button, vanilla or mod, without knowing the underlying field.
    ///
    /// Only the bottom-right cluster is captured (region-gated) so unrelated WidgetRow toggles
    /// elsewhere in the UI aren't swept in.
    /// </summary>
    internal struct ToggleRecord { public string label; public Rect rect; public bool value; }

    internal static class PlaySettingsCapture
    {
        private static int _lastFrame = -1000;
        private static List<ToggleRecord> _current = new List<ToggleRecord>();
        private static List<ToggleRecord> _last = new List<ToggleRecord>();

        // A queued toggle: applied by the ToggleableIcon prefix on the next matching draw.
        public static string PendingLabel;
        public static bool? PendingState;
        public static string LastToggled;

        public static void Record(string label, Rect rect, bool value)
        {
            int f = Time.frameCount;
            if (f != _lastFrame) { _last = _current; _current = new List<ToggleRecord>(); _lastFrame = f; }
            _current.Add(new ToggleRecord { label = label, rect = rect, value = value });
        }

        public static List<ToggleRecord> Latest()
        {
            if (Time.frameCount - _lastFrame > 3) return new List<ToggleRecord>();
            return (_current != null && _current.Count > 0) ? _current : _last;
        }
    }

    [HarmonyPatch(typeof(WidgetRow), nameof(WidgetRow.ToggleableIcon),
        new Type[] { typeof(bool), typeof(Texture2D), typeof(string), typeof(SoundDef), typeof(string) },
        new ArgumentType[] { ArgumentType.Ref, ArgumentType.Normal, ArgumentType.Normal, ArgumentType.Normal, ArgumentType.Normal })]
    internal static class Patch_WidgetRow_ToggleableIcon
    {
        private static readonly FieldInfo fCurX = AccessTools.Field(typeof(WidgetRow), "curX");
        private static readonly FieldInfo fCurY = AccessTools.Field(typeof(WidgetRow), "curY");
        private static readonly FieldInfo fGrow = AccessTools.Field(typeof(WidgetRow), "growDirection");

        static void Prefix(WidgetRow __instance, ref bool toggleable, string tooltip)
        {
            try
            {
                // Reconstruct the icon rect from the row cursor (WidgetRow.LeftX logic): 24x24.
                float size = WidgetRow.IconSize;
                float curX = fCurX != null ? (float)fCurX.GetValue(__instance) : 0f;
                float curY = fCurY != null ? (float)fCurY.GetValue(__instance) : 0f;
                bool rightward = fGrow == null || fGrow.GetValue(__instance).ToString().Contains("Right");
                float x = rightward ? curX : curX - size;
                var rect = new Rect(x, curY, size, size);

                // The play-settings cluster is the bottom-right corner: three rows spanning roughly
                // the bottom ~130px and the right ~40% of the screen. This excludes unrelated
                // ToggleableIcon uses like the dev palette toggle at top-left.
                if (rect.y < UI.screenHeight - 130f) return;
                if (rect.x < UI.screenWidth * 0.6f) return;

                // Apply a queued toggle whose label matches this button's tooltip. Because toggleable
                // is a ref to the real backing field, writing it here flips the actual setting.
                if (!string.IsNullOrEmpty(PlaySettingsCapture.PendingLabel) && !string.IsNullOrEmpty(tooltip)
                    && tooltip.ToLowerInvariant().Contains(PlaySettingsCapture.PendingLabel))
                {
                    toggleable = PlaySettingsCapture.PendingState ?? !toggleable;
                    PlaySettingsCapture.LastToggled = tooltip;
                    PlaySettingsCapture.PendingLabel = null;
                    PlaySettingsCapture.PendingState = null;
                }

                // Store just the first line of the tooltip as the label — the rest is a description.
                string disp = tooltip;
                if (!string.IsNullOrEmpty(disp))
                {
                    int nl = disp.IndexOf('\n');
                    if (nl > 0) disp = disp.Substring(0, nl);
                }
                PlaySettingsCapture.Record(disp, rect, toggleable);
            }
            catch { }
        }
    }

    public static partial class SynapseToolRegistry
    {
        private static void RegisterPlaySettingsTools()
        {
            RegisterTool(
                "get_play_settings",
                "List the map-overlay / play-settings toggle buttons at the bottom-right (roof, fertility, zones, beauty, terrain overlays, auto-home, etc. — including mod-added ones), each with its tooltip label, on-screen rect, and current on/off state, plus the row's bounding box and UI screen dims. Requires a live map view (not the world map). Feeds capture_play_settings and set_play_setting.",
                new Dictionary<string, object> { ["type"] = "object", ["properties"] = new Dictionary<string, object>() },
                args =>
                {
                    try
                    {
                        var list = PlaySettingsCapture.Latest();
                        var toggles = list.Select(t => new
                        {
                            label = t.label,
                            on = t.value,
                            x = Mathf.RoundToInt(t.rect.x),
                            y = Mathf.RoundToInt(t.rect.y),
                            width = Mathf.RoundToInt(t.rect.width),
                            height = Mathf.RoundToInt(t.rect.height)
                        }).ToList();

                        object bounds = null;
                        if (list.Count > 0)
                        {
                            float minX = list.Min(t => t.rect.x), minY = list.Min(t => t.rect.y);
                            float maxX = list.Max(t => t.rect.xMax), maxY = list.Max(t => t.rect.yMax);
                            bounds = new { x = Mathf.RoundToInt(minX), y = Mathf.RoundToInt(minY), width = Mathf.RoundToInt(maxX - minX), height = Mathf.RoundToInt(maxY - minY) };
                        }

                        return JsonConvert.SerializeObject(new
                        {
                            success = true,
                            count = toggles.Count,
                            screen = new { width = UI.screenWidth, height = UI.screenHeight },
                            bounds,
                            toggles,
                            note = toggles.Count == 0 ? "No play-settings toggles captured — need a live map view (they don't draw on the world map)." : null
                        });
                    }
                    catch (Exception ex)
                    {
                        return $"{{\"error\": \"Failed to read play settings: {ex.Message}\"}}";
                    }
                },
                isDebug: false, keywords: new List<string> { "play", "settings", "overlay", "toggle", "roof", "fertility", "zones", "beauty", "map" }
            );

            RegisterTool(
                "set_play_setting",
                "Toggle a map-overlay / play-settings button by tooltip-label substring (e.g. 'roof', 'fertility', 'zones', 'beauty'). Omit 'on' to flip it, or pass on:true/false to force a state. Works on vanilla and mod-added toggles (it flips the button's backing bool as it next draws). Takes effect on the next frame — confirm with get_play_settings. Changes view state.",
                new Dictionary<string, object>
                {
                    ["type"] = "object",
                    ["properties"] = new Dictionary<string, object>
                    {
                        ["label"] = new Dictionary<string, object> { ["type"] = "string", ["description"] = "Tooltip-label substring of the toggle (e.g. 'roof', 'fertility')." },
                        ["on"] = new Dictionary<string, object> { ["type"] = "boolean", ["description"] = "Desired state; omit to flip." }
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

                        bool? on = null;
                        if (d != null && d.TryGetValue("on", out var v) && v != null)
                        {
                            try { on = Convert.ToBoolean(v); } catch { on = v.ToString().ToLowerInvariant() == "true"; }
                        }

                        // Confirm the label matches a currently-drawn toggle so we can give a useful error.
                        var known = PlaySettingsCapture.Latest();
                        if (known.Count > 0 && !known.Any(t => !string.IsNullOrEmpty(t.label) && t.label.ToLowerInvariant().Contains(q.ToLowerInvariant())))
                        {
                            var labels = string.Join(", ", known.Select(t => t.label));
                            return $"{{\"error\": \"No play-settings toggle matching '{q}'. Available: {labels}.\"}}";
                        }

                        PlaySettingsCapture.PendingLabel = q.ToLowerInvariant();
                        PlaySettingsCapture.PendingState = on;
                        return JsonConvert.SerializeObject(new
                        {
                            success = true,
                            queued = q,
                            desired = on.HasValue ? (on.Value ? "on" : "off") : "flip",
                            note = "Applied on the next drawn frame; call get_play_settings to confirm the new state."
                        });
                    }
                    catch (Exception ex)
                    {
                        return $"{{\"error\": \"Failed to set play setting: {ex.Message}\"}}";
                    }
                },
                isDebug: false, keywords: new List<string> { "toggle", "overlay", "roof", "fertility", "zones", "set", "play", "setting" }, isMutating: true
            );
        }
    }
}
