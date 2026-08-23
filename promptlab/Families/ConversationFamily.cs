using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;
using RimSynapse.Conversations.Generation;

namespace RimSynapse.PromptLab.Families
{
    /// <summary>
    /// Family: RimSynapse Conversations pawn-to-pawn dialogue. Delegates to the mod's PURE
    /// <see cref="ThinPromptComposer"/> / <see cref="IdentityComposer"/> / <see cref="LenientDialogueParser"/>
    /// (linked from the Conversations source), so the lab builds and parses exactly as the game does.
    ///
    /// inputs shape:
    ///   { initiatorName, recipientName,
    ///     beat: { subject, initiatorStance, recipientStance, tone, framing, isDeep },
    ///     initiator: { voiceProfile?, backstory?, traits?[] }, recipient: { ... },
    ///     continuation? }
    /// </summary>
    public class ConversationFamily : IPromptFamily
    {
        public string Key => "conversation";
        public string Description => "RimSynapse Conversations pawn-to-pawn dialogue (register, beat wording, the #44 voiceless fallback).";

        public IReadOnlyList<InputFieldDoc> InputContract => new[]
        {
            new InputFieldDoc("initiatorName", "string", "Pawn.Name.ToStringShort"),
            new InputFieldDoc("recipientName", "string", "Pawn.Name.ToStringShort"),
            new InputFieldDoc("beat.subject", "string", "ConversationBeatResolver", "The single concrete thing the exchange is about."),
            new InputFieldDoc("beat.initiatorStance", "string", "ConversationBeatResolver"),
            new InputFieldDoc("beat.recipientStance", "string", "ConversationBeatResolver"),
            new InputFieldDoc("beat.tone", "enum:Casual|Heartfelt|Coercive|Negotiating", "ConversationBeatResolver"),
            new InputFieldDoc("beat.framing", "enum:Shared|InitiatorTells", "ConversationBeatResolver", "InitiatorTells = recipient hears it fresh (Bill/Lipos guard)."),
            new InputFieldDoc("beat.isDeep", "bool", "InteractionDef == DeepTalk"),
            new InputFieldDoc("initiator.voiceProfile", "string", "SynapseCorePawnComp.voiceProfile", "Authored voice (may be clinical if that's the character); wins over backstory/traits."),
            new InputFieldDoc("initiator.backstory", "string", "Pawn.story.Adulthood/Childhood.title", "Anchors the #44 voiceless fallback when no voiceProfile."),
            new InputFieldDoc("initiator.traits", "string[]", "Pawn.story.traits.allTraits[..2].Label"),
            new InputFieldDoc("recipient.voiceProfile", "string", "SynapseCorePawnComp.voiceProfile"),
            new InputFieldDoc("recipient.backstory", "string", "Pawn.story.Adulthood/Childhood.title"),
            new InputFieldDoc("recipient.traits", "string[]", "Pawn.story.traits.allTraits[..2].Label"),
            new InputFieldDoc("continuation", "string", "recent PawnConversation.messages", "Recent lines to continue from (optional).")
        };

        public ComposedPrompt Compose(JObject inputs)
        {
            var beat = BuildBeat(inputs?["beat"] as JObject);
            string initId = Identity(inputs?["initiator"] as JObject);
            string recipId = Identity(inputs?["recipient"] as JObject);
            var p = ThinPromptComposer.Compose(
                Str(inputs, "initiatorName") ?? "Ana",
                Str(inputs, "recipientName") ?? "Bex",
                initId, recipId, beat, Str(inputs, "continuation"));
            return new ComposedPrompt(p.system, p.user);
        }

        public object ParseRaw(string raw, JObject inputs)
        {
            string a = Str(inputs, "initiatorName");
            string b = Str(inputs, "recipientName");
            var lines = LenientDialogueParser.ParseLinesLenient(raw)?
                .Where(l => !string.IsNullOrWhiteSpace(l))
                .Select(l => LenientDialogueParser.CleanLine(l, a, b))
                .Where(l => !string.IsNullOrWhiteSpace(l))
                .ToList();
            return lines;
        }

        // ── helpers ─────────────────────────────────────────────────────────
        private static ConversationBeat BuildBeat(JObject b)
        {
            b = b ?? new JObject();
            var beat = new ConversationBeat
            {
                subject = (string)b["subject"] ?? "",
                initiatorStance = (string)b["initiatorStance"] ?? "",
                recipientStance = (string)b["recipientStance"] ?? "",
                isDeep = (bool?)b["isDeep"] ?? false
            };
            if (System.Enum.TryParse<BeatTone>((string)b["tone"] ?? "Casual", true, out var tone)) beat.tone = tone;
            if (System.Enum.TryParse<BeatFraming>((string)b["framing"] ?? "Shared", true, out var fr)) beat.framing = fr;
            return beat;
        }

