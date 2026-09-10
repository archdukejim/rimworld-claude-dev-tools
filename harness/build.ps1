<#
.SYNOPSIS  Build the workspace's mods in dependency order (derived from csproj references).
.EXAMPLE   .\build.ps1                 # build all compiled mods
.EXAMPLE   .\build.ps1 -Repo Factions  # build one (and its dependencies first)
.OUTPUTS   JSON summary: { ok, built[], failed[], warnings[] }  (exit 1 on any failure)
#>
param(
    [string]$Repo,                    # single repo name; omit for all
    [ValidateSet('Debug','Release')] [string]$Configuration = 'Release'
)
. "$PSScriptRoot\lib.ps1"

# Decide which mods to build. A single-repo request also builds its dependencies first,
# in the dependency order derived from the csproj HintPath graph (RS_BuildInfo).
if ($Repo) {
    if ($RS_DataOnly -contains $Repo) { RS-Log "$Repo is data-only (nothing to build)."; RS-Json @{ ok=$true; built=@(); failed=@(); warnings=@() }; exit 0 }
    if (-not ($RS_BuildInfo.Order -contains $Repo)) {
        Write-Error "Unknown repo '$Repo'. Known: $($RS_BuildInfo.Order -join ', ')"; exit 2
    }
}
$targetNames = Get-BuildTargets -Info $RS_BuildInfo -Repo $Repo

$built = @(); $failed = @(); $warnings = @()
foreach ($name in $targetNames) {
    $proj = $RS_BuildInfo.Csproj[$name]
    if (-not $proj -or -not (Test-Path $proj)) { RS-Log "SKIP $name (no csproj at $proj)"; continue }
    RS-Log "Building $name ..."
    $out = & dotnet build $proj -c $Configuration --nologo 2>&1
    $code = $LASTEXITCODE
    $warnLines = $out | Select-String -Pattern ': warning ' | ForEach-Object { $_.Line.Trim() }
    if ($warnLines) { $warnings += ($warnLines | ForEach-Object { "[$name] $_" }) }
    if ($code -ne 0) {
        $errLines = $out | Select-String -Pattern ': error ' | ForEach-Object { $_.Line.Trim() }
        $failed += @{ repo=$name; exitCode=$code; errors=@($errLines) }
        RS-Log "FAILED $name (exit $code)"
        break   # fail-fast: downstream builds depend on this DLL
    }
    $built += $name
}

# Second pass: per-repo in-game test projects (<repo>\Source.Tests\*.csproj -> TestAssemblies\),
# discovered and run by the RimAgentic toolkit under -synapse-test. They HintPath other mods'
# DLLs, so they build only after the whole main graph above succeeded. A test project that does
# not build is a real failure: the suite it carries would silently vanish from the next run
# (the toolkit's bootstrap guard would catch the missing DLL, but only by failing the run later).
if ($failed.Count -eq 0) {
    foreach ($name in $targetNames) {
        $proj = $RS_BuildInfo.Csproj[$name]
        if (-not $proj) { continue }
        $testsDir = Join-Path (Split-Path (Split-Path $proj -Parent) -Parent) 'Source.Tests'
        $testProj = if (Test-Path $testsDir) { Get-ChildItem $testsDir -Filter '*.csproj' -File | Select-Object -First 1 } else { $null }
        if (-not $testProj) { continue }
        RS-Log "Building $name tests ..."
        $out = & dotnet build $testProj.FullName -c $Configuration --nologo 2>&1
        $code = $LASTEXITCODE
        $warnLines = $out | Select-String -Pattern ': warning ' | ForEach-Object { $_.Line.Trim() }
        if ($warnLines) { $warnings += ($warnLines | ForEach-Object { "[$name tests] $_" }) }
        if ($code -ne 0) {
            $errLines = $out | Select-String -Pattern ': error ' | ForEach-Object { $_.Line.Trim() }
            $failed += @{ repo="$name tests"; exitCode=$code; errors=@($errLines) }
            RS-Log "FAILED $name tests (exit $code)"
        } else {
            $built += "$name tests"
        }
    }
}

$ok = ($failed.Count -eq 0)
RS-Json @{ ok=$ok; built=$built; failed=$failed; warnings=$warnings }
if (-not $ok) { exit 1 }
