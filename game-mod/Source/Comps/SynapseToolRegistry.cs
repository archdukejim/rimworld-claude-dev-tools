using System;
using System.Collections.Generic;
using System.Linq;
using RimWorld;
using Verse;
using Newtonsoft.Json;

namespace RimAgentic
{
    /// <summary>
    /// Describes a single game tool an agent can invoke.
    /// </summary>
    public class GameTool
    {
        public string name;
        public string description;
        public object parameters; // JSON Schema parameter description
        public Func<string, string> handler;
        public bool isDebugAction = false;
        public List<string> keywords = new List<string>();

        /// <summary>
        /// True when calling this tool changes game state (as opposed to reading it).
        /// Autonomous runs may be barred from mutating tools; player-initiated runs are unaffected.
        /// </summary>
        public bool isMutating = false;
    }

    /// <summary>
    /// Central registry for all game tools an agent can call.
    /// Tool handler registrations are split across partial-class files in the Tools/ subfolder.
    /// </summary>
    public static partial class SynapseToolRegistry
    {
        private static readonly Dictionary<string, GameTool> _tools = new Dictionary<string, GameTool>();
        private static bool _initialized = false;

        // Kept binary-compatible: companion mods are compiled against this exact signature,
        // so isMutating is a separate overload rather than an appended optional parameter.
        public static void RegisterTool(string name, string description, object parametersSchema, Func<string, string> handler, bool isDebug = false, List<string> keywords = null)
        {
            RegisterToolCore(name, description, parametersSchema, handler, isDebug, keywords);
            SynapseToolIndex.Invalidate();
        }

        public static void RegisterTool(string name, string description, object parametersSchema, Func<string, string> handler, bool isDebug, List<string> keywords, bool isMutating)
        {
            RegisterToolCore(name, description, parametersSchema, handler, isDebug, keywords);
            if (isMutating && _tools.TryGetValue(name, out var registered))
            {
                registered.isMutating = true;
            }
            SynapseToolIndex.Invalidate();
        }

        /// <summary>
        /// Flag already-registered tools as state-mutating by name. Unknown names are
        /// ignored, so the manifest can safely mention tools other mods may not register.
        /// </summary>
        public static void MarkMutating(params string[] names)
        {
            EnsureInitialized();
            foreach (var n in names)
            {
                if (!string.IsNullOrEmpty(n) && _tools.TryGetValue(n, out var tool))
                {
                    tool.isMutating = true;
                }
            }
        }

        private static void RegisterToolCore(string name, string description, object parametersSchema, Func<string, string> handler, bool isDebug, List<string> keywords)
        {
            EnsureInitialized();
            _tools[name] = new GameTool
            {
                name = name,
                description = description,
                parameters = parametersSchema,
                handler = handler,
                isDebugAction = isDebug,
                keywords = keywords ?? new List<string>()
            };
        }

        public static IEnumerable<GameTool> AllTools
        {
            get
            {
                EnsureInitialized();
                return _tools.Values;
            }
        }

        public static IEnumerable<GameTool> NonDebugTools
        {
            get
            {
                EnsureInitialized();
                return _tools.Values.Where(t => !t.isDebugAction);
            }
        }

        /// <summary>
        /// Whether a tool is registered. Callers that dispatch a caller-supplied name should
        /// check this first: ExecuteTool answers an unknown name with an error payload rather
        /// than throwing, which is easy to mistake for a tool's own output.
        /// </summary>
        public static bool IsToolRegistered(string name)
        {
            if (string.IsNullOrEmpty(name)) return false;
            EnsureInitialized();
            return _tools.ContainsKey(name);
        }

        public static string ExecuteTool(string name, string argumentsJson)
        {
            return ExecuteTool(name, argumentsJson, allowMutating: true);
        }

        /// <summary>
        /// Execute a tool, optionally refusing state-mutating ones.
        /// </summary>
        public static string ExecuteTool(string name, string argumentsJson, bool allowMutating)
        {
            EnsureInitialized();
            if (_tools.TryGetValue(name, out var tool))
            {
                if (!allowMutating && tool.isMutating)
                {
                    return $"{{\"error\": \"Tool '{name}' changes game state and this run is not permitted to mutate. Use a read-only tool.\"}}";
                }

                try
                {
                    return tool.handler(argumentsJson);
                }
                catch (Exception ex)
                {
                    return $"{{\"error\": \"Exception during tool execution: {ex.Message}\"}}";
                }
            }
            return $"{{\"error\": \"Tool '{name}' not found.\"}}";
        }

        public static void EnsureInitialized()
        {
            if (_initialized) return;
            _initialized = true;

            // Register Built-in Tools
            RegisterMetaTools();
            RegisterResultTools();
            RegisterColonistTools();
            RegisterStockpileTools();
            RegisterThreatTools();
            RegisterMoodTools();
            RegisterIncidentTools();
            RegisterPawnStateTools();
            RegisterSearchTools();
            RegisterDefinitionTools();
            RegisterObjectStateTools();
            RegisterEnvironmentTools();
            RegisterWindowTools();
            RegisterApiDumpTools();
            RegisterIconDumpTools();       // dump_item_icons (uiIcon -> PNG library for infographics)
            RegisterPerfTools();
            RegisterPerfScenarioTools();
            RegisterSaveTools();
            RegisterMapBuildTools();
            RegisterEnvControlTools();
            RegisterGizmoTools();
            RegisterColonistBarTools();
            RegisterPlaySettingsTools();
            RegisterWindowContentTools();  // read_window / invoke_window_control (immediate-mode UI capture)
            RegisterDynamicDebugActions();
            RegisterDebugActionBridge();   // generic list_debug_actions / run_debug_action over ALL mod assemblies

            // Centralized synonym keyword registrations
            AssignDefaultKeywords();

            // Mutating manifest: the direct-action tools that change game state.
            // execute_game_tool is included because it can invoke anything by name —
            // leaving it unflagged would let a gated run launder mutations through it.
            // load_game replaces the running session; save_game only writes a file, so it stays
            // read-only and a gated/read-only run can still checkpoint before it ends.
            MarkMutating(
                "modify_pawn_state",
                "load_game",
                "execute_game_tool");
            // EnvControlTools' state-changing tools (set_weather, set_time, fill_rect, build_room) are
            // flagged isMutating at registration, same as MapBuildTools' spawn_thing/set_roof — nothing
            // to add here. sample_environment is read-only and move_camera only moves the view.
        }

        private static void AssignDefaultKeywords()
        {
            AssignKeywords("modify_pawn_state", new List<string> {
                "shooting", "melee", "construction", "mining", "cooking", "plants", "animals", "crafting",
                "artistic", "medicine", "social", "intellectual", "skill", "passion", "trait", "degree",
                "lazy", "industrious", "cannibal", "bipolar", "psychic", "jogger", "neurotic", "health",
                "wound", "flu", "infection", "hediff", "cut", "amputate", "remove", "part", "severity",
                "pain", "bleed", "convert", "ideology", "religion"
            });

            AssignKeywords("spawn_incident", new List<string> {
                "raid", "incident", "event", "threat", "mechanoid", "infestation", "trader", "quest"
            });

            AssignKeywords("create_stockpile", new List<string> {
                "stockpile", "storage", "zone", "dump", "filter"
            });

            AssignKeywords("modify_mood", new List<string> {
                "mood", "happy", "sad", "joy", "need", "comfort"
            });
        }

        private static void AssignKeywords(string toolName, List<string> kw)
        {
            if (_tools.TryGetValue(toolName, out var tool))
            {
                tool.keywords = kw;
            }
        }
    }
}
