using System;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;
using Verse;
using HarmonyLib;
using Newtonsoft.Json;

namespace RimAgentic
{
    /// <summary>
    /// Makes RimWorld windows self-describing. RimWorld's UI is immediate-mode: a dialog's buttons
    /// are not retained objects — each frame the window's DoWindowContents redraws them via
    /// Widgets.ButtonText(rect, label). There is nothing to query. So we record every control as it
    /// is drawn (Harmony postfixes on the Widgets draw methods), bracketed per-window by a patch on
    /// Window.InnerWindowOnGUI. read_window then returns the last-drawn snapshot of the topmost
    /// window's controls; invoke_window_control "clicks" one by forcing its button to register a
    /// press on the next draw frame (IMGUI-native — no pixel math).
    ///
    /// All access is on the main thread: the Widgets postfixes run in OnGUI and the bridge tool
    /// handlers run in GameComponentUpdate (Update) — same thread, different phase of the same frame,
    /// so the tool reads the previous frame's completed snapshot with no locking needed.
    /// </summary>
    internal static class UiCapture
    {
        internal sealed class Ctl
        {
            public string kind;     // button | checkbox | radio | imagebutton | label
            public string label;
            public float x, y, w, h;
            public bool on;         // checkbox/radio state
            public bool disabled;
        }
        internal sealed class Snapshot
        {
            public string type;
            public int id;
            public List<Ctl> controls = new List<Ctl>();
            public int frame;
        }

        // Per-window build context, stacked to survive any (rare) nested window draw.
        private sealed class BuildCtx { public Window window; public List<Ctl> controls = new List<Ctl>(); public int buttonIndex; }
        private static readonly Stack<BuildCtx> _stack = new Stack<BuildCtx>();
        private static readonly Dictionary<int, Snapshot> _last = new Dictionary<int, Snapshot>();
        private const int MaxControlsPerWindow = 600;

        // Pending "click" queued by invoke_window_control, consumed on the next matching draw.
        private static bool _pendActive;
        private static string _pendWindowType;   // null => topmost window that draws
        private static string _pendLabel;        // match a button/radio by label (case-insensitive)
        private static int _pendIndex = -1;       // or by button index within the window
        private static bool _pendConsumed;

        internal static void Begin(Window w)
        {
            _stack.Push(new BuildCtx { window = w });
        }

        internal static void End(Window w)
        {
            if (_stack.Count == 0) return;
            var ctx = _stack.Pop();
            if (ctx.window != w) { /* mismatch — bail rather than commit wrong data */ return; }
            _last[w.ID] = new Snapshot { type = w.GetType().Name, id = w.ID, controls = ctx.controls, frame = Time.frameCount };
        }

        private static BuildCtx Cur => _stack.Count > 0 ? _stack.Peek() : null;

        private static bool WindowMatchesPending(Window w)
        {
            if (!_pendActive) return false;
            if (string.IsNullOrEmpty(_pendWindowType))
            {
                // Topmost window only: the last (front-most) window in the stack.
                var top = Find.WindowStack?.Windows?.LastOrDefault();
                return top == null || top == w;
            }
            return w.GetType().Name.IndexOf(_pendWindowType, StringComparison.OrdinalIgnoreCase) >= 0;
        }

        /// <summary>Record a clickable text/radio control; returns true if this call should register a click.</summary>
        internal static bool RecordClickable(string kind, Rect rect, string label, bool on = false, bool disabled = false)
        {
            var ctx = Cur;
            if (ctx == null) return false;
            int idx = ctx.buttonIndex++;
            if (ctx.controls.Count < MaxControlsPerWindow)
                ctx.controls.Add(new Ctl { kind = kind, label = label ?? "", x = rect.x, y = rect.y, w = rect.width, h = rect.height, on = on, disabled = disabled });

            if (_pendActive && !disabled && WindowMatchesPending(ctx.window))
            {
                bool labelHit = !string.IsNullOrEmpty(_pendLabel) && !string.IsNullOrEmpty(label)
                                && string.Equals(label.Trim(), _pendLabel.Trim(), StringComparison.OrdinalIgnoreCase);
                bool indexHit = _pendIndex >= 0 && idx == _pendIndex;
                if (labelHit || indexHit)
                {
                    _pendActive = false;
                    _pendConsumed = true;
                    return true;
                }
            }
            return false;
        }

