using System;
using System.IO;
using System.Linq;
using System.Xml.Linq;

namespace RimSynapse.PromptLab
{
    /// <summary>The place to send a request — after Core config + overrides + defaults.</summary>
    public class EffectiveEndpoint
    {
        public string provider;
        public string baseUrl;
        public string model;
        public string apiKey;
        public bool disableThinking;
        public float? temperature;
        public string configSource;
        public bool autoMapModel;
        public bool modelWasExplicit;
    }

    /// <summary>Optional overrides for where the model is / how to reach it. Any field left null resolves from
    /// the live Core mod config.</summary>
    public class LabConfig
    {
        public string configDir;
        public string provider;
        public string endpoint;
        public string model;
        public string apiKey;
        public float? temperature;
        public bool? disableThinking;
        public int timeoutSeconds = 120;
    }

    /// <summary>
    /// Reads the SAME live Core mod config the game reads (<c>Mod_Core_RimSynapseMod.xml</c> under the active
    /// RimWorld <c>Config</c> dir) and resolves the effective provider -> endpoint/model/key, so the lab hits
    /// the exact model the game would. Overrides win; missing everywhere falls back to Core's Local_LMStudio
    /// defaults. Tolerant of naming/shape drift: it scans for the Core settings file and reads elements by name.
    /// </summary>
    public static class CoreConfigReader
    {
        private const string DefaultLmStudioUrl = "http://127.0.0.1:1234";
        private const string DefaultModelLocal = "local-model";

        public static EffectiveEndpoint Resolve(LabConfig cfg)
        {
            cfg = cfg ?? new LabConfig();

            string configDir = ResolveConfigDir(cfg.configDir);
            string configFile = FindCoreConfigFile(configDir);
            XElement root = null;
            if (configFile != null)
            {
                try { root = XDocument.Load(configFile).Root; } catch { root = null; }
            }

            string provider = cfg.provider ?? Read(root, "apiProvider") ?? "Local_LMStudio";

            string urlField, keyField, modelField, defaultUrl, defaultModel;
            switch (provider)
            {
                case "OpenAI":           urlField = "openAiUrl";   keyField = "openAiApiKey";   modelField = "modelOpenAi";  defaultUrl = "https://api.openai.com/v1"; defaultModel = "gpt-5-chat-latest"; break;
                case "Google_Gemini":    urlField = "geminiUrl";   keyField = "geminiApiKey";   modelField = "modelGemini";  defaultUrl = "https://generativelanguage.googleapis.com/v1beta/openai"; defaultModel = "gemini-flash-lite-latest"; break;
                case "Anthropic_Claude": urlField = "claudeUrl";   keyField = "claudeApiKey";   modelField = "modelClaude";  defaultUrl = "https://api.anthropic.com/v1"; defaultModel = "claude-opus-4-6"; break;
                case "Jan":              urlField = "janUrl";      keyField = "janApiKey";      modelField = "modelJan";     defaultUrl = "http://127.0.0.1:1337/v1"; defaultModel = "jan-model"; break;
                case "Custom":           urlField = "customUrl";   keyField = "customApiKey";   modelField = "modelCustom";  defaultUrl = ""; defaultModel = ""; break;
                default:                 urlField = "lmStudioUrl"; keyField = "lmStudioApiKey"; modelField = "modelLocal";   defaultUrl = DefaultLmStudioUrl; defaultModel = DefaultModelLocal; break;
            }

            string baseUrl = cfg.endpoint ?? Read(root, urlField) ?? defaultUrl;

            string selected = Read(root, "selectedModel");
            string model = cfg.model
                ?? (string.IsNullOrEmpty(selected) ? null : selected)
                ?? Read(root, modelField)
                ?? defaultModel;

            string apiKey = cfg.apiKey ?? Read(root, keyField) ?? "";

            bool disableThinking = cfg.disableThinking ?? ParseBool(Read(root, "disableThinking"), true);
            bool autoMapModel = ParseBool(Read(root, "autoMapModel"), true);

            string source = cfg.endpoint != null || cfg.model != null || cfg.provider != null
                ? "cli-override"
                : (configFile != null ? $"core-config:{configFile}" : "defaults");

            return new EffectiveEndpoint
            {
                provider = provider,
                baseUrl = (baseUrl ?? "").Trim(),
                model = model,
                apiKey = apiKey,
                disableThinking = disableThinking,
                temperature = cfg.temperature,
                configSource = source,
                autoMapModel = autoMapModel,
                modelWasExplicit = cfg.model != null
            };
        }

        public static string ResolveConfigDir(string overrideDir)
        {
            if (!string.IsNullOrEmpty(overrideDir)) return overrideDir;
            string profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            return Path.Combine(profile, "AppData", "LocalLow", "Ludeon Studios",
                "RimWorld by Ludeon Studios", "Config");
        }

        public static string FindCoreConfigFile(string configDir)
        {
            if (string.IsNullOrEmpty(configDir) || !Directory.Exists(configDir)) return null;

            string exact = Path.Combine(configDir, "Mod_Core_RimSynapseMod.xml");
            if (File.Exists(exact)) return exact;

            foreach (var f in Directory.EnumerateFiles(configDir, "Mod_*.xml"))
            {
                try
                {
                    string head = File.ReadAllText(f);
                    if (head.IndexOf("lmStudioUrl", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        head.IndexOf("apiProvider", StringComparison.OrdinalIgnoreCase) >= 0)
                        return f;
                }
                catch { /* skip unreadable */ }
            }
            return null;
        }

        private static string Read(XElement root, string name)
        {
            if (root == null) return null;
            var el = root.Descendants(name).FirstOrDefault();
            string v = el?.Value;
            return string.IsNullOrWhiteSpace(v) ? null : v.Trim();
        }

        private static bool ParseBool(string v, bool fallback)
            => string.IsNullOrEmpty(v) ? fallback : v.Trim().Equals("true", StringComparison.OrdinalIgnoreCase);
    }
}
