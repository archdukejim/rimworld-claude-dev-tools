using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Reflection;
using HarmonyLib;
using Newtonsoft.Json;
using RimWorld;
using UnityEngine;
using Verse;

namespace RimAgentic
{
    /// <summary>
    /// Our own lightweight performance profiler — a self-contained alternative to Dubs Performance
    /// Analyzer that needs no third-party mod and emits agent-consumable JSON over the tool bridge.
    ///
    /// Two layers:
    ///  - Always-on sampling: a Harmony patch on TickManager.DoSingleTick times each game tick, the
    ///    GameComponent samples frame time, and we read TPS-vs-target and GC pressure. Cheap enough
    ///    to leave running.
    ///  - On-demand method profiling: point a shared timing prefix/postfix at any set of methods and
    ///    read back per-method total/avg/max/calls plus ms-per-tick attribution.
    ///
    /// Everything here runs on the Unity main thread (game tick, frame update, and bridge tool
    /// handlers all dispatch there), so the sampling ring buffers need no locking; only the method
    /// accumulator takes a lock, in case a profiled method is itself called off-thread by some mod.
    /// </summary>
    public static class PerfProfiler
    {
        private static readonly double MsPerStopwatchTick = 1000.0 / Stopwatch.Frequency;

        // --- Tick sampling (main thread only) ---
        private const int TickRing = 512;
        private static readonly double[] _tickMs = new double[TickRing];
        private static readonly double[] _tickAtSec = new double[TickRing]; // realtime stamp per tick, for TPS
        private static int _tickHead = 0;
        private static int _tickCount = 0;
        private static long _ticksObserved = 0; // lifetime, used for method ms/tick attribution

        // --- Frame sampling (main thread only) ---
        private const int FrameRing = 300;
        private static readonly double[] _frameMs = new double[FrameRing];
        private static int _frameHead = 0;
        private static int _frameCount = 0;

        /// <summary>Lifetime count of ticks the sampler has seen (for ms/tick attribution windows).</summary>
        public static long TicksObserved => _ticksObserved;

        private static double NowSec()
        {
            return Stopwatch.GetTimestamp() * (1.0 / Stopwatch.Frequency);
        }

        /// <summary>Record one game tick's wall-clock duration (raw stopwatch ticks). Called from the DoSingleTick patch.</summary>
        public static void RecordTick(long stopwatchTicks)
        {
            double ms = stopwatchTicks * MsPerStopwatchTick;
            _tickMs[_tickHead] = ms;
            _tickAtSec[_tickHead] = NowSec();
            _tickHead = (_tickHead + 1) % TickRing;
            if (_tickCount < TickRing) _tickCount++;
            _ticksObserved++;
            PerfBenchmark.OnTick(ms);
        }

        /// <summary>Record one rendered frame's duration (seconds, e.g. Time.deltaTime). Called every frame.</summary>
        public static void RecordFrame(double seconds)
        {
            if (seconds <= 0) return;
            _frameMs[_frameHead] = seconds * 1000.0;
            _frameHead = (_frameHead + 1) % FrameRing;
            if (_frameCount < FrameRing) _frameCount++;
        }

        private static void RingStats(double[] ring, int count, out double avg, out double max, out double p95)
        {
            avg = 0; max = 0; p95 = 0;
            if (count <= 0) return;
            var buf = new double[count];
            double sum = 0;
            for (int i = 0; i < count; i++) { double v = ring[i]; buf[i] = v; sum += v; if (v > max) max = v; }
            avg = sum / count;
            Array.Sort(buf);
            p95 = buf[Math.Min(count - 1, (int)Math.Ceiling(count * 0.95) - 1)];
        }

        private static double RecentTps()
        {
            if (_tickCount <= 0) return 0;
            double now = NowSec();
            int n = 0;
            for (int i = 0; i < _tickCount; i++) if (now - _tickAtSec[i] <= 1.0) n++;
            return n;
        }

        /// <summary>Overall tick/frame/GC snapshot — the read-only overview.</summary>
        public static object TickStats()
        {
            RingStats(_tickMs, _tickCount, out double tAvg, out double tMax, out double tP95);
            RingStats(_frameMs, _frameCount, out double fAvg, out double fMax, out double fP95);