        internal static void RecordStatic(string kind, Rect rect, string label, bool on = false, bool disabled = false)
        {
            var ctx = Cur;
            if (ctx == null) return;
            if (ctx.controls.Count < MaxControlsPerWindow)
                ctx.controls.Add(new Ctl { kind = kind, label = label ?? "", x = rect.x, y = rect.y, w = rect.width, h = rect.height, on = on, disabled = disabled });
        }

        /// <summary>
        /// The window whose contents read_window returns. With windowType, the topmost window whose
        /// C#-type contains that substring. Without it, prefer the topmost REAL interactive dialog
        /// over transient overlays: the learning helper, tutor, and messages are ImmediateWindows
        /// drawn on top, and picking those (the original bug) hid the dialog the caller actually opened.
        /// </summary>
        internal static Snapshot Topmost(string windowType)
        {
            var stack = Find.WindowStack?.Windows;
            if (stack == null) return null;

            if (!string.IsNullOrEmpty(windowType))
            {
                for (int i = stack.Count - 1; i >= 0; i--)
                {
                    var w = stack[i];
                    if (w == null) continue;
                    if (w.GetType().Name.IndexOf(windowType, StringComparison.OrdinalIgnoreCase) < 0) continue;
                    if (_last.TryGetValue(w.ID, out var snap)) return snap;
                }
                return null;
            }

            Snapshot topmostAny = null;
            Snapshot topmostNonTrivial = null;
            for (int i = stack.Count - 1; i >= 0; i--)
            {
                var w = stack[i];
                if (w == null || !_last.TryGetValue(w.ID, out var snap)) continue;
                if (topmostAny == null) topmostAny = snap;

                bool isImmediate = w.GetType().Name == "ImmediateWindow";
                if (!isImmediate && topmostNonTrivial == null) topmostNonTrivial = snap;

                // A modal-ish dialog (absorbs surrounding input, or has an explicit close control)
                // is almost always the thing the caller wants — return the first one, top-first.
                if (!isImmediate && (w.absorbInputAroundWindow || w.doCloseButton || w.doCloseX)) return snap;
            }
            return topmostNonTrivial ?? topmostAny;
        }

        internal static void QueueClick(string windowType, string label, int index)
        {
            _pendWindowType = windowType;
            _pendLabel = label;
            _pendIndex = index;
            _pendActive = true;
            _pendConsumed = false;
        }

        internal static bool LastClickConsumed => _pendConsumed;
        internal static bool PendingActive => _pendActive;
    }

    // --- Harmony capture patches (auto-applied by ToolkitMod's PatchAll) --------------------------

    [HarmonyPatch(typeof(Window), "InnerWindowOnGUI")]
    internal static class Patch_Window_InnerWindowOnGUI
    {
        static void Prefix(Window __instance) { try { UiCapture.Begin(__instance); } catch { } }
        static void Postfix(Window __instance) { try { UiCapture.End(__instance); } catch { } }
    }

    [HarmonyPatch(typeof(Widgets), nameof(Widgets.ButtonText),
        new[] { typeof(Rect), typeof(string), typeof(bool), typeof(bool), typeof(Color), typeof(bool), typeof(TextAnchor?) })]
    internal static class Patch_Widgets_ButtonText
    {
        static void Postfix(Rect rect, string label, bool active, ref bool __result)
        {
            try { if (UiCapture.RecordClickable("button", rect, label, disabled: !active)) __result = true; } catch { }
        }
    }

    [HarmonyPatch(typeof(Widgets), nameof(Widgets.RadioButtonLabeled))]
    internal static class Patch_Widgets_RadioButtonLabeled
    {
        static void Postfix(Rect rect, string labelText, bool chosen, bool disabled, ref bool __result)
        {
            try { if (UiCapture.RecordClickable("radio", rect, labelText, on: chosen, disabled: disabled)) __result = true; } catch { }
        }
    }

