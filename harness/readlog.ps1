<#
.SYNOPSIS  Parse & classify RimWorld's Player.log from the last launch marker.
.DESCRIPTION
    Reads Player.log from the byte offset recorded by launch.ps1 (falls back to the whole file
    if Unity truncated it on start). Buckets lines into compatibility-relevant categories and
    parses [SYNAPSE-TEST] results. Emits JSON and exits 1 if any blocking category is non-empty.
.EXAMPLE   .\readlog.ps1
.EXAMPLE   .\readlog.ps1 -Full           # ignore marker, scan whole log
.OUTPUTS   JSON: { ok, counts{}, categories{}, tests{ passed, failed, cases[] } }
#>
param([switch]$Full, [int]$MaxPerCategory = 25)
. "$PSScriptRoot\lib.ps1"

if (-not (Test-Path $RS_PlayerLog)) { RS-Json @{ ok=$false; error="Player.log not found at $RS_PlayerLog" }; exit 2 }

# Read from marker offset (byte-accurate), else whole file.
$bytes  = [System.IO.File]::ReadAllBytes($RS_PlayerLog)
$offset = 0
if (-not $Full -and (Test-Path $RS_Marker)) {
    $m = 0; [void][int]::TryParse((Get-Content $RS_Marker -Raw).Trim(), [ref]$m)
    if ($m -le $bytes.Length) { $offset = $m }   # if log grew; truncated => stays 0
}
$text  = [System.Text.Encoding]::UTF8.GetString($bytes, $offset, $bytes.Length - $offset)
$lines = $text -split "`r?`n"

# Classification patterns (first match wins, in this priority order).
# Benign buckets (metadataWarning/missingDependency/versionWarning) are surfaced but non-blocking.
# NOTE: metadataWarning must precede harmonyPatchFailure so "...(brrainz.harmony)..." metadata
# lines don't get misfiled as patch failures.
$patterns = [ordered]@{
    synapseTest         = '\[SYNAPSE-TEST\]'
    metadataWarning     = '(?i)needs to have <downloadUrl>'
    harmonyPatchFailure = '(?i)(harmony[^\n]*(exception|fail|error|conflict))|(failed to (apply )?patch)|(patch[^\n]*(threw|failed))'
    missingDependency   = '(?i)requires the mod|which is not loaded|you are missing|is not loaded'
    versionWarning      = '(?i)made for a different version|different version of RimWorld|not compatible with the current'
    xmlError            = '(?i)XML error|Could not (load|find|resolve)[^\n]*(Def|type)|Def named .* not found|Config error'
    exception           = '(?i)exception|stacktrace'
    error               = '(?i)^\s*(\[[^\]]*\])?\s*error\b|^Verse\.Log'
}
$cat = @{}; foreach ($k in $patterns.Keys) { $cat[$k] = @() }

# A bare "at Foo.Bar ()" line is only evidence of a problem when it belongs to a real
# exception. Mods also log System.Diagnostics.StackTrace deliberately for tracing, which
# produces identical-looking frames — counting those as exceptions is a false positive.
# Frames are therefore only attributed while an exception headline is still "open".
$frameRegex = '^\s+at\s+\S+'
$inException = $false

foreach ($ln in $lines) {
    if ([string]::IsNullOrWhiteSpace($ln)) { $inException = $false; continue }

    if ($ln -match $frameRegex) {
        if ($inException) { $cat.exception += $ln.Trim() }
        continue    # orphan frame => deliberate trace logging, not an error
    }

    $matched = $false
    foreach ($k in $patterns.Keys) {
        if ($ln -match $patterns[$k]) {
            $cat[$k] += $ln.Trim()
            $inException = ($k -eq 'exception')
            $matched = $true
            break
        }
    }
    if (-not $matched) { $inException = $false }
}

# Parse [SYNAPSE-TEST] results.
$cases = @(); $passed = 0; $failed = 0
foreach ($ln in $cat.synapseTest) {
    if ($ln -match '\[SYNAPSE-TEST\]\s+(PASS|FAIL)\s+(\S+)\s*(\|\s*(.*))?') {
        $res = $Matches[1]; $name = $Matches[2]; $detail = $Matches[4]
        $cases += @{ result=$res; name=$name; detail=$detail }
        if ($res -eq 'PASS') { $passed++ } else { $failed++ }
    }
}

$counts = @{}; foreach ($k in $patterns.Keys) { $counts[$k] = $cat[$k].Count }
$trim   = @{}; foreach ($k in $patterns.Keys) { $trim[$k] = @($cat[$k] | Select-Object -First $MaxPerCategory) }

# Blocking = anything that breaks load/behavior. Warnings (version/missingDep) are non-blocking here.
$blocking = $counts.harmonyPatchFailure + $counts.xmlError + $counts.exception + $counts.error + $failed
$ok = ($blocking -eq 0)

RS-Json @{ ok=$ok; blockingCount=$blocking; counts=$counts; categories=$trim; tests=@{ passed=$passed; failed=$failed; cases=$cases } }
if (-not $ok) { exit 1 }
