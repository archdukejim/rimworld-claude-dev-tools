<#
.SYNOPSIS  Verify each mod's version and changelog agree everywhere they are stated. Run before a release.

.DESCRIPTION
  A mod's version is written in THREE independent places, and they drift silently:

    1. About/About.xml  <modVersion>        — what mod managers and RimSort read
    2. About/About.xml  <description>       — the blurb shown in the in-game mod list
    3. About/steam_description.txt          — the Workshop page copy

  Nothing links them. v0.6.0 shipped with (1) bumped but (2) still reading v0.5.2 and
  carrying no 0.6.0 changelog, because the release only updated (1) and (3) — the
  description embedded in About.xml is easy to forget precisely because it duplicates
  the Workshop copy.

  This checks that all three agree, that the description's changelog actually mentions
  the current version, and that About.xml is well-formed. Exit 1 on any problem, so it
  can gate a release alongside verify-binaries.ps1.

.EXAMPLE   .\verify-metadata.ps1
.OUTPUTS   JSON: { ok, checked[], problems[] }
#>
param(
    # Check one mod instead of every mod in the workspace.
    [string]$Repo,
    # Where to look. Defaults to RIMSYNAPSE_ROOT, then an upward walk. In CI this is the
    # single-repo checkout, which is the mod folder itself.
    [string]$Root
)
. "$PSScriptRoot\lib.ps1"

if ($Root) { $Global:RS_Root = Resolve-WorkspaceRoot -Root $Root }

$checked  = @()
$problems = @()

# Throws, rather than returning nothing, when the filter or the root matches no mod.
$mods = Get-HarnessMods -Root $RS_Root -Repo $Repo

foreach ($mod in $mods) {
    $name      = $mod.Name
    $aboutPath = Join-Path $mod.FullName 'About\About.xml'
    $steamPath = Join-Path $mod.FullName 'About\steam_description.txt'

    # Well-formedness first: a broken About.xml makes the mod invisible to RimWorld.
    $xml = $null
    try { [xml]$xml = Get-Content $aboutPath -Raw }
    catch {
        $problems += @{ mod=$name; issue="About.xml is not well-formed XML: $($_.Exception.Message)" }
        continue
    }

    $modVersion = $xml.ModMetaData.modVersion
    if (-not $modVersion) {
        $problems += @{ mod=$name; issue='About.xml has no <modVersion>' }
        continue
    }

    # Dev-only mods (TestRunner) never reach the Workshop, so they have no player-facing
    # copy to keep in sync. A steam_description.txt is what marks a mod as published.
    if (-not (Test-Path $steamPath)) {
        $checked += @{ mod=$name; field='dev-only'; value="v$modVersion (description checks skipped)" }
        continue
    }

    $description = [string]$xml.ModMetaData.description

    # (2) the in-game description's own version line
    if ($description -match '(?m)^Version:\s*v([0-9][0-9\.]*)') {
        $descVersion = $matches[1]
        if ($descVersion -ne $modVersion) {
            $problems += @{ mod=$name
                            issue="About.xml <description> says v$descVersion but <modVersion> is $modVersion — the in-game mod list will show the wrong version" }
        } else {
            $checked += @{ mod=$name; field='description version'; value="v$descVersion" }
        }
    } else {
        $problems += @{ mod=$name; issue='About.xml <description> has no "Version: vX.Y.Z" line' }
    }

    # (2b) the description's changelog must actually cover this release
    if ($description -match '--- Changelog ---') {
        if ($description -notmatch [regex]::Escape("v$modVersion")) {
            $problems += @{ mod=$name
                            issue="About.xml <description> changelog has no v$modVersion entry — players updating will see no notes" }
        } else {
            $checked += @{ mod=$name; field='description changelog'; value="mentions v$modVersion" }
        }
    }

    # (3) the Workshop copy
    if (Test-Path $steamPath) {
        $steam = Get-Content $steamPath -Raw

        # Steam's description field is maxlength=8000. Over that, the save is REJECTED
        # SILENTLY — the edit page accepts the paste, the Save button appears to work, and
        # the live page keeps the old text. v0.6.0/v0.6.1 descriptions hit this at 12k
        # chars and several "successful" saves changed nothing.
        $steamLen = ($steam -replace "`r`n", "`n").Length
        if ($steamLen -gt 8000) {
            $problems += @{ mod=$name
                            issue="steam_description.txt is $steamLen chars; Steam's limit is 8000 and it rejects longer descriptions silently — trim it by $($steamLen - 8000)" }
        } else {
            $checked += @{ mod=$name; field='workshop length'; value="$steamLen/8000" }
        }

        if ($steam -match '(?m)^\[b\]Version:\[/b\]\s*v([0-9][0-9\.]*)') {
            $steamVersion = $matches[1]
            if ($steamVersion -ne $modVersion) {
                $problems += @{ mod=$name
                                issue="steam_description.txt says v$steamVersion but <modVersion> is $modVersion" }
            } else {
                $checked += @{ mod=$name; field='workshop version'; value="v$steamVersion" }
            }
        } else {
            $problems += @{ mod=$name; issue='steam_description.txt has no "[b]Version:[/b] vX.Y.Z" line' }
        }
    }

    # (4) About/Manifest.xml — the Version Checker companion file that drives the in-game compat
    # tracker (Core #91). Validated IF PRESENT; not yet required, since each mod adds it as part of
    # its tracker-integration issue. Its <version> must equal <modVersion> so the tracker can't
    # report a version the mod list disagrees with; <coreVersion> (the min-Core floor) must parse.
    $manifestPath = Join-Path $mod.FullName 'About\Manifest.xml'
    if (Test-Path $manifestPath) {
        $maniXml = $null
        try { [xml]$maniXml = Get-Content $manifestPath -Raw }
        catch { $problems += @{ mod=$name; issue="Manifest.xml is not well-formed XML: $($_.Exception.Message)" } }

        if ($maniXml) {
            $maniVersion = $maniXml.Manifest.version
            if (-not $maniVersion) {
                $problems += @{ mod=$name; issue='Manifest.xml has no <version>' }
            } elseif ($maniVersion -ne $modVersion) {
                $problems += @{ mod=$name
                                issue="Manifest.xml <version> is $maniVersion but <modVersion> is $modVersion — the compat tracker would report a version the mod list disagrees with" }
            } else {
                $checked += @{ mod=$name; field='manifest version'; value="v$maniVersion" }
            }

            $coreFloor = $maniXml.Manifest.coreVersion
            if ($coreFloor -and ($coreFloor -notmatch '^[0-9]+(\.[0-9]+){0,3}$')) {
                $problems += @{ mod=$name; issue="Manifest.xml <coreVersion> '$coreFloor' is not a valid version" }
            } elseif ($coreFloor) {
                $checked += @{ mod=$name; field='manifest core floor'; value="Core >= $coreFloor" }
            }
        }
    }
}

$ok = ($problems.Count -eq 0)
RS-Log "$($mods.Count) mod(s) inspected, $($checked.Count) field(s) verified, $($problems.Count) problem(s)."
RS-Json @{ ok=$ok; checked=$checked; problems=$problems }
if (-not $ok) { exit 1 }
