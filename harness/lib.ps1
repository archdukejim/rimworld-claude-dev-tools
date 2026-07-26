# lib.ps1 — shared config + helpers for the RimSynapse test harness.
# Dot-source this from the other scripts:  . "$PSScriptRoot\lib.ps1"

$ErrorActionPreference = 'Stop'

# --- Paths -------------------------------------------------------------------
# The harness lives in the Repo-MCP checkout but operates on the RimSynapse mod
# workspace (the folder containing Core/, Factions/, ...). Resolve it explicitly
# rather than inferring it from this script's location.
function Resolve-WorkspaceRoot {
    if ($env:RIMSYNAPSE_ROOT -and (Test-Path (Join-Path $env:RIMSYNAPSE_ROOT 'Core\About\About.xml'))) {
        return (Resolve-Path $env:RIMSYNAPSE_ROOT).Path
    }
    # Walk upward looking for the workspace (handles Repo-MCP/harness -> workspace root).
    $dir = $PSScriptRoot
    for ($i = 0; $i -lt 4 -and $dir; $i++) {
        if (Test-Path (Join-Path $dir 'Core\About\About.xml')) { return $dir }
        $dir = Split-Path -Parent $dir
    }
    if (Test-Path 'C:\github\rimsynapse\Core\About\About.xml') { return 'C:\github\rimsynapse' }
    throw "Could not locate the RimSynapse workspace (a folder containing Core\About\About.xml). Set RIMSYNAPSE_ROOT."
}

$Global:RS_Root      = Resolve-WorkspaceRoot
$Global:RS_GameDir   = 'C:\Program Files (x86)\Steam\steamapps\common\RimWorld'
$Global:RS_GameExe   = Join-Path $RS_GameDir 'RimWorldWin64.exe'
$Global:RS_ModsDir   = Join-Path $RS_GameDir 'Mods'
$Global:RS_ConfigDir = Join-Path $env:USERPROFILE 'AppData\LocalLow\Ludeon Studios\RimWorld by Ludeon Studios\Config'
$Global:RS_PlayerLog = Join-Path $env:USERPROFILE 'AppData\LocalLow\Ludeon Studios\RimWorld by Ludeon Studios\Player.log'
$Global:RS_Marker    = Join-Path $PSScriptRoot '.logmarker'

# Read RimWorldPath from Core's GamePath.props if present (authoritative).
$propsPath = Join-Path $RS_Root 'Core\Source\GamePath.props'
if (Test-Path $propsPath) {
    try {
        [xml]$props = Get-Content $propsPath
        $p = $props.Project.PropertyGroup.RimWorldPath
        if ($p) { $Global:RS_GameDir = $p; $Global:RS_GameExe = Join-Path $p 'RimWorldWin64.exe'; $Global:RS_ModsDir = Join-Path $p 'Mods' }
    } catch { }
}

# --- Build order (Core first; Factions last; AuraAlgorithm is data-only) ------
# Ordered so each project's Core/dependency DLLs exist before it builds.
$Global:RS_BuildOrder = [ordered]@{
    'Core'                    = 'Source\RimSynapseCore.csproj'
    'Regions-and-Territories' = 'Source\RimSynapseRegionsAndTerritories.csproj'
    'Conversations'           = 'Source\RimSynapseConversations.csproj'
    'Psychology'              = 'Source\RimSynapsePsychology.csproj'
    'WorldNews'               = 'Source\RimSynapseWorldNews.csproj'
    'NVIDIA-Tool'             = 'Source\RimSynapseNvidiaTool.csproj'
    'Factions'                = 'Source\RimSynapseFactions.csproj'
    # Dev-only harness mod; built last so it can reference every other assembly.
    'TestRunner'              = 'Source\RimSynapseTestRunner.csproj'
}
# Data-only mods (no compile) — deployed but never built.
$Global:RS_DataOnly = @('AuraAlgorithm')

function RS-Json($obj) { $obj | ConvertTo-Json -Depth 8 }
function RS-Log($msg)  { Write-Host "[harness] $msg" }
