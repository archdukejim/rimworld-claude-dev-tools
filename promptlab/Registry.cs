using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;

namespace RimSynapse.PromptLab
{
    /// <summary>
    /// Discovers every <see cref="IPromptFamily"/> compiled into this assembly (by reflection), so adding a
    /// family is just adding its adapter file — no central list to edit. A family whose mod source is absent
    /// from the workspace is conditionally excluded by the csproj, so it never appears here.
    /// </summary>
    public static class Registry
    {
        private static readonly Lazy<Dictionary<string, IPromptFamily>> Families =
            new Lazy<Dictionary<string, IPromptFamily>>(Discover);

        private static Dictionary<string, IPromptFamily> Discover()
        {
            var map = new Dictionary<string, IPromptFamily>(StringComparer.OrdinalIgnoreCase);
            foreach (var t in Assembly.GetExecutingAssembly().GetTypes())
            {
                if (t.IsAbstract || t.IsInterface) continue;
                if (!typeof(IPromptFamily).IsAssignableFrom(t)) continue;
                if (t.GetConstructor(Type.EmptyTypes) == null) continue;
                var fam = (IPromptFamily)Activator.CreateInstance(t);
                map[fam.Key] = fam;
            }
            return map;
        }

        public static IReadOnlyCollection<IPromptFamily> All => Families.Value.Values;

        public static IPromptFamily Get(string key)
        {
            if (string.IsNullOrEmpty(key)) return null;
            Families.Value.TryGetValue(key, out var fam);
            return fam;
        }

        public static List<string> Keys => Families.Value.Keys.OrderBy(k => k).ToList();
    }
}
