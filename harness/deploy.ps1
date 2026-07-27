<#
.SYNOPSIS  Symlink each RimSynapse repo into RimWorld\Mods so the game loads them.
           Idempotent; requires admin OR Windows Developer Mode for symlinks.
.OUTPUTS   JSON: { ok, linked[], skipped[] }
#>
. "$PSScriptRoot\lib.ps1"

$modNames = @($RS_BuildOrder.Keys) + $RS_DataOnly
$linked = @(); $skipped = @()
foreach ($name in $modNames) {
    $src = Join-Path $RS_Root $name
    if (-not (Test-Path (Join-Path $src 'About\About.xml'))) { $skipped += $name; continue }
    $link = Join-Path $RS_ModsDir $name
    $existing = Get-Item $link -ErrorAction SilentlyContinue
    if ($existing -and $existing.LinkType -eq 'SymbolicLink' -and $existing.Target -eq $src) { $skipped += $name; continue }
    New-Item -ItemType SymbolicLink -Path $link -Target $src -Force | Out-Null
    $linked += $name
}
RS-Json @{ ok=$true; linked=$linked; skipped=$skipped }
