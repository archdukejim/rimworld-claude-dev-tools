using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Verse;

namespace RimAgentic.Testing
{
    /// <summary>
    /// Dev-only test harness host. Does nothing unless RimWorld is launched with -synapse-test
    /// (batch case run) or -synapse-determination (frame-pumped drivers, e.g. the live-LLM
    /// determination runner).
    ///
    /// <para>Cases live with the mods they test: each mod repo builds a dev-only test assembly
    /// into its <c>TestAssemblies\</c> folder (a sibling of <c>Assemblies\</c>, so RimWorld never
    /// auto-loads it and releases never ship it). When armed, this component loads those DLLs
    /// from every active mod, discovers classes marked <see cref="SynapseTestSetAttribute"/>
    /// exposing <c>static IEnumerable&lt;SynapseTestCase&gt; All()</c>, and runs them ordered by
    /// (phase, assembly, class). Loading happens here — after every mod's ctor,
    /// [StaticConstructorOnStartup] and LongEventHandler callback has run — which is the same
    /// "loads last" guarantee the old dedicated TestRunner mod declared via loadAfter.</para>
    ///
    /// <para>GameComponents are instantiated automatically by Verse.Game.FillComponents(), so this
    /// needs no Def and no registration. Results go to Player.log in the format readlog.ps1
    /// parses; the game then shuts itself down so launch.ps1 sees a clean exit rather than
    /// hitting its timeout.</para>
    /// </summary>
    public class TestRunnerGameComponent : GameComponent
    {
        private const string TestArg = "synapse-test";
        private const string DeterminationArg = "synapse-determination";
        private const string TestAssembliesFolder = "TestAssemblies";

        // Frames to wait after FinalizeInit before running. Gives deferred startup work
        // (LongEventHandler callbacks, comp initialisation) a chance to settle.
        private const int WarmupFrames = 30;

        // If a mod throws every frame in UIRootUpdate, Root.Shutdown() can fail to bring the
        // process down. Force an exit if we're still alive this many frames after asking nicely.
        private const int ForceExitFrames = 180;

        private bool _testArmed;
        private bool _driversArmed;
        private bool _completed;
        private int _framesWaited;
        private int _framesSinceShutdown = -1;
        private List<ISynapseTestDriver> _drivers;

        public TestRunnerGameComponent(Game game) { }

        public override void FinalizeInit()
        {
            base.FinalizeInit();

            _testArmed = GenCommandLine.CommandLineArgPassed(TestArg);
            _driversArmed = GenCommandLine.CommandLineArgPassed(DeterminationArg);

            if (_testArmed)
                SynapseTestReporter.Info($"TestRunner armed (-{TestArg} detected); warming up {WarmupFrames} frames.");
        }

        public override void GameComponentUpdate()
        {
            if (!_testArmed && !_driversArmed) return;

            // Graceful shutdown was requested but the process is still running — force it.
            if (_completed)
            {
                if (_framesSinceShutdown >= 0 && ++_framesSinceShutdown > ForceExitFrames)
                {
                    _framesSinceShutdown = -1;
                    SynapseTestReporter.Info("Shutdown did not complete; forcing process exit.");
                    Environment.Exit(0);
                }
                return;
            }

            if (_framesWaited < WarmupFrames)
            {
                _framesWaited++;
                return;
            }

            // Drivers own their whole lifecycle (arming, timeouts, shutdown); this component
            // only loads their assemblies and pumps them. The batch run below never starts
            // when a driver flag is present without -synapse-test.
            if (_drivers != null)
            {
                foreach (var d in _drivers) d.Update();
                return;
            }

            var discovery = DiscoverTestAssemblies();

            if (_driversArmed && !_testArmed)
            {
                _drivers = InstantiateDrivers(discovery);
                if (_drivers.Count == 0)
                {
                    SynapseTestReporter.Info($"-{DeterminationArg} passed but no armed ISynapseTestDriver found; shutting down.");
                    _completed = true;
                    _framesSinceShutdown = 0;
                    Shutdown();
                }
                return;
            }

            _completed = true;

            try
            {
                var cases = new List<SynapseTestCase> { BootstrapCase(discovery) };
                cases.AddRange(CollectCases(discovery));
                SynapseTestReporter.Info($"Running {cases.Count} case(s).");
                SynapseTestRunner.RunAll(cases);
            }
            catch (Exception ex)
            {
                // Report rather than crash — the harness needs a parseable result either way.
                SynapseTestReporter.Fail("TestRunner_Bootstrap", $"{ex.GetType().Name}: {ex.Message}");
                SynapseTestReporter.Summary(SynapseTestRunner.Passed, SynapseTestRunner.Failed + 1, SynapseTestRunner.Skipped);
            }
            finally
            {
                _framesSinceShutdown = 0;
                Shutdown();
            }
        }

