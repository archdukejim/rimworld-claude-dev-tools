<#
.SYNOPSIS  Build RimSynapse mods in dependency order (Core first, Factions last).
.EXAMPLE   .\build.ps1                 # build all compiled mods
.EXAMPLE   .\build.ps1 -Repo Factions  # build one (and Core first if needed)
.OUTPUTS   JSON summary: { ok, built[], failed[], warnings[] }  (exit 1 on any failure)
#>
param(
    [string]$Repo,                    # single repo name; omit for all
    [ValidateSet('Debug','Release')] [string]$Configuration = 'Release'
)
. "$PSScriptRoot\lib.ps1"

# Decide which repos to build. A single-repo request still builds Core first.
$targets = [ordered]@{}
if ($Repo) {
    if (-not $RS_BuildOrder.Contains($Repo)) {
        if ($RS_DataOnly -contains $Repo) { RS-Log "$Repo is data-only (nothing to build)."; RS-Json @{ ok=$true; built=@(); failed=@(); warnings=@() }; exit 0 }
        Write-Error "Unknown repo '$Repo'. Known: $($RS_BuildOrder.Keys -join ', ')"; exit 2
    }
    if ($Repo -ne 'Core') { $targets['Core'] = $RS_BuildOrder['Core'] }
    if ($Repo -eq 'Factions') { $targets['Regions-and-Territories'] = $RS_BuildOrder['Regions-and-Territories'] }
    $targets[$Repo] = $RS_BuildOrder[$Repo]
} else {
    $targets = $RS_BuildOrder
}

$built = @(); $failed = @(); $warnings = @()
foreach ($name in $targets.Keys) {
    $proj = Join-Path $RS_Root (Join-Path $name $targets[$name])
    if (-not (Test-Path $proj)) { RS-Log "SKIP $name (no csproj at $proj)"; continue }
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

$ok = ($failed.Count -eq 0)
RS-Json @{ ok=$ok; built=$built; failed=$failed; warnings=$warnings }
if (-not $ok) { exit 1 }