            var tm = Find.TickManager;
            bool paused = tm == null || tm.Paused;
            float mult = tm != null ? tm.TickRateMultiplier : 0f;
            double targetTps = paused ? 0 : 60.0 * mult; // base game ticks 60/s at 1x
            double actualTps = RecentTps();

            return new
            {
                tick = new
                {
                    avgMs = Math.Round(tAvg, 3),
                    p95Ms = Math.Round(tP95, 3),
                    maxMs = Math.Round(tMax, 3),
                    sampled = _tickCount
                },
                tps = new
                {
                    actual = Math.Round(actualTps, 1),
                    target = Math.Round(targetTps, 1),
                    keepingUp = paused || targetTps <= 0 || actualTps >= targetTps * 0.9,
                    paused,
                    speed = tm != null ? tm.CurTimeSpeed.ToString() : "None"
                },
                frame = new
                {
                    avgMs = Math.Round(fAvg, 2),
                    p95Ms = Math.Round(fP95, 2),
                    maxMs = Math.Round(fMax, 2),
                    fps = fAvg > 0 ? Math.Round(1000.0 / fAvg, 1) : 0,
                    sampled = _frameCount
                },
                gc = new
                {
                    managedHeapMb = Math.Round(GC.GetTotalMemory(false) / 1048576.0, 1),
                    gen0 = GC.CollectionCount(0),
                    gen1 = GC.CollectionCount(1),
                    gen2 = GC.CollectionCount(2)
                }
            };
        }

        // --- Method profiling ---
        private sealed class MethodStat
        {
            public long calls;
            public long totalStopwatchTicks;
            public long maxStopwatchTicks;
        }

        private static readonly object _accLock = new object();
        private static readonly Dictionary<string, MethodStat> _stats = new Dictionary<string, MethodStat>();
        private static readonly HashSet<MethodBase> _patched = new HashSet<MethodBase>();
        private static long _methodWatchStartTicks = 0; // _ticksObserved when profiling counters were last (re)started
        private static readonly Harmony _harmony = new Harmony("archdukejim.rimagentic.perf");

        private static readonly HarmonyMethod _prefix = new HarmonyMethod(typeof(PerfMethodInstrument), nameof(PerfMethodInstrument.Prefix));
        private static readonly HarmonyMethod _postfix = new HarmonyMethod(typeof(PerfMethodInstrument), nameof(PerfMethodInstrument.Postfix));

        private static bool _tickPatchInstalled;

        /// <summary>
        /// Install the always-on per-tick timer imperatively. Called once at mod init, AFTER Harmony is
        /// loaded — deliberately not a [HarmonyPatch] attribute, which would force Harmony resolution at
        /// assembly-load time and abort the mod (see Patch_TickManager_DoSingleTick). Safe to call twice.
        /// </summary>
        public static void InstallTickPatch()
        {
            if (_tickPatchInstalled) return;
            var target = AccessTools.Method(typeof(TickManager), "DoSingleTick");
            if (target == null) { ToolkitLog.Warning("Perf: TickManager.DoSingleTick not found; per-tick timing disabled."); return; }
            _harmony.Patch(target,
                prefix: new HarmonyMethod(typeof(Patch_TickManager_DoSingleTick), nameof(Patch_TickManager_DoSingleTick.Prefix)),
                postfix: new HarmonyMethod(typeof(Patch_TickManager_DoSingleTick), nameof(Patch_TickManager_DoSingleTick.Postfix)));
            _tickPatchInstalled = true;
        }

        public static string KeyOf(MethodBase m)
        {
            return (m.DeclaringType != null ? m.DeclaringType.FullName : "?") + ":" + m.Name;
        }

        /// <summary>Called from the shared postfix for every profiled method.</summary>
        public static void Accumulate(string key, long stopwatchTicks)
        {
            lock (_accLock)
            {
                if (!_stats.TryGetValue(key, out var s)) { s = new MethodStat(); _stats[key] = s; }
                s.calls++;
                s.totalStopwatchTicks += stopwatchTicks;
                if (stopwatchTicks > s.maxStopwatchTicks) s.maxStopwatchTicks = stopwatchTicks;
            }
        }

