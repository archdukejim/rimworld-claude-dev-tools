using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Verse;

namespace RimAgentic.Testing
{
    /// <summary>
    /// Mod-agnostic liveness sentinels. A dead or misconfigured mod runs no failing tests of its
    /// own — its whole suite silently vanishes while the rest stays green — so something outside
    /// the mod must notice. These three cases are that something, and they run before everything
    /// else. Case names keep their historical <c>Core_</c> prefixes: they map back to the issues
    /// whose test plans they satisfy (Factions#42, TestRunner#6).
    ///
    /// <para><b>Prefer structural checks to log scanning.</b> <c>Log.Messages</c> is a bounded
    /// buffer, so a noisy startup can roll a log-scanning case into a false PASS. The two
    /// structural cases here ask ModsConfig and the assemblies themselves; only
    /// <c>Core_AllModsInstantiated</c> scans the log, because instantiation failures have no
    /// structural equivalent.</para>
    /// </summary>
    [SynapseTestSet(TestPhase.Sentinel)]
    public static class SentinelCases
    {
        public static IEnumerable<SynapseTestCase> All()
        {
            yield return new SynapseTestCase("Core_DeclaredLoadOrderRespected", () =>
            {
                // The cause: declared order versus actual order. `loadAfter` is advisory —
                // RimWorld loads ModsConfig.xml in the order written, and a tool that sorts a
                // modlist alphabetically produces a broken order with no error of its own.
                var violations = FindLoadOrderViolations();

                Assert.True(violations.Count == 0,
                    $"{violations.Count} mod(s) load before a declared dependency: " +
                    string.Join(" | ", violations.Take(3)));

                int active = ModsConfig.ActiveModsInLoadOrder?.Count() ?? 0;
                return $"{active} active mod(s), every declared loadAfter satisfied";
            });

            yield return new SynapseTestCase("Core_EveryShippedAssemblyIsLive", () =>
            {
                // The symptom, and not specific to load order: any unresolvable reference produces
                // it, including a binary-incompatible change to a dependency's public surface.
                //
                // The first version of this case walked pack.assemblies.loadedAssemblies and called
                // GetTypes() on each — and PASSED while Factions was provably dead. RimWorld does
                // not keep an assembly it could not load types from, so that list contains only
                // healthy assemblies. Asking "did any of what loaded break" is the exact mistake
                // Core_AllModsInstantiated makes.
                //
                // So ask the other question: does every DLL a mod actually ships have a live
                // assembly? Zero-from-nonzero is unambiguous. GetTypes() is still called on what is
                // present, because an assembly can in principle be retained and still be broken —
                // that is a second way to fail, never a way to pass.
                var dead = new List<string>();
                int packsWithDlls = 0, liveAssemblies = 0;

                var loadedNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (var pack in LoadedModManager.RunningModsListForReading)
                {
                    var asms = pack?.assemblies?.loadedAssemblies;
                    if (asms == null) continue;
                    foreach (var a in asms)
                        if (a != null) loadedNames.Add(a.GetName().Name);
                }

                foreach (var pack in LoadedModManager.RunningModsListForReading)
                {
                    if (pack == null) continue;

                    var shipped = ShippedAssemblyNames(pack);
                    if (shipped.Count == 0) continue;
                    packsWithDlls++;

                    var live = pack.assemblies?.loadedAssemblies ?? new List<Assembly>();
                    liveAssemblies += live.Count;

                    foreach (string name in shipped)
                    {
                        // Loaded by this mod, or already loaded by another under the same simple
                        // name — RimWorld skips duplicates, and that is not a failure.
                        if (loadedNames.Contains(name)) continue;
                        dead.Add($"{pack.Name}: ships {name}.dll but no such assembly is loaded — that mod is inert");
                    }

                    foreach (var asm in live)
                    {
                        if (asm == null) continue;
                        try { asm.GetTypes(); }
                        catch (ReflectionTypeLoadException ex)
                        {
                            string why = ex.LoaderExceptions?.FirstOrDefault()?.Message ?? "no loader exception reported";
                            dead.Add($"{pack.Name} / {asm.GetName().Name}: {Shorten(why)}");
                        }
                        catch (Exception ex)
                        {
                            dead.Add($"{pack.Name} / {asm.GetName().Name}: [{ex.GetType().Name}] {Shorten(ex.Message)}");
                        }
                    }
                }

                Assert.True(dead.Count == 0,
                    $"{dead.Count} shipped assembly/assemblies are not live: " + string.Join(" | ", dead.Take(3)));

                return $"{packsWithDlls} mod(s) ship assemblies; all accounted for, {liveAssemblies} live";
            });

            yield return new SynapseTestCase("Core_AllModsInstantiated", () =>
            {
                // Catches a mod that loaded and then threw. It does NOT catch a mod whose assembly
                // never yielded its types — that mod's Mod subclass is never discovered, so it
                // never fails to instantiate and neither string below appears. The two structural
                // cases above exist for that hole; do not widen this one.
                var failures = TestLog.RecentLines()
                    .Where(l => l.Contains("Error while instantiating a mod")
                             || l.Contains("Error in static constructor"))
                    .ToList();

                Assert.True(failures.Count == 0,
                    $"{failures.Count} mod(s) failed to initialise: " +
                    string.Join(" | ", failures.Take(3).Select(Shorten)));

                return "every mod instantiated cleanly";
            });
        }