        private class Discovery
        {
            /// <summary>Loaded test assemblies (this mod's own assembly included, for the sentinels).</summary>
            public readonly List<Assembly> Assemblies = new List<Assembly>();
            /// <summary>Mod name → loaded test DLL count, for the bootstrap report.</summary>
            public readonly List<string> Sources = new List<string>();
            /// <summary>DLLs that exist on disk but would not load — always a failure.</summary>
            public readonly List<string> LoadFailures = new List<string>();
        }

        /// <summary>
        /// Load every active mod's TestAssemblies\*.dll. Mod assemblies are loaded by Verse from
        /// bytes, so a LoadFrom'd DLL cannot resolve references to them natively — the
        /// AssemblyResolve hook answers by simple name from what is already in the AppDomain.
        /// </summary>
        private Discovery DiscoverTestAssemblies()
        {
            var d = new Discovery();
            d.Assemblies.Add(typeof(TestRunnerGameComponent).Assembly);

            AppDomain.CurrentDomain.AssemblyResolve += ResolveFromLoaded;

            foreach (var pack in LoadedModManager.RunningModsListForReading)
            {
                if (pack == null || string.IsNullOrEmpty(pack.RootDir)) continue;
                string dir = System.IO.Path.Combine(pack.RootDir, TestAssembliesFolder);
                if (!System.IO.Directory.Exists(dir)) continue;

                int loaded = 0;
                foreach (string dll in System.IO.Directory.GetFiles(dir, "*.dll", System.IO.SearchOption.TopDirectoryOnly))
                {
                    try
                    {
                        d.Assemblies.Add(Assembly.LoadFrom(dll));
                        loaded++;
                    }
                    catch (Exception ex)
                    {
                        d.LoadFailures.Add($"{pack.Name}/{System.IO.Path.GetFileName(dll)}: [{ex.GetType().Name}] {ex.Message}");
                    }
                }

                if (loaded > 0)
                {
                    d.Sources.Add($"{pack.Name}={loaded}");
                    SynapseTestReporter.Info($"Loaded {loaded} test assembly/assemblies from {pack.Name}.");
                }
            }

            return d;
        }

        private static Assembly ResolveFromLoaded(object sender, ResolveEventArgs args)
        {
            string name = new AssemblyName(args.Name).Name;
            return AppDomain.CurrentDomain.GetAssemblies()
                .FirstOrDefault(a => a.GetName().Name == name);
        }

        /// <summary>
        /// The suite must not be able to *silently* shrink: a repo whose test DLL was never built,
        /// or failed to load, runs no failing tests of its own — same trap the sentinel cases
        /// exist for, one level up. Zero discovered DLLs, or any load failure, is a FAIL.
        /// </summary>
        private static SynapseTestCase BootstrapCase(Discovery d)
        {
            return new SynapseTestCase("Toolkit_TestAssembliesDiscovered", () =>
            {
                Assert.True(d.LoadFailures.Count == 0,
                    $"{d.LoadFailures.Count} test assembly/assemblies failed to load: " +
                    string.Join(" | ", d.LoadFailures.Take(3)));

                Assert.True(d.Sources.Count > 0,
                    $"no {TestAssembliesFolder}\\ folder with DLLs found in any active mod — " +
                    "the per-mod suites are missing entirely (not built, or not deployed)");

                return $"test assemblies loaded from {d.Sources.Count} mod(s): {string.Join(", ", d.Sources)}";
            });
        }