        /// <summary>A method can be profiled only if it has an IL body we can wrap.</summary>
        private static bool Patchable(MethodInfo m, out string why)
        {
            why = null;
            if (m == null) { why = "null"; return false; }
            if (m.IsAbstract) { why = "abstract"; return false; }
            if (m.ContainsGenericParameters) { why = "open generic"; return false; }
            if (m.IsGenericMethodDefinition) { why = "generic definition"; return false; }
            try { if (m.GetMethodBody() == null) { why = "no IL body (extern/intrinsic)"; return false; } }
            catch { why = "no accessible body"; return false; }
            return true;
        }

        /// <summary>
        /// Start profiling the given methods. Each spec is "Namespace.Type:Method" (all overloads of
        /// that name) or "Namespace.Type" (all declared methods of the type). Returns per-spec results.
        /// </summary>
        public static object Watch(IEnumerable<string> specs, string typeAll, int cap)
        {
            var targets = new List<MethodInfo>();
            var notes = new List<object>();

            void AddType(Type t, string label)
            {
                if (t == null) { notes.Add(new { spec = label, error = "type not found" }); return; }
                foreach (var m in AccessTools.GetDeclaredMethods(t))
                    if (m is MethodInfo mi && Patchable(mi, out _)) targets.Add(mi);
            }

            if (!string.IsNullOrEmpty(typeAll)) AddType(AccessTools.TypeByName(typeAll), typeAll);

            foreach (var raw in specs ?? Enumerable.Empty<string>())
            {
                var spec = (raw ?? "").Trim();
                if (spec.Length == 0) continue;
                int colon = spec.LastIndexOf(':');
                if (colon <= 0)
                {
                    AddType(AccessTools.TypeByName(spec), spec);
                    continue;
                }
                string typeName = spec.Substring(0, colon);
                string methodName = spec.Substring(colon + 1);
                var t = AccessTools.TypeByName(typeName);
                if (t == null) { notes.Add(new { spec, error = "type not found" }); continue; }
                var overloads = AccessTools.GetDeclaredMethods(t).Where(m => m.Name == methodName).ToList();
                if (overloads.Count == 0) { notes.Add(new { spec, error = "method not found" }); continue; }
                targets.AddRange(overloads);
            }

            int patched = 0, skipped = 0;
            bool anyNew = false;
            foreach (var m in targets.Distinct())
            {
                if (patched >= cap) { notes.Add(new { note = $"cap of {cap} methods reached; refine the target" }); break; }
                if (_patched.Contains(m)) { skipped++; continue; }
                if (!Patchable(m, out string why)) { notes.Add(new { method = KeyOf(m), skipped = why }); skipped++; continue; }
                try
                {
                    _harmony.Patch(m, prefix: _prefix, postfix: _postfix);
                    _patched.Add(m);
                    patched++;
                    anyNew = true;
                }
                catch (Exception ex)
                {
                    notes.Add(new { method = KeyOf(m), error = ex.Message });
                    skipped++;
                }
            }

            // If this is the first profiling since a clear/reset, anchor the ms/tick attribution window here.
            if (anyNew && _patched.Count == patched) _methodWatchStartTicks = _ticksObserved;

            return new
            {
                ok = true,
                patched,
                skipped,
                totalWatched = _patched.Count,
                notes
            };
        }

        /// <summary>Read the accumulated per-method stats, hottest first. Optionally zero the counters.</summary>
        public static object Report(int top, bool reset)
        {
            long observed = Math.Max(1, _ticksObserved - _methodWatchStartTicks);
            List<object> rows;
            lock (_accLock)
            {
                rows = _stats
                    .Select(kv => new
                    {
                        method = kv.Key,
                        s = kv.Value,
                        totalMs = kv.Value.totalStopwatchTicks * MsPerStopwatchTick
                    })
                    .OrderByDescending(x => x.totalMs)
                    .Take(Math.Max(1, top))
                    .Select(x => (object)new
                    {
                        method = x.method,
                        calls = x.s.calls,
                        totalMs = Math.Round(x.totalMs, 3),
                        avgUs = x.s.calls > 0 ? Math.Round(x.totalMs * 1000.0 / x.s.calls, 2) : 0,
                        maxUs = Math.Round(x.s.maxStopwatchTicks * MsPerStopwatchTick * 1000.0, 2),
                        msPerTick = Math.Round(x.totalMs / observed, 4)
                    })
                    .ToList();

                if (reset) { _stats.Clear(); _methodWatchStartTicks = _ticksObserved; }
            }

