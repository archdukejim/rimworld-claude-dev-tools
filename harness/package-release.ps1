# package-release.ps1 — build the installable .zip asset for a GitHub release (Core#109).
#
# RimSort installs mods from GitHub by downloading a release's .zip *asset*; the
# auto-generated "Source code (zip)" does not count. This script packages the
# shippable payload of a release tag — About/, Assemblies/, Defs/, Languages/,
# Learning/, Patches/, Sounds/, Textures/, LoadFolders.xml, LICENSE — into
# <Repo>-<version>.zip with the repo name as the zip's top-level folder, and
# (with -Upload) attaches it to the release.
#
# Tags that predate DLL tracking (Core <= v0.9.0, R&T <= v0.8.0) have no DLLs in
# the tag tree; for those the local Assemblies/*.dll are injected, but only after
# each file's SHA256 matches the tag's own Assemblies/CHECKSUMS.sha256 record.
# A DLL that cannot be verified fails the run — never ship an unverified binary.
#
#   .\harness\package-release.ps1                       # zip latest release of every shipped repo
#   .\harness\package-release.ps1 -Repo Core            # one repo
#   .\harness\package-release.ps1 -Repo Core -Tag v0.9.0
#   .\harness\package-release.ps1 -Upload               # also attach to the GitHub release

param(
    [string[]]$Repo,
    [string]$Tag,
    [switch]$Upload,
    [string]$OutDir
)

$ErrorActionPreference = 'Stop'

$shipped = @('Core', 'Psychology', 'Conversations', 'Factions', 'WorldNews',
             'Regions-and-Territories', 'NVIDIA-Tool', 'AuraAlgorithm')
if (-not $Repo) { $Repo = $shipped }
if ($Tag -and $Repo.Count -gt 1) { throw "-Tag only makes sense with a single -Repo" }

$root = if ($env:RIMSYNAPSE_ROOT) { $env:RIMSYNAPSE_ROOT } else { 'C:\github\rimsynapse' }
if (-not $OutDir) { $OutDir = Join-Path $root '_release-zips' }
New-Item -ItemType Directory -Force $OutDir | Out-Null

$payload = @('About', 'Assemblies', 'Defs', 'Languages', 'Learning', 'Patches',
             'Sounds', 'Textures', 'LoadFolders.xml', 'LICENSE')

$results = @()
foreach ($r in $Repo) {
    $path = Join-Path $root $r
    if (-not (Test-Path (Join-Path $path 'About\About.xml'))) { throw "$r is not a mod checkout at $path" }

    # Deliberately NOT a lowercase '$tag' local: PowerShell variable names are
    # case-insensitive, so '$tag = $Tag' is a self-assignment that carries
    # iteration N's tag into iteration N+1.
    $relTag = if ($Tag) { $Tag } else { gh api "repos/RimSynapse/$r/releases/latest" --jq .tag_name }
    if (-not $relTag) { throw "${r}: no release found" }
    $version = $relTag.TrimStart('v')

    # Only archive payload paths that exist in the tag's tree.
    $tree = git -C $path ls-tree --name-only $relTag
    if ($LASTEXITCODE -ne 0) { throw "${r}: tag $relTag not found locally — git fetch --tags first" }
    $paths = $payload | Where-Object { $tree -contains $_ }

    $staging = Join-Path $env:TEMP "rimsynapse-pkg\$r"
    if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
    New-Item -ItemType Directory -Force $staging | Out-Null

    $tmpZip = Join-Path $env:TEMP "rimsynapse-pkg\$r-archive.zip"
    git -C $path archive --format=zip --prefix="$r/" -o $tmpZip $relTag -- @paths
    if ($LASTEXITCODE -ne 0) { throw "${r}: git archive failed for $relTag" }
    Expand-Archive $tmpZip -DestinationPath $staging
    Remove-Item $tmpZip

    # Inject locally built DLLs when the tag tree has none (pre-#95 tags) —
    # verified against the tag's own checksum manifest, or refused.
    $stagedAsm = Join-Path $staging "$r\Assemblies"
    $localAsm = Join-Path $path 'Assemblies'
    $hasStagedDll = (Test-Path $stagedAsm) -and (Get-ChildItem $stagedAsm -Filter *.dll)
    $localDlls = if (Test-Path $localAsm) { Get-ChildItem $localAsm -Filter *.dll } else { @() }
    if (-not $hasStagedDll -and $localDlls) {
        $manifest = Join-Path $stagedAsm 'CHECKSUMS.sha256'
        if (-not (Test-Path $manifest)) { throw "${r}: tag $relTag tracks no DLLs and has no CHECKSUMS.sha256 to verify local ones against" }
        $recorded = @{}
        Get-Content $manifest | Where-Object { $_ -match '^[0-9a-f]{64}\s+\S' } | ForEach-Object {
            $h, $n = $_ -split '\s+', 2; $recorded[$n.Trim()] = $h
        }
        foreach ($dll in $localDlls) {
            $actual = (Get-FileHash $dll.FullName -Algorithm SHA256).Hash.ToLower()
            if ($recorded[$dll.Name] -ne $actual) {
                throw "${r}: local $($dll.Name) does not match $relTag's CHECKSUMS.sha256 — rebuild the release source before packaging"
            }
            Copy-Item $dll.FullName $stagedAsm
        }
        Write-Host "[package] ${r}: injected $($localDlls.Count) DLL(s), checksum-verified against $relTag"
    }

    $zip = Join-Path $OutDir "$r-$version.zip"
    if (Test-Path $zip) { Remove-Item $zip }
    Compress-Archive -Path (Join-Path $staging $r) -DestinationPath $zip
    $size = [math]::Round((Get-Item $zip).Length / 1MB, 2)
    Write-Host "[package] $r $relTag -> $zip (${size} MB)"

    if ($Upload) {
        gh release upload -R "RimSynapse/$r" $relTag $zip --clobber
        if ($LASTEXITCODE -ne 0) { throw "${r}: upload to $relTag failed" }
        Write-Host "[package] $r $relTag asset uploaded"
    }
    $results += [pscustomobject]@{ repo = $r; tag = $relTag; zip = $zip; mb = $size; uploaded = [bool]$Upload }
}

$results | Format-Table -AutoSize
