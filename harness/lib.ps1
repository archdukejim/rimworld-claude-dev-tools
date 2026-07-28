# lib.ps1 — shared config + helpers for the RimSynapse test harness.
# Dot-source this from the other scripts:  . "$PSScriptRoot\lib.ps1"

$ErrorActionPreference = 'Stop'

# --- Paths -------------------------------------------------------------------
# The harness lives in the Repo-MCP checkout but operates on the RimSynapse mod
# workspace (the folder containing Core/, Factions/, ...). Resolve it explicitly
# rather than inferring it from this script's location.
# A mod is any folder carrying About\About.xml. Probing for Core specifically is what made
# a single-repo checkout unrecognisable: no CI job for Factions has a Core beside it.
function Test-IsModFolder {
    param([string]$Dir)
    return ($Dir -and (Test-Path (Join-Path $Dir 'About\About.xml')))
}

function Resolve-WorkspaceRoot {
    param([string]$Root)

    # An explicit root wins and NEVER silently falls back. Previously RIMSYNAPSE_ROOT was
    # honoured only when it contained Core\About\About.xml, so pointing it at a single-repo
    # checkout failed that test, fell through to the upward walk, found the dev machine's
    # full workspace, and inspected ten unrelated mods while reporting success. A root that
    # cannot be used is a configuration error, not an invitation to scan something else.
    $explicit = if ($Root) { $Root } else { $env:RIMSYNAPSE_ROOT }
    if ($explicit) {
        if (-not (Test-Path $explicit)) {
            throw "Root '$explicit' does not exist (from $(if($Root){'-Root'}else{'RIMSYNAPSE_ROOT'}))."
        }
        $resolved = (Resolve-Path $explicit).Path
        if (-not (Test-IsModFolder $resolved) -and
            -not (Get-ChildItem $resolved -Directory -ErrorAction SilentlyContinue |
                  Where-Object { Test-IsModFolder $_.FullName })) {
            throw "Root '$resolved' contains no mod (no About\About.xml in it or any child folder)."
        }
        return $resolved
    }

    # Walk upward for a workspace, or for a single repo that is itself a mod.
    $dir = $PSScriptRoot
    for ($i = 0; $i -lt 4 -and $dir; $i++) {
        if (Test-IsModFolder $dir) { return $dir }
        if (Get-ChildItem $dir -Directory -ErrorAction SilentlyContinue |
            Where-Object { Test-IsModFolder $_.FullName }) { return $dir }
        $dir = Split-Path -Parent $dir
    }
    if (Test-Path 'C:\github\rimsynapse\Core\About\About.xml') { return 'C:\github\rimsynapse' }
    throw "Could not locate a RimSynapse mod or workspace. Set RIMSYNAPSE_ROOT or pass -Root."
}

<#
.SYNOPSIS  The mods a gate should inspect, for both layouts, or an error naming what was missed.
.DESCRIPTION
    Two layouts have to work:
      * the dev workspace — a folder whose children are mod folders;
      * a single-repo checkout — the root IS the mod, which is what CI gets.
    Returning an empty set is never acceptable: a gate that inspects nothing and exits 0 is
    indistinguishable from a gate that passed, which is the whole reason these exist.
#>
function Get-HarnessMods {
    param(
        [Parameter(Mandatory)][string]$Root,
        [string]$Repo
    )

    $mods = @()
    if (Test-IsModFolder $Root) {
        $mods = @([pscustomobject]@{ Name = (Split-Path -Leaf $Root); FullName = $Root })
    } else {
        $mods = @(Get-ChildItem $Root -Directory -ErrorAction SilentlyContinue |
                  Where-Object { Test-IsModFolder $_.FullName } |
                  ForEach-Object { [pscustomobject]@{ Name = $_.Name; FullName = $_.FullName } })
    }

    if ($Repo) { $mods = @($mods | Where-Object { $_.Name -eq $Repo }) }

    if ($mods.Count -eq 0) {
        $what = if ($Repo) { "mod '$Repo'" } else { "any mod (a folder with About\About.xml)" }
        throw "Found no $what under '$Root'. Nothing was inspected, so this is a failure rather than a pass."
    }

    return @($mods | Sort-Object Name)
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