            return new
            {
                methodsWatched = _patched.Count,
                ticksObservedInWindow = observed,
                results = rows
            };
        }

        /// <summary>Unpatch every profiled method and clear all method stats. The always-on sampler keeps running.</summary>
        public static object Clear()
        {
            int removed = 0;
            foreach (var m in _patched.ToList())
            {
                try { _harmony.Unpatch(m, HarmonyPatchType.All, _harmony.Id); removed++; } catch { }
            }
            _patched.Clear();
            lock (_accLock) { _stats.Clear(); }
            _methodWatchStartTicks = _ticksObserved;
            return new { ok = true, unpatched = removed };
        }
    }

    /// <summary>Shared timing wrapper applied to every profiled method. Per-call start via __state.</summary>
    public static class PerfMethodInstrument
    {
        public static void Prefix(out long __state) { __state = Stopwatch.GetTimestamp(); }

        public static void Postfix(MethodBase __originalMethod, long __state)
        {
            PerfProfiler.Accumulate(PerfProfiler.KeyOf(__originalMethod), Stopwatch.GetTimestamp() - __state);
        }
    }

    /// <summary>
    /// Always-on: time each whole game tick so ms/tick and TPS are available without setup.
    /// NOTE: patched imperatively (see PerfProfiler.InstallTickPatch), NOT via a [HarmonyPatch]
    /// type attribute. A type-level Harmony attribute forces the CLR to resolve HarmonyLib at
    /// assembly-load time — before Harmony is guaranteed loaded — which throws during RimWorld's
    /// type scan and aborts the whole mod (RimWorld then resets ModsConfig to vanilla). Keeping the
    /// Harmony dependency purely runtime-side, exactly like the on-demand method profiler, avoids that.
    /// </summary>
    public static class Patch_TickManager_DoSingleTick
    {
        public static void Prefix(out long __state) { __state = Stopwatch.GetTimestamp(); }
        public static void Postfix(long __state) { PerfProfiler.RecordTick(Stopwatch.GetTimestamp() - __state); }
    }

    /// <summary>
    /// Runs a controlled benchmark window on the current map: warm up K ticks (let JIT/caches settle),
    /// then measure M ticks at a fixed speed, producing a standardized tick-cost result. Driven by the
    /// DoSingleTick patch via PerfProfiler.RecordTick -> OnTick, so it advances only while the game is
    /// ticking. Async: perf_benchmark_start kicks it off; perf_benchmark_status polls until phase "done".
    /// </summary>
    public static class PerfBenchmark
    {
        public enum Phase { Idle, Warmup, Measure, Done, Error }

        private static readonly double SecPerStamp = 1.0 / Stopwatch.Frequency;
        private static double NowSec() { return Stopwatch.GetTimestamp() * SecPerStamp; }

        private static Phase _phase = Phase.Idle;
        private static string _error;
        private static int _warmupTarget, _measureTarget, _warmupDone, _measureDone;
        private static readonly List<double> _samples = new List<double>();
        private static double _measureStartSec;
        private static int _gc0, _gc1, _gc2;
        private static TimeSpeed _priorSpeed;
        private static object _result;

        public static object Start(int warmup, int measure, string speed)
        {
            var map = Find.CurrentMap;
            var tm = Find.TickManager;
            if (map == null) { _phase = Phase.Error; _error = "No active map — load or generate one first."; _result = null; return Status(); }
            if (tm == null) { _phase = Phase.Error; _error = "No TickManager available."; _result = null; return Status(); }