    [HarmonyPatch(typeof(Widgets), nameof(Widgets.CheckboxLabeled))]
    internal static class Patch_Widgets_CheckboxLabeled
    {
        static void Postfix(Rect rect, string label, bool checkOn, bool disabled)
        {
            try { UiCapture.RecordStatic("checkbox", rect, label, on: checkOn, disabled: disabled); } catch { }
        }
    }

    [HarmonyPatch(typeof(Widgets), nameof(Widgets.ButtonImage),
        new[] { typeof(Rect), typeof(Texture2D), typeof(bool), typeof(string) })]
    internal static class Patch_Widgets_ButtonImage
    {
        static void Postfix(Rect butRect, string tooltip, ref bool __result)
        {
            try { if (UiCapture.RecordClickable("imagebutton", butRect, tooltip)) __result = true; } catch { }
        }
    }

    [HarmonyPatch(typeof(Widgets), nameof(Widgets.Label), new[] { typeof(Rect), typeof(string) })]
    internal static class Patch_Widgets_Label_String
    {
        static void Postfix(Rect rect, string label) { try { UiCapture.RecordStatic("label", rect, label); } catch { } }
    }

    [HarmonyPatch(typeof(Widgets), nameof(Widgets.Label), new[] { typeof(Rect), typeof(TaggedString) })]
    internal static class Patch_Widgets_Label_Tagged
    {
        static void Postfix(Rect rect, TaggedString label) { try { UiCapture.RecordStatic("label", rect, label.ToString()); } catch { } }
    }

    // --- Bridge tools ---------------------------------------------------------------------------

    public static partial class SynapseToolRegistry
    {
        internal static void RegisterWindowContentTools()
        {
            RegisterTool(
                "read_window",
                "Read the CONTENTS of the topmost open window — its buttons, checkboxes, radios, and text labels as actually drawn this frame (immediate-mode UI captured live). Each control has a label, a 0-based 'index' (buttons only), on/off state (checkboxes/radios), disabled flag, and UI-pixel rect. Optional 'windowType' substring picks a specific window instead of the frontmost. found:false if no window has drawn yet. Pair with invoke_window_control to press a button by label or index without pixel coordinates.",
                new Dictionary<string, object>
                {
                    ["type"] = "object",
                    ["properties"] = new Dictionary<string, object>
                    {
                        ["windowType"] = new Dictionary<string, string> { ["type"] = "string", ["description"] = "Optional C#-type substring to target a specific window (e.g. 'Options', 'ModSettings'). Default: the frontmost window." }
                    }
                },
                args => ReadWindow(args),
                isDebug: false,
                keywords: new List<string> { "window", "dialog", "buttons", "contents", "read", "controls", "menu", "options" }
            );

            RegisterTool(
                "invoke_window_control",
                "Press a control in the topmost window by 'label' (case-insensitive) or 0-based button 'index' from read_window — no pixel coordinates needed. It registers the click on the next draw frame (IMGUI-native). Optional 'windowType' targets a specific window. Returns queued:true; re-read the window (or just issue your next command — window-changing commands auto-attach the new window state) to see the effect.",
                new Dictionary<string, object>
                {
                    ["type"] = "object",
                    ["properties"] = new Dictionary<string, object>
                    {
                        ["label"] = new Dictionary<string, string> { ["type"] = "string", ["description"] = "Button/radio label to press (case-insensitive)." },
                        ["index"] = new Dictionary<string, string> { ["type"] = "integer", ["description"] = "0-based button index (from read_window) to press instead of by label." },
                        ["windowType"] = new Dictionary<string, string> { ["type"] = "string", ["description"] = "Optional window C#-type substring to target." }
                    }
                },
                args => InvokeWindowControl(args),
                false,  // visible
                null,   // keywords
                true    // isMutating
            );
        }

