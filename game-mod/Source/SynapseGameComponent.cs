using System;
using System.Collections.Concurrent;
using Verse;

namespace RimAgentic
{
    /// <summary>
    /// GameComponent that bridges async background work back to Unity's main thread and
    /// backs the developer file-drop tool channel (tool_input.json -> tool_output.json).
    /// Processes queued callbacks every Unity frame (including while paused) via GameComponentUpdate.
    /// </summary>
    public class SynapseGameComponent : GameComponent
    {
        private static readonly ConcurrentQueue<Action> _mainThreadQueue = new ConcurrentQueue<Action>();

        /// <summary>Max callbacks to process per frame to avoid frame drops.</summary>
        private const int MaxCallbacksPerFrame = 5;

        private static int _fileCheckCooldown = 0;

        public SynapseGameComponent(Game game) { }

        /// <summary>
        /// Scripts mid-run travel with the save as one JSON string. Saves from before this
        /// feature have no entry, so the string loads as null and restore is a no-op.
        /// </summary>
        public override void ExposeData()
        {
            base.ExposeData();

            string persistedScripts = null;
            if (Scribe.mode == LoadSaveMode.Saving)
            {
                persistedScripts = SynapseScriptRunner.SnapshotForSave();
            }

            Scribe_Values.Look(ref persistedScripts, "synapseActiveScripts");

            if (Scribe.mode == LoadSaveMode.LoadingVars)
            {
                SynapseScriptRunner.ClearForLoad();
                SynapseScriptRunner.RestoreFromSave(persistedScripts);
            }
        }

        /// <summary>
        /// Enqueue an action to run on the main thread during the next frame.
        /// Thread-safe — can be called from any background thread.
        /// </summary>
        public static void Enqueue(Action action)
        {
            if (action == null) return;
            _mainThreadQueue.Enqueue(action);
        }

        /// <summary>
        /// Clears the main thread callback queue.
        /// </summary>
        public static void ClearMainThreadQueue()
        {
            while (_mainThreadQueue.TryDequeue(out _)) { }
        }

        public static void ProcessMainThreadQueue()
        {
            int processed = 0;
            while (processed < MaxCallbacksPerFrame && _mainThreadQueue.TryDequeue(out var action))
            {
                try
                {
                    action();
                }
                catch (Exception ex)
                {
                    ToolkitLog.Error($"Callback error: {ex}");
                }
                processed++;
            }
        }

        /// <summary>
        /// Called every Unity frame on the main thread — even while paused.
        /// Processes queued callbacks and polls the tool file channel.
        /// </summary>
        public override void GameComponentUpdate()
        {
            ProcessMainThreadQueue();

            // Frame-time sample for the performance profiler (main thread, every frame).
            PerfProfiler.RecordFrame(UnityEngine.Time.deltaTime);

            _fileCheckCooldown++;
            if (_fileCheckCooldown >= 60)
            {
                _fileCheckCooldown = 0;
                PollScriptInputFile();
            }
        }

        public override void GameComponentTick()
        {
            SynapseScriptRunner.Tick();
        }

        public override void FinalizeInit()
        {
            base.FinalizeInit();
            ToolkitLog.Message("Game loaded. Main-thread dispatcher active (frame-based, pause-aware).");
        }

        public override void StartedNewGame()
        {
            base.StartedNewGame();
            ClearMainThreadQueue();
            ToolkitLog.Message("Started new game. Queues cleared.");
        }

        public override void LoadedGame()
        {
            base.LoadedGame();
            ClearMainThreadQueue();
            ToolkitLog.Message("Loaded game. Queues cleared.");
        }

        /// <summary>
        /// Directory backing the developer file-drop channel.
        ///
        /// Resolved from the RIMAGENTIC_IPC_DIR environment variable when it is set and the
        /// directory exists; otherwise falls back to the mod's own content folder. Both ends
        /// of the channel (game + MCP server) must agree on this path or it silently does
        /// nothing, so the resolved path is logged once.
        /// </summary>
        private static string _scriptingDir;
        private static string ScriptingDir
        {
            get
            {
                if (_scriptingDir != null) return _scriptingDir;

                string envDir = System.Environment.GetEnvironmentVariable("RIMAGENTIC_IPC_DIR");
                if (!string.IsNullOrEmpty(envDir))
                {
                    _scriptingDir = envDir;
                    LogResolvedDir("RIMAGENTIC_IPC_DIR");
                }
                else
                {
                    // Fixed shared default the game mod and the MCP server both compute the same
                    // way: %LOCALAPPDATA%\RimAgentic\ipc. No env-var coordination required.
                    string local = System.Environment.GetFolderPath(System.Environment.SpecialFolder.LocalApplicationData);
                    _scriptingDir = System.IO.Path.Combine(local, "RimAgentic", "ipc");
                    LogResolvedDir("default %LOCALAPPDATA%\\RimAgentic\\ipc");
                }

                try { System.IO.Directory.CreateDirectory(_scriptingDir); } catch { }
                return _scriptingDir;
            }
        }

        /// <summary>Announce the directory the file bridge will poll, once, naming how it was resolved.</summary>
        private static void LogResolvedDir(string via)
        {
            try
            {
                ToolkitLog.Message($"Tool bridge polling directory: {_scriptingDir} (resolved via {via}).");
            }
            catch { }
        }

        private static string ScriptingPath(string fileName)
        {
            return System.IO.Path.Combine(ScriptingDir, fileName);
        }

        private void PollScriptInputFile()
        {
            try
            {
                string toolInputPath = ScriptingPath("tool_input.json");
                string toolOutputPath = ScriptingPath("tool_output.json");

                // Poll tool execution
                if (System.IO.File.Exists(toolInputPath))
                {
                    string json = System.IO.File.ReadAllText(toolInputPath);
                    System.IO.File.Delete(toolInputPath);

                    if (System.IO.File.Exists(toolOutputPath))
                    {
                        System.IO.File.Delete(toolOutputPath);
                    }

                    Enqueue(() =>
                    {
                        try
                        {
                            var request = Newtonsoft.Json.JsonConvert.DeserializeObject<ToolRequest>(json);
                            if (request != null && !string.IsNullOrEmpty(request.name))
                            {
                                string argsStr = request.arguments != null ? Newtonsoft.Json.JsonConvert.SerializeObject(request.arguments) : "{}";
                                string result = SynapseToolRegistry.ExecuteTool(request.name, argsStr);
                                System.IO.File.WriteAllText(toolOutputPath, result);
                            }
                            else
                            {
                                System.IO.File.WriteAllText(toolOutputPath, "{\"error\": \"Invalid tool request format.\"}");
                            }
                        }
                        catch (Exception ex)
                        {
                            try
                            {
                                System.IO.File.WriteAllText(toolOutputPath, $"{{\"error\": {Newtonsoft.Json.JsonConvert.SerializeObject(ex.Message)}}}");
                            }
                            catch {}
                        }
                    });
                }
            }
            catch (Exception ex)
            {
                Log.Warning($"[RimAgentic] Failed to poll tool files: {ex.Message}");
            }
        }
    }

    public class ToolRequest
    {
        public string name;
        public object arguments;
    }
}
