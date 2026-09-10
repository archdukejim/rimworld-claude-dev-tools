using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;
using RimSynapse.Psychology.Prompts;

namespace RimSynapse.PromptLab.Families
{
    // Small shared helpers for the Psychology families.
    internal static class PsyJson
    {
        public static string Str(JObject o, string k) { var v = o?[k]; return v == null || v.Type == JTokenType.Null ? null : (string)v; }
        public static object ExtractJsonObj(string raw)
        {
            try
            {
                if (string.IsNullOrEmpty(raw)) return null;
                int a = raw.IndexOf('{'), b = raw.LastIndexOf('}');
                return a != -1 && b > a ? JObject.Parse(raw.Substring(a, b - a + 1)) : null;
            }
            catch { return null; }
        }
    }

    /// <summary>
    /// Family: Psychology voice-profile derivation — the prompt that DERIVES the <c>voiceProfile</c> the
    /// Conversations dialogue prompt then consumes (directly tied to the #44 register work). Delegates to the
    /// mod's pure <see cref="VoiceProfilePromptComposer"/>. inputs: <c>{ name, traits, psychology, personality }</c>.
    /// </summary>
    public class PsychologyVoiceFamily : IPromptFamily
    {
        public string Key => "psychology.voice";
        public string Description => "Psychology voice-profile derivation — produces the voiceProfile the Conversations #44 identity logic consumes.";

        public IReadOnlyList<InputFieldDoc> InputContract => new[]
        {
            new InputFieldDoc("name", "string", "Pawn.Name.ToStringShort"),
            new InputFieldDoc("traits", "string", "pawn.story.traits.allTraits.Label (comma-joined)"),
            new InputFieldDoc("psychology", "string", "SynapseCorePawnComp.llmTraits (comma-joined), or 'none'"),
            new InputFieldDoc("personality", "string", "SynapseCorePawnComp.personalitySummary")
        };

        public ComposedPrompt Compose(JObject i)
        {
            var p = VoiceProfilePromptComposer.Compose(
                PsyJson.Str(i, "name") ?? "Ana", PsyJson.Str(i, "traits") ?? "none",
                PsyJson.Str(i, "psychology") ?? "none", PsyJson.Str(i, "personality") ?? "an ordinary traveller of the rim");
            return new ComposedPrompt(p.system, p.user);
        }

        public object ParseRaw(string raw, JObject inputs)
        {
            var o = PsyJson.ExtractJsonObj(raw) as JObject;
            return o == null ? null : new { style = (string)o["style"], pace = (string)o["pace"], timbre = (string)o["timbre"] };
        }

        public IReadOnlyList<CatalogScenario> Catalog(JObject filter)
        {
            CatalogScenario S(string id, string traits, string psych, string personality)
                => new CatalogScenario($"psychology.voice/{id}", new JObject { ["name"] = "Ana", ["traits"] = traits, ["psychology"] = psych, ["personality"] = personality });
            return Filter(filter, new List<CatalogScenario>
            {
                S("gruff-veteran", "Tough, Bloodlust", "guarded, terse", "A hardened ex-mercenary who trusts almost no one."),
                S("bright-optimist", "Kind, Optimist", "warm, sociable", "A cheerful medic who keeps everyone's spirits up."),
                S("clinical-scientist", "Too smart, Ascetic", "detached, analytical", "A researcher who reduces everything to systems and data."),
                S("bare", "none", "none", "an ordinary traveller of the rim"),
            });
        }

        internal static IReadOnlyList<CatalogScenario> Filter(JObject filter, List<CatalogScenario> all)
        {
            var only = filter?["scenarios"] as JArray;
            if (only == null) return all;
            var keys = new HashSet<string>(only.Select(x => (string)x), System.StringComparer.OrdinalIgnoreCase);
            return all.Where(c => keys.Contains(c.id.Substring(c.id.IndexOf('/') + 1))).ToList();
        }
    }

    /// <summary>
    /// Family: Psychology extreme mental-break prediction. Delegates to the mod's pure
    /// <see cref="BreakPromptComposer"/>. inputs: <c>{ name, mood(0..1), traits, burdens, candidates?[] }</c>.
    /// </summary>
    public class PsychologyBreakFamily : IPromptFamily
    {
        public string Key => "psychology.break";
        public string Description => "Psychology extreme mental-break prediction — picks the break a colonist's psychology best justifies.";

        public IReadOnlyList<InputFieldDoc> InputContract => new[]
        {
            new InputFieldDoc("name", "string", "Pawn.Name.ToStringShort"),
            new InputFieldDoc("mood", "float[0..1]", "pawn.needs.mood.CurLevelPercentage"),
            new InputFieldDoc("traits", "string", "pawn.story.traits.allTraits.Label (comma-joined)"),
            new InputFieldDoc("burdens", "string", "SynapseCorePawnComp.GetTopMemoryBurdens"),
            new InputFieldDoc("candidates", "string[]", "SynapsePsychologyBreaks.BreakCandidates (defaults if omitted)")
        };

        public ComposedPrompt Compose(JObject i)
        {
            var cands = (i?["candidates"] as JArray)?.Select(t => (string)t).ToList();
            float mood = (float?)i?["mood"] ?? 0.1f;
            var p = BreakPromptComposer.Compose(
                PsyJson.Str(i, "name") ?? "Ana", mood, PsyJson.Str(i, "traits") ?? "None",
                PsyJson.Str(i, "burdens") ?? "None", cands);
            return new ComposedPrompt(p.system, p.user);
        }