        private static string ReadWindow(string argsJson)
        {
            try
            {
                string windowType = null;
                if (!string.IsNullOrEmpty(argsJson))
                {
                    var jo = Newtonsoft.Json.Linq.JObject.Parse(argsJson);
                    windowType = jo.Value<string>("windowType");
                }
                var snap = UiCapture.Topmost(windowType);
                if (snap == null)
                    return JsonConvert.SerializeObject(new Dictionary<string, object> { ["found"] = false, ["reason"] = "No open window has drawn a capturable frame yet." });

                var buttons = new List<object>();
                int bi = 0;
                var checkboxes = new List<object>();
                var radios = new List<object>();
                var labels = new List<string>();
                foreach (var c in snap.controls)
                {
                    var rect = new { x = c.x, y = c.y, width = c.w, height = c.h, centerX = c.x + c.w / 2f, centerY = c.y + c.h / 2f };
                    switch (c.kind)
                    {
                        case "button":
                        case "imagebutton":
                            buttons.Add(new { index = bi++, label = c.label, kind = c.kind, disabled = c.disabled, rect });
                            break;
                        case "checkbox":
                            checkboxes.Add(new { label = c.label, on = c.on, disabled = c.disabled, rect });
                            break;
                        case "radio":
                            radios.Add(new { label = c.label, on = c.on, disabled = c.disabled, rect });
                            break;
                        case "label":
                            if (!string.IsNullOrWhiteSpace(c.label)) labels.Add(c.label.Trim());
                            break;
                    }
                }

                return JsonConvert.SerializeObject(new Dictionary<string, object>
                {
                    ["found"] = true,
                    ["type"] = snap.type,
                    ["id"] = snap.id,
                    ["buttons"] = buttons,
                    ["checkboxes"] = checkboxes,
                    ["radios"] = radios,
                    ["labels"] = labels.Distinct().Take(120).ToList(),
                    ["counts"] = new Dictionary<string, int> { ["buttons"] = buttons.Count, ["checkboxes"] = checkboxes.Count, ["radios"] = radios.Count, ["labels"] = labels.Count }
                });
            }
            catch (Exception ex)
            {
                return $"{{\"error\": \"read_window failed: {ex.Message}\"}}";
            }
        }

        private static string InvokeWindowControl(string argsJson)
        {
            try
            {
                if (string.IsNullOrEmpty(argsJson)) return "{\"success\": false, \"reason\": \"Provide 'label' or 'index'.\"}";
                var jo = Newtonsoft.Json.Linq.JObject.Parse(argsJson);
                string label = jo.Value<string>("label");
                int? index = jo.Value<int?>("index");
                string windowType = jo.Value<string>("windowType");
                if (string.IsNullOrWhiteSpace(label) && index == null)
                    return "{\"success\": false, \"reason\": \"Provide 'label' or 'index'.\"}";

                // Validate against the current snapshot so we can fail fast on a bad label/index.
                var snap = UiCapture.Topmost(windowType);
                if (snap == null) return "{\"success\": false, \"reason\": \"No window snapshot to target; call read_window first.\"}";
                var btnLabels = snap.controls.Where(c => c.kind == "button" || c.kind == "imagebutton" || c.kind == "radio").ToList();
                if (!string.IsNullOrWhiteSpace(label) && !btnLabels.Any(c => string.Equals((c.label ?? "").Trim(), label.Trim(), StringComparison.OrdinalIgnoreCase)))
                    return JsonConvert.SerializeObject(new Dictionary<string, object> { ["success"] = false, ["reason"] = $"No pressable control labelled '{label}' in window '{snap.type}'.", ["available"] = btnLabels.Select(c => c.label).ToList() });
                if (index != null && (index < 0 || index >= btnLabels.Count(c => c.kind == "button" || c.kind == "imagebutton")))
                    return $"{{\"success\": false, \"reason\": \"Button index {index} out of range.\"}}";

                UiCapture.QueueClick(windowType, label, index ?? -1);
                return JsonConvert.SerializeObject(new Dictionary<string, object>
                {
                    ["success"] = true,
                    ["queued"] = true,
                    ["target"] = string.IsNullOrWhiteSpace(label) ? $"button[{index}]" : label,
                    ["window"] = snap.type,
                    ["note"] = "Click will register on the next draw frame. Re-read the window to confirm the effect."
                });
            }
            catch (Exception ex)
            {
                return $"{{\"success\": false, \"reason\": \"invoke_window_control failed: {ex.Message}\"}}";
            }
        }
    }
}
