using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;
using RimSynapse.WorldNews.Newspaper;

namespace RimSynapse.PromptLab.Families
{
    /// <summary>
    /// Family: RimSynapse WorldNews broadsheet generation. Delegates to the mod's PURE
    /// <see cref="NewspaperPromptComposer"/> (linked from the WorldNews source), so the lab builds exactly the
    /// prompt the game sends. inputs shape: <c>{ events: ["...", "..."] }</c>.
    /// </summary>
    public class NewspaperFamily : IPromptFamily
    {
        public string Key => "newspaper";
        public string Description => "RimSynapse WorldNews frontier broadsheet — lays a batch of raw events out as one issue.";

        public IReadOnlyList<InputFieldDoc> InputContract => new[]
        {
            new InputFieldDoc("events", "string[]", "unpublished WorldNews event feed",
                "The raw event summaries the issue is built from (one issue per batch).")
        };

        public ComposedPrompt Compose(JObject inputs)
        {
            var events = (inputs?["events"] as JArray)?.Select(t => (string)t).Where(s => s != null).ToList()
                         ?? new List<string>();
            var p = NewspaperPromptComposer.Compose(events);
            return new ComposedPrompt(p.system, p.user);
        }

        /// <summary>Light structured view of the RAW issue JSON (headline + counts) — never a verdict; the
        /// raw response is always returned for the consumer to judge.</summary>
        public object ParseRaw(string raw, JObject inputs)
        {
            try
            {
                var o = JObject.Parse(ExtractJson(raw));
                var stories = o["Stories"] as JArray;
                var sidebars = o["Sidebars"] as JArray;
                return new
                {
                    paperName = (string)o["PaperName"],
                    headline = (string)o["Headline"],
                    storyCount = stories?.Count ?? 0,
                    sidebarCount = sidebars?.Count ?? 0,
                    leadTitle = stories != null && stories.Count > 0 ? (string)stories[0]?["Title"] : null,
                    perceivedWealthDelta = (int?)o["PerceivedWealthDelta"],
                    perceivedStrengthDelta = (int?)o["PerceivedStrengthDelta"]
                };
            }
            catch { return null; }
        }

        private static string ExtractJson(string content)
        {
            if (string.IsNullOrEmpty(content)) return content;
            int a = content.IndexOf('{'), b = content.LastIndexOf('}');
            return a != -1 && b != -1 && b > a ? content.Substring(a, b - a + 1) : content;
        }

        // ── catalog: representative event batches ────────────────────────────
        public IReadOnlyList<CatalogScenario> Catalog(JObject filter)
        {
            var only = filter?["scenarios"] as JArray;
            var keys = only == null ? null : new HashSet<string>(only.Select(x => (string)x), System.StringComparer.OrdinalIgnoreCase);

            var all = new List<CatalogScenario>
            {
                S("quiet-week", "A colonist finished sculpting a wooden chair.", "Light rain fell over the settlement.", "A muffalo wandered near the perimeter and left."),
                S("raid-and-death", "A pirate raid of nine hit the east wall at dawn.", "The colonist Bex was killed defending the breach.", "A mortar shell destroyed the outer barricade.", "The raiders were driven off after an hour of fighting."),
                S("windfall", "A legendary marble sculpture was completed.", "Miners struck a rich vein of gold in the deep drill.", "A wealthy trade caravan arrived and bought most of the smokeleaf crop."),
                S("disaster", "Toxic fallout began and blanketed the region.", "The rice crop blighted and failed.", "The freezer's cooler broke and the food stores are spoiling.", "Two colonists fell ill with the flu."),
                S("visitors-and-recruit", "A caravan from the Sanguine Federation arrived to trade.", "A wanderer named Ash joined the colony.", "A tamed thrumbo was brought into the settlement."),
            };

            return keys == null ? all : all.Where(c => keys.Contains(StripPrefix(c.id))).ToList();
        }

        private static CatalogScenario S(string key, params string[] events)
            => new CatalogScenario($"newspaper/{key}", new JObject { ["events"] = new JArray(events) });

        private static string StripPrefix(string id)
        {
            int slash = id.IndexOf('/');
            return slash >= 0 ? id.Substring(slash + 1) : id;
        }
    }
}
