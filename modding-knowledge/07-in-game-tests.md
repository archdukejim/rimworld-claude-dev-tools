# In-game tests — the RimAgentic test host and per-repo case suites

The toolkit bridge mod hosts an in-game test runner (`RimAgentic.Testing`, in
`game-mod/Source/Testing/`). It is inert without `-synapse-test`. When armed, it waits for the
game and every mod to fully load, then loads each active mod's `TestAssemblies\*.dll`, discovers
case sets, runs them, and shuts the game down so the harness sees a clean exit. Results are
parsed from `Player.log` by `harness/readlog.ps1`; `run_rimworld_tests` drives the whole cycle.

## Where cases live

Each mod repo owns its own suite: a `Source.Tests\<Name>Tests.csproj` building into the repo's
`TestAssemblies\` folder. That location is load-bearing:

- **Never under `Source\`** — the harness treats the first csproj in `Source\` as *the mod build*
  (`lib.ps1` `Get-ModCsProj`).
- **Never output to `Assemblies\`** — everything there is hashed into release manifests and
  shipped. `TestAssemblies\` is outside the release payload allowlist and RimWorld never
  auto-loads it, so test code cannot reach players.
- Local deploys symlink the whole repo into `Mods\`, so the folder is already where the runner
  looks. `build.ps1` builds every `Source.Tests` project after the main dependency graph.

A case-set class is marked `[SynapseTestSet]` and exposes
`static IEnumerable<SynapseTestCase> All()`. Sets run ordered by **(phase, assembly, class)**:

- `TestPhase.Sentinel` — mod-liveness sentinels (the toolkit's own; see below).
- `TestPhase.Contract` — whole-registry contract cases; they execute *every* non-debug tool, so
  they run before any set that registers test tools.
- `TestPhase.Default` — everything else. Sets must not depend on each other's state.
- `TestPhase.MapMutating` — spawns pawns/buildings on the live map; runs last, and nothing may
  assume an untouched colony afterward.

For asynchronous suites (e.g. the live-LLM determination runner in Psychology, armed by
`-synapse-determination`), implement `ISynapseTestDriver`: the host instantiates it and pumps
`Update()` once per frame; the driver owns its arming flag, timeouts, and shutdown.

## Rules for writing cases

- **Names**: `<Repo>_<CaseName>` (e.g. `Core_MutatingToolGate`) so results map back to the issue
  whose test plan they satisfy. Names are stable; if a case moves repos, the name does not change.
- **Pass/fail**: return a detail string to pass; throw `SynapseTestFailure` (via the `Assert`
  helpers) to fail. Unexpected exceptions are reported as failures without killing the suite.
- **Never `Log.Error`** — the harness counts it as a blocking entry. The reporter uses
  `Log.Message` for everything, including FAILs; the token carries the signal.
- **Restore what you touch.** Settings mutations go through a snapshot/restore wrapper
  (`try/finally`); controllers with state expose `ResetForTesting()` — call it in the finally.
- **Test tools** are registered with a `zz_test_` prefix, idempotently (RegisterTool overwrites
  by name). Handlers must honor the registry-wide contract cases: return valid JSON on empty
  args, never throw on malformed args.
- **Log scanning** must go through the framework's `TestLog.RecentLines()` — it skips lines
  carrying `[SYNAPSE-TEST]`, otherwise a case can match its own output.
- **Prefer structural checks to log scanning.** `Log.Messages` is a bounded buffer, so a noisy
  startup can roll a log-scanning case into a false PASS. Ask ModsConfig, ask Harmony, ask the
  assembly — those cannot be lost to buffer pressure.
- **Be environment-defensive**: probe whether shared state is manipulable and self-skip with a
  reason rather than assert into flakiness.
- **A new guard that has never failed is decorative.** Prove it catches what it is for:
  reintroduce the defect, watch it fail, then revert.

## Sentinel cases — do not weaken

A dead or misconfigured mod runs no failing tests, so the rest of the suite stays green while it
is broken. These live in the toolkit itself (`SentinelCases.cs`, phase Sentinel) plus the
bootstrap guard, because nothing inside a dead mod can notice:

- `Toolkit_TestAssembliesDiscovered` — the suite itself cannot silently shrink: zero discovered
  test DLLs, or any DLL that fails to load, is a FAIL. A repo whose tests were never built would
  otherwise just vanish from the run.
- `Core_AllModsInstantiated` — fails when a mod loads and then throws. It scans the log for
  "Error while instantiating a mod" and "Error in static constructor", so it **cannot** see a mod
  whose assembly never yielded its types. Use the two below for that case; do not widen this one.
- `Core_EveryShippedAssemblyIsLive` — every DLL a mod ships has a live assembly. Asks what
  *should* have loaded rather than whether any of what loaded broke.
- `Core_DeclaredLoadOrderRespected` — no active mod is ordered before something it declares
  `loadAfter`. `loadAfter` is advisory: RimWorld loads `ModsConfig.xml` in the order written.

(The `Core_` names are historical — they map to the issues that created them.)

## Wire contract (do not change casually)

`readlog.ps1` and `launch.ps1` parse exactly:

```
[SYNAPSE-TEST] INFO Running N case(s).
[SYNAPSE-TEST] PASS|FAIL|SKIP <name> | <detail>
[SYNAPSE-TEST] SUMMARY passed=N failed=M skipped=K
```

followed by a self-initiated shutdown. `launch.ps1` treats a missing SUMMARY as a failed run, and
`readlog.ps1` flags a shortfall between announced and reported counts as blocking.
