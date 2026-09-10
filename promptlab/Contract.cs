using System.Collections.Generic;
using Newtonsoft.Json.Linq;

namespace RimSynapse.PromptLab
{
    /// <summary>A system+user message pair. Splitting them matters: a chat completion with only a system
    /// message and no user turn makes a local model return an empty acknowledgement instead of generating —
    /// the concrete content has to arrive as the USER message (the WorldNews pattern the mods follow).</summary>
    public struct ComposedPrompt
    {
        public string system;
        public string user;
        public ComposedPrompt(string system, string user) { this.system = system; this.user = user; }
    }

    /// <summary>One documented input field a family consumes — surfaced by <c>list_prompt_families</c> so a
    /// caller (or a fixture capturer) knows what to supply, its type, and where the game gets it from.</summary>
    public class InputFieldDoc
    {
        public string name;
        public string type;         // "string" | "int" | "enum:Casual|Heartfelt|..." | "string[]" | "object" ...
        public string provenance;   // where the game reads it, e.g. "SynapseCorePawnComp.voiceProfile"
        public string description;

        public InputFieldDoc(string name, string type, string provenance, string description = null)
        {
            this.name = name; this.type = type; this.provenance = provenance; this.description = description;
        }
    }

    /// <summary>One named scenario from a family's built-in catalog: an id plus the concrete inputs.</summary>
    public class CatalogScenario
    {
        public string id;
        public JObject inputs;
        public CatalogScenario(string id, JObject inputs) { this.id = id; this.inputs = inputs; }
    }

    /// <summary>
    /// A prompt family = one LLM call site made testable. Implement this to add a call site to the universal
    /// lab. The registry discovers implementors by reflection, so a family that isn't compiled in (its mod
    /// source is absent from the workspace) simply doesn't exist — no wiring to touch.
    ///
    /// Faithful rule: <see cref="Compose"/> must delegate to the mod's PURE composer (linked from the mod's
    /// source), never reimplement the prompt here.
    /// </summary>
    public interface IPromptFamily
    {
        /// <summary>Stable key, e.g. "conversation", "newspaper", "psychology.childhood".</summary>
        string Key { get; }

        string Description { get; }

        /// <summary>The inputs this family consumes (for discovery / fixture capture).</summary>
        IReadOnlyList<InputFieldDoc> InputContract { get; }

        /// <summary>Build the exact system+user prompt from the family-specific <paramref name="inputs"/>.</summary>
        ComposedPrompt Compose(JObject inputs);

        /// <summary>Optional family-specific structured view of the RAW model output (e.g. dialogue lines,
        /// a parsed issue). May return null — the raw response is always returned regardless; parsing/judging
        /// is the consumer's job.</summary>
        object ParseRaw(string raw, JObject inputs);

        /// <summary>The built-in scenario catalog (suite mode), optionally narrowed by a family-specific
        /// <paramref name="filter"/> (may be null).</summary>
        IReadOnlyList<CatalogScenario> Catalog(JObject filter);
    }
}
