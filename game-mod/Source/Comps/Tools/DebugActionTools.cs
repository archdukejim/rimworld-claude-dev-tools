using System;
using System.Collections.Generic;
using System.Reflection;
using System.Linq;
using Verse;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace RimAgentic
{
    /// <summary>
    /// Dynamically discovers and registers RimWorld's built-in debug actions
    /// (ToolMapForPawns type) as LLM-callable tools at runtime.
    /// </summary>
    public static partial class SynapseToolRegistry
    {
        private static void RegisterDynamicDebugActions()
        {
            try
            {
                var tAttr = HarmonyLib.AccessTools.TypeByName("LudeonTK.DebugActionAttribute");
                var tEnum = HarmonyLib.AccessTools.TypeByName("LudeonTK.DebugActionType");
                if (tAttr == null || tEnum == null) return;

                object toolMapForPawnsVal = Enum.Parse(tEnum, "ToolMapForPawns");
                var actionTypeField = tAttr.GetField("actionType", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
                var nameField = tAttr.GetField("name", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
                var categoryField = tAttr.GetField("category", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);

                if (actionTypeField == null || nameField == null) return;

                var asm = tAttr.Assembly;
                var methods = asm.GetTypes()
                    .SelectMany(t => t.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static))
                    .Where(m =>
                    {
                        var attrs = m.GetCustomAttributes(tAttr, true);
                        if (attrs.Length == 0) return false;
                        var attr = attrs[0];
                        object val = actionTypeField.GetValue(attr);
                        if (val == null) return false;
                        if ((int)val != (int)toolMapForPawnsVal) return false;
                        var gps = m.GetParameters();
                        return gps.Length == 1 && gps[0].ParameterType == typeof(Pawn);
                    })
                    .ToList();

                foreach (var method in methods)
                {
                    var attrs = method.GetCustomAttributes(tAttr, true);
                    var attr = attrs[0];
                    string debugName = nameField.GetValue(attr)?.ToString() ?? method.Name;
                    string category = categoryField?.GetValue(attr)?.ToString() ?? "Other";
                    
                    string typePrefix = method.DeclaringType.Name.Replace("DebugTools", "").Replace("DebugActions", "").ToLower();
                    string toolName = "debug_pawn_" + (string.IsNullOrEmpty(typePrefix) ? "" : typePrefix + "_") + method.Name.ToLower();

                    // Avoid duplicate registrations
                    RegisterTool(
                        toolName,
                        $"[DEBUG ACTION] {debugName} (Category: {category}). Directly invokes the game's debug option on the specified colonist.",
                        new Dictionary<string, object>
                        {
                            ["type"] = "object",
                            ["properties"] = new Dictionary<string, object>
                            {
                                ["pawnName"] = new Dictionary<string, string>
                                {
                                    ["type"] = "string",
                                    ["description"] = "The name of the target colonist/pawn."
                                }
                            },
                            ["required"] = new List<string> { "pawnName" }
                        },
                        args =>
                        {
                            if (Find.CurrentMap == null) return "{\"success\": false, \"reason\": \"No active map loaded.\"}";
                            try
                            {
                                var parsedArgs = JsonConvert.DeserializeObject<Dictionary<string, string>>(args);
                                if (parsedArgs == null || !parsedArgs.TryGetValue("pawnName", out var pawnName))
                                {
                                    return "{\"success\": false, \"reason\": \"Missing required argument 'pawnName'.\"}";
                                }

                                Pawn pawn = Find.CurrentMap.mapPawns.AllPawns.FirstOrDefault(p => p.LabelShort.Equals(pawnName, StringComparison.OrdinalIgnoreCase));
                                if (pawn == null)
                                {
                                    return $"{{\"success\": false, \"reason\": \"Pawn '{pawnName}' not found on active map.\"}}";
                                }

                                method.Invoke(null, new object[] { pawn });
                                return $"{{\"success\": true, \"message\": \"Invoked debug action '{debugName}' on pawn '{pawnName}' successfully.\"}}";
                            }
                            catch (Exception ex)
                            {
                                return $"{{\"success\": false, \"reason\": \"Failed to execute debug action: {ex.Message}\"}}";
                            }
                        },
                        true
                    );
                }
            }
            catch (Exception ex)
            {
                Log.Warning($"[RimAgentic] Failed to dynamically register debug actions: {ex.Message}");
            }
        }

        // ------------------------------------------------------------------------------------------
        // Durable, generic debug-action bridge.
        //
        // RegisterDynamicDebugActions (above) only sees RimWorld's OWN assembly — it reflects over
        // DebugActionAttribute.Assembly, so a mod's [DebugAction]s (which the in-game Debug Actions
        // menu shows) are never exposed as bridge tools. That is a per-mod gap that recurs for every
        // mod. These two tools close it generically: they reflect over EVERY loaded assembly, so any
        // active mod's debug actions can be listed and invoked over the bridge with no per-mod wiring.
        //
        // This is the headless validation path: build a [DebugAction] that forces a mechanic, then
        // fire it with run_debug_action and read the result / log — the same code path a human drives
        // by clicking the menu entry.
        // ------------------------------------------------------------------------------------------
        internal static void RegisterDebugActionBridge()
        {
            RegisterTool(
                "list_debug_actions",
                "Lists RimWorld debug actions discovered across ALL loaded assemblies (every active mod, not just vanilla). Each entry gives name, category, actionType, declaringType, assembly, and 'signature' (none | pawn | cell | unsupported) — which tells run_debug_action what argument it needs. Optional 'query' filters by a case-insensitive substring of name/category/declaringType; 'includeVanilla' (default false) also lists RimWorld's built-in actions (there are hundreds).",
                new Dictionary<string, object>
                {
                    ["type"] = "object",
                    ["properties"] = new Dictionary<string, object>
                    {
                        ["query"] = new Dictionary<string, string> { ["type"] = "string", ["description"] = "Optional case-insensitive substring filter over name/category/declaringType." },
                        ["includeVanilla"] = new Dictionary<string, string> { ["type"] = "boolean", ["description"] = "Include RimWorld's built-in (Assembly-CSharp) debug actions too. Default false." }
                    }
                },
                args => ListDebugActions(args),
                false // visible: this is how the agent discovers what it can invoke
            );

            RegisterTool(
                "run_debug_action",
                "Invokes ANY RimWorld debug action by name over the bridge — including mod-defined ones the Debug Actions menu shows but that are not otherwise exposed as tools. Dispatches on the method signature: no-arg actions run immediately; pawn-targeted actions need 'pawnName'; cell-targeted actions need integer 'x'/'z'. Optional 'category' disambiguates identically-named actions. This is the durable, generic way to trigger a mechanic headlessly for validation. Discover names with list_debug_actions.",
                new Dictionary<string, object>
                {
                    ["type"] = "object",
                    ["properties"] = new Dictionary<string, object>
                    {
                        ["name"] = new Dictionary<string, string> { ["type"] = "string", ["description"] = "Exact debug action name (the label shown in the Debug Actions menu), case-insensitive." },
                        ["category"] = new Dictionary<string, string> { ["type"] = "string", ["description"] = "Optional category to disambiguate identically-named actions." },
                        ["pawnName"] = new Dictionary<string, string> { ["type"] = "string", ["description"] = "Target colonist LabelShort, for pawn-targeted (ToolMapForPawns) actions." },
                        ["x"] = new Dictionary<string, string> { ["type"] = "integer", ["description"] = "Target cell X, for cell-targeted (ToolMap) actions." },
                        ["z"] = new Dictionary<string, string> { ["type"] = "integer", ["description"] = "Target cell Z, for cell-targeted (ToolMap) actions." }
                    },
                    ["required"] = new List<string> { "name" }
                },
                args => RunDebugAction(args),
                false,  // visible
                null,   // keywords
                true    // isMutating — it can invoke anything that changes state
            );
        }

        /// <summary>How run_debug_action can drive a discovered action, inferred from its signature.</summary>
        private struct DebugActionEntry
        {
            public MethodInfo method;
            public string name;
            public string category;
            public string actionType;
            public string signature; // none | pawn | cell | unsupported
        }

        private static string SignatureOf(MethodInfo m)
        {
            var ps = m.GetParameters();
            if (ps.Length == 0) return "none";
            if (ps.Length == 1 && ps[0].ParameterType == typeof(Pawn)) return "pawn";
            if (ps.Length == 1 && ps[0].ParameterType == typeof(IntVec3)) return "cell";
            return "unsupported";
        }

        /// <summary>
        /// Reflect the LudeonTK DebugAction attribute type and its fields by name (no compile-time
        /// dependency on LudeonTK — matches RegisterDynamicDebugActions). Returns false if unavailable.
        /// </summary>
        private static bool TryGetDebugAttr(out Type tAttr, out FieldInfo nameField, out FieldInfo categoryField, out FieldInfo actionTypeField)
        {
            tAttr = HarmonyLib.AccessTools.TypeByName("LudeonTK.DebugActionAttribute");
            nameField = tAttr?.GetField("name", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            categoryField = tAttr?.GetField("category", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            actionTypeField = tAttr?.GetField("actionType", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            return tAttr != null && nameField != null;
        }

        /// <summary>Every [DebugAction] across loaded assemblies (mods first; vanilla only when asked).</summary>
        private static List<DebugActionEntry> DiscoverDebugActions(bool includeVanilla)
        {
            var found = new List<DebugActionEntry>();
            if (!TryGetDebugAttr(out var tAttr, out var nameField, out var categoryField, out var actionTypeField))
                return found;

            string vanillaAsmName = tAttr.Assembly.GetName().Name; // Assembly-CSharp
            foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                if (asm.IsDynamic) continue;
                if (!includeVanilla && asm.GetName().Name == vanillaAsmName) continue;

                Type[] types;
                try { types = asm.GetTypes(); }
                catch (ReflectionTypeLoadException ex) { types = ex.Types.Where(t => t != null).ToArray(); }
                catch { continue; }

                foreach (var t in types)
                {
                    if (t == null) continue;
                    MethodInfo[] methods;
                    try { methods = t.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static); }
                    catch { continue; }

                    foreach (var m in methods)
                    {
                        object attr;
                        try
                        {
                            var attrs = m.GetCustomAttributes(tAttr, true);
                            if (attrs.Length == 0) continue;
                            attr = attrs[0];
                        }
                        catch { continue; }

                        found.Add(new DebugActionEntry
                        {
                            method = m,
                            name = nameField.GetValue(attr)?.ToString() ?? m.Name,
                            category = categoryField?.GetValue(attr)?.ToString() ?? "",
                            actionType = actionTypeField?.GetValue(attr)?.ToString() ?? "",
                            signature = SignatureOf(m)
                        });
                    }
                }
            }
            return found;
        }

        private static string DbgResult(bool success, string message)
        {
            return JsonConvert.SerializeObject(success
                ? (object)new Dictionary<string, object> { ["success"] = true, ["message"] = message }
                : new Dictionary<string, object> { ["success"] = false, ["reason"] = message });
        }

        private static string ListDebugActions(string argsJson)
        {
            try
            {
                bool includeVanilla = false;
                string query = null;
                if (!string.IsNullOrEmpty(argsJson))
                {
                    var jo = JObject.Parse(argsJson);
                    includeVanilla = jo.Value<bool?>("includeVanilla") ?? false;
                    query = jo.Value<string>("query");
                }

                IEnumerable<DebugActionEntry> list = DiscoverDebugActions(includeVanilla);
                if (!string.IsNullOrEmpty(query))
                {
                    string q = query.ToLowerInvariant();
                    list = list.Where(e =>
                        (e.name?.ToLowerInvariant().Contains(q) ?? false) ||
                        (e.category?.ToLowerInvariant().Contains(q) ?? false) ||
                        (e.method.DeclaringType?.Name.ToLowerInvariant().Contains(q) ?? false));
                }

                var payload = list
                    .OrderBy(e => e.category).ThenBy(e => e.name)
                    .Select(e => new Dictionary<string, string>
                    {
                        ["name"] = e.name,
                        ["category"] = e.category,
                        ["actionType"] = e.actionType,
                        ["signature"] = e.signature,
                        ["declaringType"] = e.method.DeclaringType?.FullName ?? "",
                        ["assembly"] = e.method.DeclaringType?.Assembly.GetName().Name ?? ""
                    })
                    .ToList();

                return JsonConvert.SerializeObject(new Dictionary<string, object> { ["count"] = payload.Count, ["actions"] = payload });
            }
            catch (Exception ex)
            {
                return $"{{\"error\": \"list_debug_actions failed: {ex.Message}\"}}";
            }
        }

        private static string RunDebugAction(string argsJson)
        {
            try
            {
                if (string.IsNullOrEmpty(argsJson)) return DbgResult(false, "Missing arguments; 'name' is required.");
                var jo = JObject.Parse(argsJson);

                string name = jo.Value<string>("name");
                if (string.IsNullOrWhiteSpace(name)) return DbgResult(false, "Missing required argument 'name'.");
                string category = jo.Value<string>("category");

                // Search all assemblies — you may also want to fire a built-in (vanilla) action.
                var matches = DiscoverDebugActions(true)
                    .Where(e => string.Equals(e.name, name, StringComparison.OrdinalIgnoreCase)
                             && (string.IsNullOrEmpty(category) || string.Equals(e.category, category, StringComparison.OrdinalIgnoreCase)))
                    .ToList();

                if (matches.Count == 0)
                    return DbgResult(false, $"No debug action named '{name}'{(string.IsNullOrEmpty(category) ? "" : $" in category '{category}'")}. Use list_debug_actions to discover names.");
                if (matches.Count > 1 && string.IsNullOrEmpty(category))
                {
                    var cats = string.Join(", ", matches.Select(m => $"\"{m.category}\" ({m.method.DeclaringType?.Name})").Distinct());
                    return DbgResult(false, $"'{name}' is ambiguous across categories: {cats}. Pass 'category' to disambiguate.");
                }

                var entry = matches[0];
                switch (entry.signature)
                {
                    case "none":
                        entry.method.Invoke(null, null);
                        return DbgResult(true, $"Invoked debug action '{entry.name}'.");

                    case "pawn":
                    {
                        if (Find.CurrentMap == null) return DbgResult(false, "No active map; a pawn-targeted action needs a live map.");
                        string pawnName = jo.Value<string>("pawnName");
                        if (string.IsNullOrWhiteSpace(pawnName)) return DbgResult(false, $"'{entry.name}' targets a pawn; pass 'pawnName'.");
                        var pawn = Find.CurrentMap.mapPawns.AllPawns.FirstOrDefault(p => p.LabelShort.Equals(pawnName, StringComparison.OrdinalIgnoreCase));
                        if (pawn == null) return DbgResult(false, $"Pawn '{pawnName}' not found on the active map.");
                        entry.method.Invoke(null, new object[] { pawn });
                        return DbgResult(true, $"Invoked debug action '{entry.name}' on pawn '{pawn.LabelShort}'.");
                    }

                    case "cell":
                    {
                        if (Find.CurrentMap == null) return DbgResult(false, "No active map; a cell-targeted action needs a live map.");
                        int? x = jo.Value<int?>("x");
                        int? z = jo.Value<int?>("z");
                        if (x == null || z == null) return DbgResult(false, $"'{entry.name}' targets a cell; pass integer 'x' and 'z'.");
                        var cell = new IntVec3(x.Value, 0, z.Value);
                        if (!cell.InBounds(Find.CurrentMap)) return DbgResult(false, $"Cell ({x},{z}) is out of bounds.");
                        entry.method.Invoke(null, new object[] { cell });
                        return DbgResult(true, $"Invoked debug action '{entry.name}' at ({x},{z}).");
                    }

                    default:
                        return DbgResult(false, $"'{entry.name}' has an unsupported signature ({string.Join(",", entry.method.GetParameters().Select(p => p.ParameterType.Name))}); only no-arg, single-Pawn, and single-IntVec3 debug actions can be driven headlessly.");
                }
            }
            catch (TargetInvocationException tie)
            {
                return DbgResult(false, $"The debug action threw: {tie.InnerException?.Message ?? tie.Message}");
            }
            catch (Exception ex)
            {
                return DbgResult(false, $"run_debug_action failed: {ex.Message}");
            }
        }
    }
}
