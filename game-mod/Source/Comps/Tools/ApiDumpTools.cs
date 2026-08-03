using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using Verse;
using Newtonsoft.Json;

namespace RimAgentic
{
    /// <summary>
    /// Tool handler: dump_game_api
    /// Reflects over the loaded RimWorld assembly (Verse + RimWorld + DLC code) and writes a
    /// structured API corpus — one JSON record per public type with its kind, base type, and
    /// public members' readable signatures — to %LOCALAPPDATA%\RimAgentic\api\api-corpus.jsonl.
    /// The MCP side searches this corpus so the agent can look up real game API instead of
    /// guessing when it writes C#/Harmony. Run once per game version.
    /// </summary>
    public static partial class SynapseToolRegistry
    {
        private static void RegisterApiDumpTools()
        {
            RegisterTool(
                "dump_game_api",
                "Reflect over the loaded RimWorld assembly and write a structured API corpus (public " +
                "types + members in the Verse and RimWorld namespaces, including DLC code) to " +
                "%LOCALAPPDATA%\\RimAgentic\\api\\api-corpus.jsonl — one JSON record per type. Run once " +
                "per game version; the MCP side then searches it. Returns { ok, types, members, path }. " +
                "This is a one-time reflection dump and may take a few seconds.",
                new Dictionary<string, object>
                {
                    ["type"] = "object",
                    ["properties"] = new Dictionary<string, object>()
                },
                args =>
                {
                    try
                    {
                        var asm = typeof(Pawn).Assembly; // Assembly-CSharp: Verse + RimWorld + DLC code
                        var dir = Path.Combine(
                            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                            "RimAgentic", "api");
                        Directory.CreateDirectory(dir);
                        var outPath = Path.Combine(dir, "api-corpus.jsonl");

                        int typeCount = 0, memberCount = 0;
                        const BindingFlags bf = BindingFlags.Public | BindingFlags.Instance |
                                                BindingFlags.Static | BindingFlags.DeclaredOnly;

                        using (var sw = new StreamWriter(outPath, false))
                        {
                            foreach (var t in SafeGetTypes(asm))
                            {
                                if (t == null || !t.IsPublic) continue;
                                var ns = t.Namespace ?? "";
                                if (!(ns == "Verse" || ns.StartsWith("Verse.") ||
                                      ns == "RimWorld" || ns.StartsWith("RimWorld."))) continue;

                                var members = new List<object>();
                                try
                                {
                                    foreach (var m in t.GetMethods(bf))
                                    {
                                        if (m.IsSpecialName || m.Name.Contains("<")) continue; // accessors / compiler-gen
                                        members.Add(new { kind = "method", name = m.Name, sig = MethodSig(m), stat = m.IsStatic });
                                    }
                                    foreach (var f in t.GetFields(bf))
                                    {
                                        if (f.Name.Contains("<")) continue;
                                        members.Add(new { kind = "field", name = f.Name, sig = ApiTypeName(f.FieldType) + " " + f.Name, stat = f.IsStatic });
                                    }
                                    foreach (var p in t.GetProperties(bf))
                                    {
                                        members.Add(new { kind = "property", name = p.Name, sig = ApiTypeName(p.PropertyType) + " " + p.Name });
                                    }
                                }
                                catch { /* a type whose members won't reflect is still worth its header */ }

                                memberCount += members.Count;
                                typeCount++;
                                sw.WriteLine(JsonConvert.SerializeObject(new
                                {
                                    ns,
                                    name = t.Name,
                                    full = t.FullName,
                                    kind = ApiTypeKind(t),
                                    baseType = (t.BaseType != null && t.BaseType != typeof(object)) ? ApiTypeName(t.BaseType) : null,
                                    members
                                }));
                            }
                        }

                        return JsonConvert.SerializeObject(new { ok = true, types = typeCount, members = memberCount, path = outPath });
                    }
                    catch (Exception e)
                    {
                        return JsonConvert.SerializeObject(new { ok = false, error = e.Message });
                    }
                }
            );
        }

        private static IEnumerable<Type> SafeGetTypes(Assembly a)
        {
            try { return a.GetTypes(); }
            catch (ReflectionTypeLoadException e) { return e.Types.Where(x => x != null); }
        }

        private static string ApiTypeKind(Type t)
        {
            if (t.IsEnum) return "enum";
            if (t.IsInterface) return "interface";
            if (typeof(Delegate).IsAssignableFrom(t)) return "delegate";
            if (t.IsValueType) return "struct";
            if (t.IsAbstract && t.IsSealed) return "static class";
            if (t.IsAbstract) return "abstract class";
            return "class";
        }

        private static string MethodSig(MethodInfo m)
        {
            var ps = m.GetParameters().Select(p => ApiTypeName(p.ParameterType) + " " + p.Name);
            return ApiTypeName(m.ReturnType) + " " + m.Name + "(" + string.Join(", ", ps) + ")";
        }

        private static string ApiTypeName(Type t)
        {
            if (t == null) return "?";
            if (t.IsByRef) return "ref " + ApiTypeName(t.GetElementType());
            if (t.IsArray) return ApiTypeName(t.GetElementType()) + "[]";
            if (t.IsGenericType)
            {
                var name = t.Name;
                int tick = name.IndexOf('`');
                if (tick > 0) name = name.Substring(0, tick);
                return name + "<" + string.Join(", ", t.GetGenericArguments().Select(ApiTypeName)) + ">";
            }
            switch (t.FullName)
            {
                case "System.Void": return "void";
                case "System.Int32": return "int";
                case "System.Single": return "float";
                case "System.Boolean": return "bool";
                case "System.String": return "string";
                case "System.Object": return "object";
                default: return t.Name;
            }
        }
    }
}