        /// <summary>
        /// Active mods ordered before something they declare `loadAfter`/`forceLoadAfter`, as
        /// "Mod (pos N) must load after Required (pos M)" strings.
        ///
        /// <para>Mirrors RimSynapse Core's <c>SynapseLoadOrderCheck.FindViolations()</c> — copied,
        /// not referenced, because this assembly must stay free of RimSynapse dependencies. The
        /// members are read by reflection: they have changed shape across RimWorld versions, and a
        /// hard reference would make a diagnostic fail to build. packageIds compare
        /// lower-invariant: ModsConfig.xml lowercases them while About.xml keeps author casing.</para>
        /// </summary>
        private static List<string> FindLoadOrderViolations()
        {
            var result = new List<string>();

            var active = ModsConfig.ActiveModsInLoadOrder?.ToList();
            if (active == null || active.Count == 0) return result;

            var position = new Dictionary<string, int>();
            for (int i = 0; i < active.Count; i++)
            {
                string id = Normalize(active[i]?.PackageId);
                if (id != null && !position.ContainsKey(id)) position[id] = i;
            }

            for (int i = 0; i < active.Count; i++)
            {
                var meta = active[i];
                if (meta == null) continue;

                foreach (string required in DeclaredPredecessors(meta))
                {
                    string id = Normalize(required);
                    if (id == null) continue;

                    // A loadAfter naming a mod that is not installed is normal and correct —
                    // that is how optional integrations are declared. Only an active mod in the
                    // wrong place is a problem.
                    int requiredPos;
                    if (!position.TryGetValue(id, out requiredPos)) continue;
                    if (requiredPos < i) continue;

                    result.Add($"{DisplayName(meta)} (pos {i + 1}) must load after {DisplayName(active[requiredPos])} (pos {requiredPos + 1})");
                }
            }

            return result;
        }

        private static IEnumerable<string> DeclaredPredecessors(ModMetaData meta)
        {
            // Deduplicated because a property and its backing field are both probed. `loadBefore`
            // is deliberately not checked: it exists so a mod can push itself ahead of somebody
            // else's, and assembly resolution only cares about loadAfter.
            var seen = new HashSet<string>();
            foreach (string member in new[] { "LoadAfter", "ForceLoadAfter", "loadAfter", "forceLoadAfter" })
            {
                foreach (string id in ReadStringList(meta, member))
                {
                    string norm = Normalize(id);
                    if (norm != null && seen.Add(norm)) yield return id;
                }
            }
        }

        private static IEnumerable<string> ReadStringList(ModMetaData meta, string member)
        {
            object value = null;

            var prop = typeof(ModMetaData).GetProperty(member,
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            if (prop != null)
            {
                value = prop.GetValue(meta, null);
            }
            else
            {
                var field = typeof(ModMetaData).GetField(member,
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
                if (field != null) value = field.GetValue(meta);
            }

            var list = value as IEnumerable;
            if (list == null) yield break;

            foreach (object o in list)
            {
                var s = o as string;
                if (!string.IsNullOrEmpty(s)) yield return s;
            }
        }

        /// <summary>
        /// Simple names of the managed DLLs this mod actually ships for the running game version.
        /// Uses <c>ModContentPack.foldersToLoadDescendingOrder</c> when available — RimWorld's own
        /// answer to "which folders are in play" — falling back to the root Assemblies folder.
        /// </summary>
        private static List<string> ShippedAssemblyNames(ModContentPack pack)
        {
            var names = new List<string>();
            var roots = new List<string>();

            try
            {
                var prop = typeof(ModContentPack).GetProperty("foldersToLoadDescendingOrder",
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
                var folders = prop?.GetValue(pack, null) as IEnumerable<string>;
                if (folders != null) roots.AddRange(folders);
            }
            catch { /* fall through to RootDir */ }

            if (roots.Count == 0 && !string.IsNullOrEmpty(pack.RootDir)) roots.Add(pack.RootDir);

            foreach (string root in roots)
            {
                if (string.IsNullOrEmpty(root)) continue;
                string dir = System.IO.Path.Combine(root, "Assemblies");
                if (!System.IO.Directory.Exists(dir)) continue;

                foreach (string dll in System.IO.Directory.GetFiles(dir, "*.dll", System.IO.SearchOption.TopDirectoryOnly))
                {
                    string name = System.IO.Path.GetFileNameWithoutExtension(dll);
                    if (!names.Contains(name)) names.Add(name);
                }
            }

            return names;
        }

        private static string DisplayName(ModMetaData meta)
        {
            if (meta == null) return "(unknown)";
            return string.IsNullOrEmpty(meta.Name) ? meta.PackageId : meta.Name;
        }

        private static string Normalize(string packageId)
        {
            if (string.IsNullOrEmpty(packageId)) return null;
            return packageId.Trim().ToLowerInvariant();
        }

        private static string Shorten(string s)
        {
            if (string.IsNullOrEmpty(s)) return "<empty>";
            var oneLine = s.Replace("\r", " ").Replace("\n", " ");
            return oneLine.Length <= 160 ? oneLine : oneLine.Substring(0, 160) + "...";
        }
    }
}
