using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace RimSynapse.PromptLab
{
    /// <summary>
    /// Universal, game-free entry point. Reads a job (--job file, or stdin), resolves the requested prompt
    /// family from the registry, builds each scenario's prompt through that family's PURE composer, optionally
    /// sends it to the configured local model, and prints the RAW response (+ composed prompt, optional
    /// family parse, metadata) as one JSON object to stdout (progress → stderr). It does NOT judge.
    /// </summary>
    public static class Program
    {
        public static async Task<int> Main(string[] args)
        {
            try { Console.OutputEncoding = new System.Text.UTF8Encoding(false); } catch { }

            try
            {
                if (args.Contains("--help") || args.Contains("-h")) { Console.Error.WriteLine(HelpText); return 0; }

                if (args.Contains("--list-families"))
                {
                    EmitStdout(new
                    {
                        ok = true,
                        families = Registry.All.OrderBy(f => f.Key).Select(f => new
                        {
                            key = f.Key,
                            description = f.Description,
                            catalogSize = SafeCatalogCount(f),
                            inputContract = f.InputContract
                        })
                    });
                    return 0;
                }

                LabJob job = LoadJob(args);
                ApplyCliOverrides(job, args);

                if (string.IsNullOrEmpty(job.family))
                {
                    EmitStdout(Err($"no family given. Known families: {string.Join(", ", Registry.Keys)}"));
                    return 2;
                }
                var family = Registry.Get(job.family);
                if (family == null)
                {
                    EmitStdout(Err($"unknown family '{job.family}'. Known: {string.Join(", ", Registry.Keys)} " +
                                   "(a family whose mod source is absent from the workspace is not compiled in)."));
                    return 2;
                }

                // Resolve the scenarios: suite = the family's catalog (optionally filtered); scenario = the
                // caller's own inputs.
                List<(string id, JObject inputs)> scenarios;
                if (string.Equals(job.mode, "suite", StringComparison.OrdinalIgnoreCase))
                    scenarios = family.Catalog(job.suiteFilter).Select(c => (c.id, c.inputs)).ToList();
                else
                    scenarios = (job.scenarios ?? new List<LabScenario>())
                        .Select((s, i) => (s.id ?? $"{family.Key}/scenario-{i + 1}", s.inputs ?? new JObject())).ToList();

                if (scenarios.Count == 0)
                {
                    EmitStdout(Err("no scenarios (scenario mode needs job.scenarios; suite mode needs a non-empty catalog/filter)"));
                    return 2;
                }

                EffectiveEndpoint ep = CoreConfigReader.Resolve(job.config);
                int runs = Math.Max(1, job.runs);
                int timeout = job.config?.timeoutSeconds ?? 120;

                if (!job.dryRun && ep.autoMapModel && !ep.modelWasExplicit && IsPlaceholderModel(ep.model))
                {
                    string discovered = await LlmCaller.DiscoverModelAsync(ep.baseUrl, ep.apiKey, Math.Min(15, timeout));
                    if (!string.IsNullOrEmpty(discovered))
                    {
                        Console.Error.WriteLine($"[promptlab] auto-mapped model '{ep.model}' -> '{discovered}'");
                        ep.model = discovered;
                    }
                }

                Console.Error.WriteLine($"[promptlab] family={family.Key} {scenarios.Count} scenario(s) x {runs} run(s) -> {ep.provider} {ep.baseUrl} model={ep.model} dryRun={job.dryRun} ({ep.configSource})");

                var results = new List<ScenarioResult>();
                foreach (var sc in scenarios)
                    for (int run = 1; run <= runs; run++)
                        results.Add(await RunOne(family, sc.id, sc.inputs, run, ep, job.dryRun, timeout));

                var okResults = results.Where(r => r.ok).ToList();
                EmitStdout(new LabOutput
                {
                    ok = true,
                    family = family.Key,
                    dryRun = job.dryRun,
                    runs = runs,
                    scenarioCount = scenarios.Count,
                    endpoint = new ResolvedEndpoint
                    {
                        provider = ep.provider, baseUrl = ep.baseUrl, model = ep.model,
                        hasApiKey = !string.IsNullOrEmpty(ep.apiKey), disableThinking = ep.disableThinking,
                        configSource = ep.configSource
                    },
                    results = results,
                    summary = new LabSummary
                    {
                        total = results.Count,
                        okCount = okResults.Count,
                        failCount = results.Count - okResults.Count,
                        meanLatencyMs = okResults.Count > 0 ? (long)okResults.Average(r => r.latencyMs) : 0
                    }
                });
                return 0;
            }
            catch (Exception ex)
            {
                EmitStdout(Err(ex.GetType().Name + ": " + ex.Message));
                return 1;
            }
        }

        private static async Task<ScenarioResult> RunOne(IPromptFamily family, string id, JObject inputs, int run,
            EffectiveEndpoint ep, bool dryRun, int timeout)
        {
            var res = new ScenarioResult { scenarioId = id, run = run };
            try
            {
                ComposedPrompt prompt = family.Compose(inputs);
                res.system = prompt.system;
                res.user = prompt.user;

                if (dryRun) { res.ok = true; return res; }

                LlmCallResult call = await LlmCaller.CallAsync(ep, prompt, timeout);
                res.latencyMs = call.latencyMs;
                if (!call.ok) { res.ok = false; res.error = call.error; return res; }

                res.raw = call.content;
                try { res.parsed = family.ParseRaw(call.content, inputs); } catch (Exception pe) { res.parseError = pe.Message; }
                res.ok = true;
                Console.Error.WriteLine($"[promptlab]   {id} run{run} {call.latencyMs}ms");
                return res;
            }
            catch (Exception ex)
            {
                res.ok = false;
                res.error = ex.GetType().Name + ": " + ex.Message;
                return res;
            }
        }

        private static int SafeCatalogCount(IPromptFamily f) { try { return f.Catalog(null).Count; } catch { return -1; } }

        private static LabJob LoadJob(string[] args)
        {
            string jobPath = ArgValue(args, "--job");
            if (jobPath == null) return new LabJob();
            string raw = jobPath == "-" ? Console.In.ReadToEnd() : File.ReadAllText(jobPath);
            var job = JsonConvert.DeserializeObject<LabJob>(raw) ?? new LabJob();
            job.config = job.config ?? new LabConfig();
            return job;
        }

        private static void ApplyCliOverrides(LabJob job, string[] args)
        {
            job.config = job.config ?? new LabConfig();
            if (args.Contains("--suite")) job.mode = "suite";
            if (args.Contains("--dry-run")) job.dryRun = true;
            string v;
            if ((v = ArgValue(args, "--family")) != null) job.family = v;
            if ((v = ArgValue(args, "--endpoint")) != null) job.config.endpoint = v;
            if ((v = ArgValue(args, "--model")) != null) job.config.model = v;
            if ((v = ArgValue(args, "--provider")) != null) job.config.provider = v;
            if ((v = ArgValue(args, "--api-key")) != null) job.config.apiKey = v;
            if ((v = ArgValue(args, "--config-dir")) != null) job.config.configDir = v;
            if ((v = ArgValue(args, "--temperature")) != null && float.TryParse(v, out var t)) job.config.temperature = t;
            if ((v = ArgValue(args, "--runs")) != null && int.TryParse(v, out var r)) job.runs = r;
        }

        private static string ArgValue(string[] args, string name)
        {
            int i = Array.IndexOf(args, name);
            return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
        }

        private static bool IsPlaceholderModel(string m)
            => string.IsNullOrWhiteSpace(m) || m == "local-model" || m == "jan-model";

        private static LabOutput Err(string msg) => new LabOutput { ok = false, error = msg };
        private static void EmitStdout(object o) => Console.Out.WriteLine(JsonConvert.SerializeObject(o, Formatting.Indented));

        private const string HelpText =
            "PromptLab — universal game-free RimSynapse prompt/response harness.\n" +
            "  --job <file|->      Read a job JSON { family, mode, scenarios|suiteFilter, runs, dryRun, config }.\n" +
            "  --family <key>      Which prompt family (see --list-families).\n" +
            "  --suite / --dry-run Run the family catalog / build prompts without calling the model.\n" +
            "  --list-families     Print registered families + their input contracts and exit.\n" +
            "  --provider/--endpoint/--model/--api-key/--config-dir/--temperature/--runs  Overrides.\n" +
            "Prints one JSON object (raw responses + composed prompts + metadata) to stdout; progress to stderr.";
    }

    // ── job / output DTOs ───────────────────────────────────────────────────
    public class LabJob
    {
        public string family;
        public string mode = "suite";
        public List<LabScenario> scenarios = new List<LabScenario>();
        public JObject suiteFilter;
        public int runs = 1;
        public bool dryRun = false;
        public LabConfig config = new LabConfig();
    }

    public class LabScenario
    {
        public string id;
        public JObject inputs;
    }

    public class ScenarioResult
    {
        public string scenarioId;
        public int run;
        public string system;
        public string user;
        public string raw;
        public object parsed;
        public string parseError;
        public long latencyMs;
        public bool ok;
        public string error;
    }

    public class LabOutput
    {
        public bool ok;
        public string error;
        public string family;
        public ResolvedEndpoint endpoint;
        public int scenarioCount;
        public int runs;
        public bool dryRun;
        public LabSummary summary;
        public List<ScenarioResult> results = new List<ScenarioResult>();
    }

    public class ResolvedEndpoint
    {
        public string provider;
        public string baseUrl;
        public string model;
        public bool hasApiKey;
        public bool disableThinking;
        public string configSource;
    }

    public class LabSummary
    {
        public int total;
        public int okCount;
        public int failCount;
        public long meanLatencyMs;
    }
}
