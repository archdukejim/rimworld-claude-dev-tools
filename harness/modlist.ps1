<#
.SYNOPSIS  Save or restore RimWorld's active mod list (ModsConfig.xml).
.DESCRIPTION
    The test loop can leave ModsConfig.xml in a bad state (e.g. after adding the dev-only
    TestRunner, or if the game rewrites it on a failed load). This snapshots a known-good
    list and restores it on demand.

    Snapshots live in _harness/modlists/<Name>.xml. "RimSynapse-Test" is the baseline:
    Harmony, RimWorld + all 5 DLCs, MapModeFramework, and the RimSynapse mods with Core
    before its companions and Factions last.
.EXAMPLE   .\modlist.ps1 -Save -Name RimSynapse-Test
.EXAMPLE   .\modlist.ps1 -Restore -Name RimSynapse-Test
.EXAMPLE   .\modlist.ps1 -Show
.OUTPUTS   JSON: { ok, action, name, path, activeCount }
#>
param(
    [switch]$Save,
    [switch]$Restore,
    [switch]$Show,
    [string]$Name = 'RimSynapse-Test'
)
. "$PSScriptRoot\lib.ps1"

$listDir = Join-Path $PSScriptRoot 'modlists'
$snapshot = Join-Path $listDir "$Name.xml"
$live = Join-Path $RS_ConfigDir 'ModsConfig.xml'

function Count-Active($path) {
    if (-not (Test-Path $path)) { return 0 }
    try { ([xml](Get-Content $path -Raw)).ModsConfigData.activeMods.li.Count } catch { 0 }
}

if ($Show) {
    if (-not (Test-Path $live)) { RS-Json @{ ok=$false; error="ModsConfig.xml not found at $live" }; exit 2 }
    $mods = ([xml](Get-Content $live -Raw)).ModsConfigData.activeMods.li
    RS-Json @{ ok=$true; action='show'; path=$live; activeCount=$mods.Count; activeMods=@($mods) }
    exit 0
}

if ($Save) {
    if (-not (Test-Path $live)) { RS-Json @{ ok=$false; error="ModsConfig.xml not found at $live" }; exit 2 }
    New-Item -ItemType Directory -Path $listDir -Force | Out-Null
    Copy-Item $live $snapshot -Force
    RS-Json @{ ok=$true; action='save'; name=$Name; path=$snapshot; activeCount=(Count-Active $snapshot) }
    exit 0
}

if ($Restore) {
    if (-not (Test-Path $snapshot)) { RS-Json @{ ok=$false; error="No snapshot named '$Name' at $snapshot" }; exit 2 }
    # Keep one rollback of whatever was live before we overwrite it.
    if (Test-Path $live) { Copy-Item $live (Join-Path $listDir '_previous.xml') -Force }
    Copy-Item $snapshot $live -Force
    RS-Json @{ ok=$true; action='restore'; name=$Name; path=$live; activeCount=(Count-Active $live) }
    exit 0
}

RS-Json @{ ok=$false; error='Specify -Save, -Restore or -Show.' }
exit 2