        private static string Identity(JObject id)
        {
            id = id ?? new JObject();
            var traits = (id["traits"] as JArray)?.Select(t => (string)t).ToList();
            return IdentityComposer.Identity((string)id["voiceProfile"], (string)id["backstory"], traits);
        }

        private static string Str(JObject o, string key)
        {
            var v = o?[key];
            return v == null || v.Type == JTokenType.Null ? null : (string)v;
        }

        // ── catalog (8 beats × 4 identity variants) ──────────────────────────
        public IReadOnlyList<CatalogScenario> Catalog(JObject filter)
        {
            var beatKeys = ToSet(filter?["beats"] as JArray);
            var idKeys = ToSet(filter?["identities"] as JArray);

            var list = new List<CatalogScenario>();
            foreach (var beat in Beats)
            {
                if (beatKeys != null && !beatKeys.Contains(beat.key)) continue;
                foreach (var id in Identities)
                {
                    if (idKeys != null && !idKeys.Contains(id.key)) continue;
                    var inputs = new JObject
                    {
                        ["initiatorName"] = id.initName,
                        ["recipientName"] = id.recipName,
                        ["beat"] = beat.make(),
                        ["initiator"] = id.initiator,
                        ["recipient"] = id.recipient
                    };
                    list.Add(new CatalogScenario($"conversation/{beat.key}__{id.key}", inputs));
                }
            }
            return list;
        }

        private static HashSet<string> ToSet(JArray a)
            => a == null ? null : new HashSet<string>(a.Select(x => (string)x), System.StringComparer.OrdinalIgnoreCase);

        private class BeatDef { public string key; public System.Func<JObject> make; public BeatDef(string k, System.Func<JObject> m) { key = k; make = m; } }

        private static JObject B(string subject, string initS, string recipS, string tone, string framing, bool deep)
            => new JObject { ["subject"] = subject, ["initiatorStance"] = initS, ["recipientStance"] = recipS, ["tone"] = tone, ["framing"] = framing, ["isDeep"] = deep };

        private static readonly List<BeatDef> Beats = new List<BeatDef>
        {
            new BeatDef("event-shared",   () => B("the raid two nights ago, when the east wall nearly came down", "recounting how it actually went", "adding what they remember of it", "Casual", "Shared", false)),
            new BeatDef("event-tells",    () => B("the raid two nights ago, when the east wall nearly came down", "recounting how it actually went", "hearing it for the first time and reacting", "Casual", "InitiatorTells", false)),
            new BeatDef("deep-burden",    () => B("losing their brother in the collapse of their last settlement", "finally letting it out, quiet and raw", "listening closely", "Heartfelt", "Shared", true)),
            new BeatDef("activity",       () => B("the cooking they've been busy with", "making passing conversation about it", "chatting back", "Casual", "Shared", false)),
            new BeatDef("pressing-state", () => B("how they're hungry and running low right now", "not hiding that it's wearing on them", "chatting back, themselves dead on their feet from no sleep", "Casual", "Shared", false)),
            new BeatDef("observation",    () => B("the foggy weather outside", "just making small talk", "chatting back", "Casual", "Shared", false)),
            new BeatDef("environmental",  () => B("walking into the freezing cold freezer and complaining about the chilling temperature", "remarking on it out loud as it happens, just in passing", "reacting to the offhand comment", "Casual", "Shared", false)),
            new BeatDef("coercive",       () => B("whether the prisoner will give in and join the colony", "pressing them hard to submit and join, leaning on fear", "wary and resistant, weighing whether they have a choice", "Coercive", "Shared", false)),
        };

        private class IdentityDef { public string key; public string initName; public string recipName; public JObject initiator; public JObject recipient; }

        private static JObject Voiced(string v) => new JObject { ["voiceProfile"] = v };
        private static JObject Back(string b, params string[] traits) => new JObject { ["backstory"] = b, ["traits"] = new JArray(traits) };

        private static readonly List<IdentityDef> Identities = new List<IdentityDef>
        {
            new IdentityDef { key = "voiced-rich", initName = "Wren", recipName = "Cass",
                initiator = Voiced("warm and wry, talks in short bursts with a dry, teasing humor and a lot of shrugging"),
                recipient = Voiced("soft-spoken and earnest, tends to over-explain and circle back to reassure people") },
            new IdentityDef { key = "voiced-clinical", initName = "Dr. Voss", recipName = "Unit-7",
                initiator = Voiced("precise and detached, narrates feelings as data points and refers to people and events in clinical, systems terms"),
                recipient = Voiced("flat and technical, quantifies everything and prefers jargon to plain words") },
            new IdentityDef { key = "voiceless-with-backstory", initName = "Ana", recipName = "Bex",
                initiator = Back("Nomad wanderer", "Kind", "Tough"),
                recipient = Back("Colony cook", "Gourmand") },
            new IdentityDef { key = "voiceless-bare", initName = "Ana", recipName = "Bex",
                initiator = new JObject(), recipient = new JObject() },
        };
    }
}
