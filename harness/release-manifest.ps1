<#
.SYNOPSIS  Write a checksum manifest recording exactly which binaries a release shipped.

.DESCRIPTION
  Core does not track its DLLs in git (they ship as GitHub Release assets), so without
  a manifest there is no permanent record of what was published — and a Workshop upload
  takes whatever happens to be on disk. This writes that record: SHA256, size, the mod
  version, and the commit the build came from, derived from the actual files being
  shipped rather than from anyone's memory.

  The output is standard sha256sum format with '#' metadata comments, so it verifies
  with ordinary tools as well as with verify-binaries.ps1.

.EXAMPLE   .\release-manifest.ps1                 # manifest for Core
.EXAMPLE   .\release-manifest.ps1 -Repo Factions  # any repo that ships assemblies
.OUTPUTS   JSON: { ok, repo, version, commit, manifest, files[] }  (exit 1 on failure)
#>
param(
    [string]$Repo = 'Core'
)
. "$PSScriptRoot\lib.ps1"

$repoDir = Join-Path $RS_Root $Repo
$asmDir  = Join-Path $repoDir 'Assemblies'
if (-not (Test-Path $asmDir)) {
    RS-Json @{ ok=$false; repo=$Repo; error="No Assemblies directory at $asmDir" }
    exit 1
}

$dlls = @(Get-ChildItem (Join-Path $asmDir '*.dll') | Sort-Object Name)
if ($dlls.Count -eq 0) {
    RS-Json @{ ok=$false; repo=$Repo; error="No DLLs in $asmDir — build before writing a manifest." }
    exit 1
}

# Version and commit come from the repo itself, so the manifest cannot claim to describe
# a build it was not generated alongside.
$version = 'unknown'
$aboutPath = Join-Path $repoDir 'About\About.xml'
if (Test-Path $aboutPath) {
    try { [xml]$about = Get-Content $aboutPath; $version = $about.ModMetaData.modVersion } catch { }
}
Push-Location $repoDir
$commit = (git rev-parse --short HEAD 2>$null)
$dirty  = [bool](git status --porcelain 2>$null | Where-Object { $_ -notmatch 'Assemblies/.*\.dll$' })
Pop-Location

$lines = @(
    "# RimSynapse $Repo — shipped assembly manifest"
    "# version: $version"
    "# commit:  $commit$(if ($dirty) { ' (working tree had other uncommitted changes)' })"
    "# format:  sha256sum — verify with 'verify-binaries.ps1' or 'sha256sum -c'"
)
$files = @()
foreach ($dll in $dlls) {
    $hash = (Get-FileHash $dll.FullName -Algorithm SHA256).Hash.ToLower()
    $lines += "$hash  $($dll.Name)"
    $files += @{ name=$dll.Name; sha256=$hash; bytes=$dll.Length }
}

$manifestPath = Join-Path $asmDir 'CHECKSUMS.sha256'
Set-Content -Path $manifestPath -Value ($lines -join "`n") -NoNewline
RS-Log "Wrote $($files.Count) checksum(s) to $manifestPath"

RS-Json @{ ok=$true; repo=$Repo; version=$version; commit=$commit; manifest=$manifestPath; files=$files }