            _warmupTarget = Math.Max(0, warmup);
            _measureTarget = Math.Max(1, measure);
            _warmupDone = 0; _measureDone = 0;
            _samples.Clear();
            _error = null; _result = null;
            _priorSpeed = tm.CurTimeSpeed;
            _phase = Phase.Warmup;          // set before unpausing so the first tick already counts
            tm.CurTimeSpeed = ParseSpeed(speed); // a non-Paused speed also unpauses the game
            return Status();
        }

        private static TimeSpeed ParseSpeed(string s)
        {
            switch ((s ?? "").Trim().ToLowerInvariant())
            {
                case "normal": return TimeSpeed.Normal;
                case "fast": return TimeSpeed.Fast;
                case "ultra":
                case "ultrafast": return TimeSpeed.Ultrafast;
                default: return TimeSpeed.Superfast;
            }
        }

        /// <summary>Called once per game tick from the DoSingleTick patch; drives the warmup/measure phases.</summary>
        public static void OnTick(double ms)
        {
            if (_phase == Phase.Warmup)
            {
                if (++_warmupDone >= _warmupTarget)
                {
                    _phase = Phase.Measure;
                    _samples.Clear();
                    _measureStartSec = NowSec();
                    _gc0 = GC.CollectionCount(0); _gc1 = GC.CollectionCount(1); _gc2 = GC.CollectionCount(2);
                }
            }
            else if (_phase == Phase.Measure)
            {
                _samples.Add(ms);
                if (++_measureDone >= _measureTarget) Finish();
            }
        }

        private static void Finish()
        {
            double wall = Math.Max(1e-6, NowSec() - _measureStartSec);
            var arr = _samples.ToArray();
            Array.Sort(arr);
            int n = arr.Length;
            double sum = 0; foreach (var v in arr) sum += v;
            double avg = n > 0 ? sum / n : 0;
            double p95 = n > 0 ? arr[Math.Min(n - 1, (int)Math.Ceiling(n * 0.95) - 1)] : 0;
            double p99 = n > 0 ? arr[Math.Min(n - 1, (int)Math.Ceiling(n * 0.99) - 1)] : 0;

            object mapInfo = null;
            try
            {
                var map = Find.CurrentMap;
                if (map != null)
                    mapInfo = new
                    {
                        biome = map.Biome != null ? map.Biome.defName : null,
                        mapCells = map.Size.x * map.Size.z,
                        colonists = map.mapPawns != null ? map.mapPawns.FreeColonistsCount : 0,
                        pawns = map.mapPawns != null ? map.mapPawns.AllPawnsSpawned.Count : 0,
                        things = map.listerThings != null ? map.listerThings.AllThings.Count : 0
                    };
            }
            catch { }

            _result = new
            {
                ok = true,
                measuredTicks = n,
                wallSeconds = Math.Round(wall, 2),
                tps = Math.Round(n / wall, 1),
                tickMs = new
                {
                    avg = Math.Round(avg, 3),
                    p95 = Math.Round(p95, 3),
                    p99 = Math.Round(p99, 3),
                    max = Math.Round(n > 0 ? arr[n - 1] : 0, 3),
                    min = Math.Round(n > 0 ? arr[0] : 0, 3)
                },
                gc = new
                {
                    gen0 = GC.CollectionCount(0) - _gc0,
                    gen1 = GC.CollectionCount(1) - _gc1,
                    gen2 = GC.CollectionCount(2) - _gc2,
                    heapMb = Math.Round(GC.GetTotalMemory(false) / 1048576.0, 1)
                },
                map = mapInfo
            };

            _phase = Phase.Done;
            var tmr = Find.TickManager;
            if (tmr != null) { try { tmr.CurTimeSpeed = _priorSpeed; } catch { } } // restore the pre-benchmark speed
        }

        public static object Status()
        {
            return new
            {
                phase = _phase.ToString().ToLowerInvariant(),
                error = _error,
                progress = new { warmup = _warmupDone + "/" + _warmupTarget, measure = _measureDone + "/" + _measureTarget },
                result = _phase == Phase.Done ? _result : null
            };
        }
    }

