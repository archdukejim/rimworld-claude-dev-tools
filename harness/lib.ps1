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
    $explicit = if ($Root) { $Root } elseif ($env:RIMTOOLKIT_ROOT) { $env:RIMTOOLKIT_ROOT } else { $env:RIMSYNAPSE_ROOT }
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

# --- Build order: derived from each mod's csproj, not hardcoded ---------------
# A mod compiles if it has a Source\*.csproj. Inter-mod build dependencies are read
# from <Reference><HintPath> entries that resolve into another mod's folder (mods bind
# each other's built Assemblies\*.dll by relative path, e.g. Factions references
# ..\..\Regions-and-Territories\Assemblies\...dll). Those edges topo-sort into an order
# where every referenced DLL is built before the mod that needs it. HintPaths using
# MSBuild variables ($(RimWorldPath), $(HarmonyPath)) are the game/Harmony and are ignored.

# Optional exclude list (comma/semicolon separated mod names) so a workspace can keep a
# compiled mod out of the test-cycle build without hardcoding — e.g. RS_BUILD_EXCLUDE=LLM-Trainer.
$Global:RS_BuildExclude = @()
if ($env:RS_BUILD_EXCLUDE) {
    $Global:RS_BuildExclude = @($env:RS_BUILD_EXCLUDE -split '[,;]' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

function Get-ModCsProj($modDir) {
    $src = Join-Path $modDir 'Source'
    if (-not (Test-Path $src)) { return $null }
    $p = Get-ChildItem $src -Filter '*.csproj' -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($p) { return $p.FullName } else { return $null }
}

# The assembly a mod compiles to: <AssemblyName> if set, else the csproj file name.
# Mods bind each other by this DLL name, so it is the key that links a reference to a mod.
function Get-ModAssemblyName($csprojPath) {
    $name = $null
    try {
        [xml]$xml = Get-Content $csprojPath -Raw
        foreach ($pg in @($xml.Project.PropertyGroup)) { if ($pg.AssemblyName) { $name = $pg.AssemblyName; break } }
    } catch { }
    if (-not $name) { $name = [System.IO.Path]::GetFileNameWithoutExtension($csprojPath) }
    return $name.ToLower()
}

# The DLL base names a csproj references via <Reference><HintPath>. Matched against mod
# assembly names to find inter-mod build edges. Robust to both reference styles: relative
# (..\..\Core\Assemblies\X.dll) and MSBuild-var ($(SomeAssembly)\X.dll) — only the file
# name matters, so a variable in the directory portion is harmless.
function Get-CsProjRefAssemblies($csprojPath) {
    try { [xml]$xml = Get-Content $csprojPath -Raw } catch { return @() }
    $out = @()
    foreach ($ig in @($xml.Project.ItemGroup)) {
        foreach ($r in @($ig.Reference)) {
            if (-not $r) { continue }
            $hp = $r.HintPath
            if (-not $hp) { continue }
            $out += ([System.IO.Path]::GetFileNameWithoutExtension($hp)).ToLower()
        }
    }
    return $out
}

function Resolve-BuildOrder($Root) {
    $mods = Get-HarnessMods -Root $Root      # {Name, FullName}
    $csproj  = @{}   # name -> csproj abs path (compiled mods only)
    $dataOnly = @()
    foreach ($m in $mods) {
        $cs = Get-ModCsProj $m.FullName
        if ($cs -and ($RS_BuildExclude -notcontains $m.Name)) { $csproj[$m.Name] = $cs }
        else { $dataOnly += $m.Name }        # no csproj, or explicitly excluded
    }

    # assembly name -> mod name, to translate a referenced DLL back to the mod that builds it.
    $asmToMod = @{}
    foreach ($name in $csproj.Keys) { $asmToMod[(Get-ModAssemblyName $csproj[$name])] = $name }

    # Dependency edges: mod -> compiled mods whose assembly it references.
    $deps = @{}
    foreach ($name in $csproj.Keys) {
        $set = New-Object System.Collections.Generic.HashSet[string]
        foreach ($asm in (Get-CsProjRefAssemblies $csproj[$name])) {
            if ($asmToMod.ContainsKey($asm)) {
                $dep = $asmToMod[$asm]
                if ($dep -ne $name) { [void]$set.Add($dep) }
            }
        }
        $deps[$name] = $set
    }

    # Stable topological sort: pick the first (name-sorted) mod whose deps are all placed,
    # so the order is deterministic and preserves name order wherever deps don't constrain it.
    $order = @()
    $placed = New-Object System.Collections.Generic.HashSet[string]
    $remaining = @($csproj.Keys | Sort-Object)
    while ($remaining.Count -gt 0) {
        $idx = -1
        for ($i = 0; $i -lt $remaining.Count; $i++) {
            $ready = $true
            foreach ($d in $deps[$remaining[$i]]) { if (-not $placed.Contains($d)) { $ready = $false; break } }
            if ($ready) { $idx = $i; break }
        }
        if ($idx -lt 0) { foreach ($n in $remaining) { $order += $n; [void]$placed.Add($n) }; break }  # cycle
        $n = $remaining[$idx]; $order += $n; [void]$placed.Add($n)
        $remaining = @($remaining | Where-Object { $_ -ne $n })
    }

    return [pscustomobject]@{ Order = $order; Csproj = $csproj; DataOnly = $dataOnly; Deps = $deps }
}

# Given a build plan and an optional single repo, return the mods to build: the repo's
# transitive dependencies first, then the repo, in canonical build order. No repo → all.
function Get-BuildTargets {
    param($Info, [string]$Repo)
    if (-not $Repo) { return @($Info.Order) }
    $need  = New-Object System.Collections.Generic.HashSet[string]
    $stack = New-Object System.Collections.Generic.Stack[string]
    $stack.Push($Repo)
    while ($stack.Count -gt 0) {
        $n = $stack.Pop()
        if (-not $need.Add($n)) { continue }
        if ($Info.Deps.ContainsKey($n)) { foreach ($d in $Info.Deps[$n]) { $stack.Push($d) } }
    }
    return @($Info.Order | Where-Object { $need.Contains($_) })
}

$Global:RS_BuildInfo = Resolve-BuildOrder $RS_Root
$Global:RS_DataOnly  = $RS_BuildInfo.DataOnly
# Back-compat for scripts that read RS_BuildOrder (deploy.ps1, verify-binaries.ps1):
# ordered map of build name -> absolute csproj path, in dependency order.
$Global:RS_BuildOrder = [ordered]@{}
foreach ($n in $RS_BuildInfo.Order) { $Global:RS_BuildOrder[$n] = $RS_BuildInfo.Csproj[$n] }

function RS-Json($obj) { $obj | ConvertTo-Json -Depth 8 }
function RS-Log($msg)  { Write-Host "[harness] $msg" }