        /// <summary>
        /// Case sets are classes marked [SynapseTestSet] exposing static IEnumerable&lt;SynapseTestCase&gt; All().
        /// Ordered by (phase, assembly, class) — the contract the old hand-maintained registration
        /// list expressed by position. A set whose All() throws becomes a single failing case
        /// rather than killing the run.
        /// </summary>
        private static IEnumerable<SynapseTestCase> CollectCases(Discovery d)
        {
            var sets = new List<(TestPhase Phase, string Asm, string Type, Type Class)>();

            foreach (var asm in d.Assemblies)
            {
                Type[] types;
                try { types = asm.GetTypes(); }
                catch (ReflectionTypeLoadException ex) { types = ex.Types.Where(t => t != null).ToArray(); }

                foreach (var t in types)
                {
                    var attr = t.GetCustomAttribute<SynapseTestSetAttribute>();
                    if (attr == null) continue;
                    sets.Add((attr.Phase, asm.GetName().Name, t.Name, t));
                }
            }

            var cases = new List<SynapseTestCase>();
            foreach (var set in sets.OrderBy(s => s.Phase).ThenBy(s => s.Asm, StringComparer.Ordinal).ThenBy(s => s.Type, StringComparer.Ordinal))
            {
                try
                {
                    var all = set.Class.GetMethod("All", BindingFlags.Public | BindingFlags.Static);
                    if (all == null)
                    {
                        cases.Add(Broken(set.Type, "is marked [SynapseTestSet] but has no public static All()"));
                        continue;
                    }
                    var result = all.Invoke(null, null) as IEnumerable<SynapseTestCase>;
                    if (result == null)
                    {
                        cases.Add(Broken(set.Type, "All() did not return IEnumerable<SynapseTestCase>"));
                        continue;
                    }
                    cases.AddRange(result);
                }
                catch (Exception ex)
                {
                    cases.Add(Broken(set.Type, $"All() threw {ex.GetType().Name}: {ex.Message}"));
                }
            }

            return cases;
        }

        private static SynapseTestCase Broken(string typeName, string why)
        {
            return new SynapseTestCase($"Toolkit_BrokenCaseSet_{typeName}",
                () => throw new SynapseTestFailure(why));
        }

        private static List<ISynapseTestDriver> InstantiateDrivers(Discovery d)
        {
            var drivers = new List<ISynapseTestDriver>();
            foreach (var asm in d.Assemblies)
            {
                Type[] types;
                try { types = asm.GetTypes(); }
                catch (ReflectionTypeLoadException ex) { types = ex.Types.Where(t => t != null).ToArray(); }

                foreach (var t in types)
                {
                    if (t.IsAbstract || !typeof(ISynapseTestDriver).IsAssignableFrom(t)) continue;
                    try
                    {
                        var driver = (ISynapseTestDriver)Activator.CreateInstance(t);
                        if (driver.Armed) drivers.Add(driver);
                    }
                    catch (Exception ex)
                    {
                        SynapseTestReporter.Info($"Driver {t.Name} could not be instantiated: {ex.Message}");
                    }
                }
            }
            return drivers;
        }

        /// <summary>
        /// Root.Shutdown() is preferred over Application.Quit(): RimSynapse Core patches it to run
        /// its own teardown, so this exercises the real shutdown path when Core is present.
        /// </summary>
        private static void Shutdown()
        {
            SynapseTestReporter.Info("Tests complete; shutting down.");
            try
            {
                Root.Shutdown();
            }
            catch (Exception ex)
            {
                Log.Warning($"{SynapseTestReporter.Tag} Root.Shutdown() threw ({ex.GetType().Name}: {ex.Message}); falling back to Application.Quit().");
                UnityEngine.Application.Quit();
            }
        }
    }
}