    public static partial class SynapseToolRegistry
    {
        private static void RegisterPerfTools()
        {
            RegisterTool(
                "perf_benchmark_start",
                "Begin a controlled tick-rate benchmark on the CURRENT map: unpause, run at the given speed, warm " +
                "up warmupTicks (let JIT/caches settle), then measure measureTicks and record a standardized result " +
                "(avg/p95/p99/max ms per tick, TPS, GC deltas, and a map summary). Async — returns immediately in " +
                "phase 'warmup'; poll perf_benchmark_status until phase 'done'. Requires a live map. This is the " +
                "measurement step of a performance playtest: compare the result to a stored baseline for impact.",
                new Dictionary<string, object>
                {
                    ["type"] = "object",
                    ["properties"] = new Dictionary<string, object>
                    {
                        ["warmupTicks"] = new Dictionary<string, object> { ["type"] = "number", ["description"] = "Ticks to run before measuring (default 300)." },
                        ["measureTicks"] = new Dictionary<string, object> { ["type"] = "number", ["description"] = "Ticks to measure (default 2000)." },
                        ["speed"] = new Dictionary<string, object> { ["type"] = "string", ["description"] = "normal | fast | superfast (default) | ultra." }
                    }
                },
                args =>
                {
                    try
                    {
                        var a = JsonConvert.DeserializeObject<Dictionary<string, object>>(string.IsNullOrEmpty(args) ? "{}" : args) ?? new Dictionary<string, object>();
                        int warm = 300, meas = 2000;
                        if (a.TryGetValue("warmupTicks", out var wv) && int.TryParse(wv?.ToString(), out int w)) warm = w;
                        if (a.TryGetValue("measureTicks", out var mv) && int.TryParse(mv?.ToString(), out int m)) meas = m;
                        string speed = a.TryGetValue("speed", out var sv) ? sv?.ToString() : null;
                        return JsonConvert.SerializeObject(PerfBenchmark.Start(warm, meas, speed));
                    }
                    catch (Exception ex) { return JsonConvert.SerializeObject(new { error = ex.Message }); }
                }
            );

            RegisterTool(
                "perf_benchmark_status",
                "Poll the benchmark started by perf_benchmark_start. Returns phase (idle|warmup|measure|done|error), " +
                "progress counts, and — once phase is 'done' — the full standardized result. The benchmark advances " +
                "only while the game is ticking, so if it stays in warmup/measure, make sure the game isn't paused.",
                new Dictionary<string, object> { ["type"] = "object", ["properties"] = new Dictionary<string, object>() },
                args =>
                {
                    try { return JsonConvert.SerializeObject(PerfBenchmark.Status()); }
                    catch (Exception ex) { return JsonConvert.SerializeObject(new { error = ex.Message }); }
                }
            );

            RegisterTool(
                "perf_tick_stats",
                "Read the current performance snapshot: game-tick time (avg/p95/max ms), TPS actual-vs-" +
                "target with a keepingUp flag (is the sim keeping up with the chosen speed?), frame time " +
                "and FPS, and GC pressure (managed heap MB + gen0/1/2 collection counts). Always available, " +
                "read-only, no setup. Use it to spot lag and see whether the game or the renderer is the bottleneck.",
                new Dictionary<string, object> { ["type"] = "object", ["properties"] = new Dictionary<string, object>() },
                args =>
                {
                    try { return JsonConvert.SerializeObject(PerfProfiler.TickStats()); }
                    catch (Exception ex) { return JsonConvert.SerializeObject(new { error = ex.Message }); }
                }
            );

            RegisterTool(
                "perf_watch",
                "Start profiling specific methods so perf_report can show which code is hot. Each entry in " +
                "'methods' is either 'Namespace.Type:MethodName' (profiles every overload of that name) or " +
                "'Namespace.Type' (profiles all declared methods of the type); 'type' does the same for one " +
                "type. Point it at your mod's ThingComp/HediffComp/GameComponent tick methods or any suspect " +
                "method, let the game run, then call perf_report. Profiling adds a small per-call overhead, so " +
                "watch a focused set and perf_clear when done.",
                new Dictionary<string, object>
                {
                    ["type"] = "object",
                    ["properties"] = new Dictionary<string, object>
                    {
                        ["methods"] = new Dictionary<string, object>
                        {
                            ["type"] = "array",
                            ["items"] = new Dictionary<string, object> { ["type"] = "string" },
                            ["description"] = "Method or type specs: 'Verse.Pawn:Tick' or 'MyMod.MyComp'."
                        },
                        ["type"] = new Dictionary<string, object>
                        {
                            ["type"] = "string",
                            ["description"] = "Optional: a single type name whose declared methods should all be profiled."
                        },
                        ["cap"] = new Dictionary<string, object>
                        {
                            ["type"] = "number",
                            ["description"] = "Max methods to patch this call (default 200), a guard against profiling an entire assembly by accident."
                        }
                    }
                },
                args =>
                {
                    try
                    {
                        var a = JsonConvert.DeserializeObject<Dictionary<string, object>>(string.IsNullOrEmpty(args) ? "{}" : args)
                                ?? new Dictionary<string, object>();
                        var specs = new List<string>();
                        if (a.TryGetValue("methods", out var mv) && mv is Newtonsoft.Json.Linq.JArray arr)
                            foreach (var e in arr) specs.Add(e?.ToString());
                        string typeAll = a.TryGetValue("type", out var tv) ? tv?.ToString() : null;
                        int cap = 200;
                        if (a.TryGetValue("cap", out var cv) && int.TryParse(cv?.ToString(), out int c) && c > 0) cap = Math.Min(c, 2000);
                        if (specs.Count == 0 && string.IsNullOrEmpty(typeAll))
                            return JsonConvert.SerializeObject(new { error = "Provide 'methods' (array) and/or 'type'." });
                        return JsonConvert.SerializeObject(PerfProfiler.Watch(specs, typeAll, cap));
                    }
                    catch (Exception ex) { return JsonConvert.SerializeObject(new { error = ex.Message }); }
                }
            );

            RegisterTool(
                "perf_report",
                "Report the profiled methods gathered since perf_watch, hottest first: calls, totalMs, avgUs " +
                "(average microseconds per call), maxUs (worst call), and msPerTick (milliseconds this method " +
                "cost per game tick over the observed window — the key 'how much of the frame does this eat' " +
                "number). Pass reset:true to zero the counters and restart the window while keeping the methods " +
                "patched.",
                new Dictionary<string, object>
                {
                    ["type"] = "object",
                    ["properties"] = new Dictionary<string, object>
                    {
                        ["top"] = new Dictionary<string, object> { ["type"] = "number", ["description"] = "Max rows to return (default 25)." },
                        ["reset"] = new Dictionary<string, object> { ["type"] = "boolean", ["description"] = "Zero the counters after reporting (methods stay patched)." }
                    }
                },
                args =>
                {
                    try
                    {
                        var a = JsonConvert.DeserializeObject<Dictionary<string, object>>(string.IsNullOrEmpty(args) ? "{}" : args)
                                ?? new Dictionary<string, object>();
                        int top = 25;
                        if (a.TryGetValue("top", out var tv) && int.TryParse(tv?.ToString(), out int t) && t > 0) top = t;
                        bool reset = a.TryGetValue("reset", out var rv) && (rv is bool rb ? rb : rv?.ToString() == "true");
                        return JsonConvert.SerializeObject(PerfProfiler.Report(top, reset));
                    }
                    catch (Exception ex) { return JsonConvert.SerializeObject(new { error = ex.Message }); }
                }
            );

            RegisterTool(
                "perf_clear",
                "Stop all method profiling: unpatch every method perf_watch instrumented and clear the counters. " +
                "The always-on tick/frame sampler (perf_tick_stats) keeps running. Call this when done profiling " +
                "to remove the per-call overhead.",
                new Dictionary<string, object> { ["type"] = "object", ["properties"] = new Dictionary<string, object>() },
                args =>
                {
                    try { return JsonConvert.SerializeObject(PerfProfiler.Clear()); }
                    catch (Exception ex) { return JsonConvert.SerializeObject(new { error = ex.Message }); }
                }
            );
        }
    }
}