        public object ParseRaw(string raw, JObject inputs)
        {
            var o = PsyJson.ExtractJsonObj(raw) as JObject;
            return o == null ? null : new { breakDefName = (string)o["BreakDefName"], warning = (string)o["Warning"] };
        }

        public IReadOnlyList<CatalogScenario> Catalog(JObject filter)
        {
            CatalogScenario S(string id, double mood, string traits, string burdens)
                => new CatalogScenario($"psychology.break/{id}", new JObject { ["name"] = "Ana", ["mood"] = mood, ["traits"] = traits, ["burdens"] = burdens });
            return PsychologyVoiceFamily.Filter(filter, new List<CatalogScenario>
            {
                S("volatile-bloodlust", 0.08, "Bloodlust, Volatile", "Watched a friend die in a raid; recent betrayal by a colonist."),
                S("depressive-loss", 0.10, "Depressive, Kind", "Lost their spouse; long isolation; failing harvests."),
                S("pyromaniac-stress", 0.12, "Pyromaniac, Nervous", "Sleep deprivation; a burned-down workshop they blame themselves for."),
                S("gentle-overworked", 0.14, "Gourmand, Kind", "Overworked in the kitchen for days; nobody thanked them."),
            });
        }
    }

    /// <summary>
    /// Family: Psychology childhood backstory-memory. Delegates to the mod's pure
    /// <see cref="ChildhoodMemoryPromptComposer"/>. inputs: <c>{ roleLabel, name, gender, factionType,
    /// childhoodTitle, childhoodDesc, skillBonuses, disabledWork, extraContext }</c>.
    /// </summary>
    public class PsychologyChildhoodFamily : IPromptFamily
    {
        public string Key => "psychology.childhood";
        public string Description => "Psychology childhood backstory-memory — a vivid third-person memory + hometown from a colonist's childhood.";

        public IReadOnlyList<InputFieldDoc> InputContract => new[]
        {
            new InputFieldDoc("roleLabel", "string", "ColonyRoleLabel(pawn), e.g. 'Colonist'"),
            new InputFieldDoc("name", "string", "Pawn.Name.ToStringShort"),
            new InputFieldDoc("gender", "string", "pawn.gender"),
            new InputFieldDoc("factionType", "string", "pawn.Faction.def.LabelCap"),
            new InputFieldDoc("childhoodTitle", "string", "pawn.story.Childhood.title"),
            new InputFieldDoc("childhoodDesc", "string", "pawn.story.Childhood.description"),
            new InputFieldDoc("skillBonuses", "string", "FormatSkillGains(childhood)"),
            new InputFieldDoc("disabledWork", "string", "FormatDisabledWork(childhood) (optional)"),
            new InputFieldDoc("extraContext", "string", "backstory categories + cross-mod context (optional)")
        };

        public ComposedPrompt Compose(JObject i)
        {
            var p = ChildhoodMemoryPromptComposer.Compose(
                PsyJson.Str(i, "roleLabel") ?? "Colonist", PsyJson.Str(i, "name") ?? "Ana",
                PsyJson.Str(i, "gender") ?? "Female", PsyJson.Str(i, "factionType") ?? "Outlander",
                PsyJson.Str(i, "childhoodTitle") ?? "Unknown", PsyJson.Str(i, "childhoodDesc") ?? "An unremarkable childhood.",
                PsyJson.Str(i, "skillBonuses") ?? "None", PsyJson.Str(i, "disabledWork"), PsyJson.Str(i, "extraContext") ?? "");
            return new ComposedPrompt(p.system, p.user);
        }

        public object ParseRaw(string raw, JObject inputs)
        {
            var o = PsyJson.ExtractJsonObj(raw) as JObject;
            if (o == null) return null;
            var mem = (string)o["Memory"];
            return new { memoryWords = string.IsNullOrEmpty(mem) ? 0 : mem.Split(' ').Length, hometown = (string)o["Hometown"], emotionalTone = (string)o["EmotionalTone"], tags = (o["Tags"] as JArray)?.Select(t => (string)t).ToList() };
        }

        public IReadOnlyList<CatalogScenario> Catalog(JObject filter)
        {
            CatalogScenario S(string id, string faction, string title, string desc, string skills, string disabled)
                => new CatalogScenario($"psychology.childhood/{id}", new JObject
                {
                    ["roleLabel"] = "Colonist", ["name"] = "Josema", ["gender"] = "Male", ["factionType"] = faction,
                    ["childhoodTitle"] = title, ["childhoodDesc"] = desc, ["skillBonuses"] = skills,
                    ["disabledWork"] = disabled, ["extraContext"] = ""
                });
            return PsychologyVoiceFamily.Filter(filter, new List<CatalogScenario>
            {
                S("tribal-miner", "Tribe", "Cave child", "Grew up in the tunnels beneath a tribal settlement.", "+4 Mining, +2 Melee", ""),
                S("imperial-noble", "Empire", "Court page", "Raised amid the intrigues of an imperial estate.", "+3 Social, +2 Artistic", "Mining, Hauling"),
                S("pirate-scavenger", "Pirate", "Scrap runner", "Scavenged wrecks aboard a raider station.", "+3 Crafting, +2 Shooting", ""),
            });
        }
    }
}
