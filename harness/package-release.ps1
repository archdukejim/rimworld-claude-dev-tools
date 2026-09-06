# package-release.ps1 — build the installable .zip asset for a GitHub release (Core#109).
#
# RimSort installs mods from GitHub by downloading a release's .zip *asset*; the
# auto-generated "Source code (zip)" does not count. This script packages the
# shippable payload of a release tag — About/, Assemblies/, Defs/, Languages/,
# Learning/, Patches/, Sounds/, Textures/, LoadFolders.xml, LICENSE — into
# <Repo>-<version>.zip with the mod files at the ZIP ROOT (no top-level folder:
# RimSort creates the mod folder itself on install, so a nested <Repo>/<Repo>/
# layout cannot load), and (with -Upload) attaches it to the release.
#
# Tags that predate DLL tracking (Core <= v0.9.0, R&T <= v0.8.0) have no DLLs in
# the tag tree; for those the local Assemblies/*.dll are injected, but only after
# each file's SHA256 matches the tag's own Assemblies/CHECKSUMS.sha256 record.
# A DLL that cannot be verified fails the run — never ship an unverified binary.
#
#   .\harness\package-release.ps1                       # zip latest release of every shipped repo
#   .\harness\package-release.ps1 -Repo Core            # one repo
#   .\harness\package-release.ps1 -Repo Core -Tag v0.9.0
#   .\harness\package-release.ps1 -Repo Core-MMF -Tag v0.3.2 -Upload   # any org: slug comes from origin
#   .\harness\package-release.ps1 -Upload               # also attach to the GitHub release
#
# -Repo is a mod NAME or a PATH. A name is resolved, in order: RIMAGENTIC_ROOT/RIMSYNAPSE_ROOT
# (explicit override), the legacy C:\github\rimsynapse pin, then every workspace folder beside
# this checkout (C:\github\<workspace>\<Repo>) — so Regions-and-societies\Core-MMF resolves with
# no env var. The GitHub <owner>/<repo> for `releases/latest` and the upload comes from the mod's
# own `origin` remote, never from a configured org.

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

function Test-ModDir([string]$Dir) { return ($Dir -and (Test-Path (Join-Path $Dir 'About\About.xml'))) }

# Turn a -Repo value (name or path) into the mod checkout folder. See the header for the order.
function Resolve-ModRepo([string]$Name) {
    if (Test-ModDir $Name) { return (Resolve-Path $Name).Path }
    $override = if ($env:RIMAGENTIC_ROOT) { $env:RIMAGENTIC_ROOT } else { $env:RIMSYNAPSE_ROOT }
    if ($override) {
        $p = Join-Path $override $Name
        if (Test-ModDir $p) { return $p }
        throw "$Name is not a mod checkout under $override (RIMAGENTIC_ROOT/RIMSYNAPSE_ROOT is set, so nothing else is searched)"
    }
    $legacy = Join-Path 'C:\github\rimsynapse' $Name
    if (Test-ModDir $legacy) { return $legacy }
    # Every workspace beside this checkout: walk up from the tooling repo (a worktree sits two
    # levels deeper than the main checkout) and look at <sibling>\<Name> at each level.
    $found = @()
    $dir = Split-Path -Parent $PSScriptRoot
    for ($i = 0; $i -lt 4 -and $dir; $i++) {
        $dir = Split-Path -Parent $dir
        if (-not $dir) { break }
        $found += Get-ChildItem $dir -Directory -ErrorAction SilentlyContinue |
            ForEach-Object { Join-Path $_.FullName $Name } |
            Where-Object { Test-ModDir $_ }
    }
    $found = @($found | Select-Object -Unique)
    if ($found.Count -eq 1) { return $found[0] }
    if ($found.Count -gt 1) { throw "$Name exists in more than one workspace ($($found -join ', ')); pass a path or set RIMSYNAPSE_ROOT" }
    throw "${Name}: no mod checkout found (not a path, not under RIMSYNAPSE_ROOT, C:\github\rimsynapse, or any workspace beside $(Split-Path -Parent $PSScriptRoot))"
}

# <owner>/<repo> from the mod's own origin remote — repos live in more than one org.
function Get-OriginSlug([string]$Path) {
    $originUrl = git -C $Path remote get-url origin 2>$null
    if ($originUrl -match 'github\.com[:/]([^/]+/[^/]+?)(\.git)?/?$') { return $Matches[1] }
    throw "$Path has no GitHub origin remote to derive <owner>/<repo> from (got '$originUrl')"
}

$payload = @('About', 'Assemblies', 'Defs', 'Languages', 'Learning', 'Patches',
             'Sounds', 'Textures', 'LoadFolders.xml', 'LICENSE')

$results = @()
foreach ($r in $Repo) {
    $path = Resolve-ModRepo $r
    $r = Split-Path -Leaf $path          # zip/staging name, even when -Repo was a path
    $slug = Get-OriginSlug $path
    $zipDir = if ($OutDir) { $OutDir } else { Join-Path (Split-Path -Parent $path) '_release-zips' }
    New-Item -ItemType Directory -Force $zipDir | Out-Null
    Write-Host "[package] $r -> $path (github: $slug)"

    # Deliberately NOT a lowercase '$tag' local: PowerShell variable names are
    # case-insensitive, so '$tag = $Tag' is a self-assignment that carries
    # iteration N's tag into iteration N+1.
    $relTag = if ($Tag) { $Tag } else { gh api "repos/$slug/releases/latest" --jq .tag_name }
    if (-not $relTag) { throw "${r}: no release found" }
    $version = $relTag.TrimStart('v')

    # Only archive payload paths that exist in the tag's tree.
    $tree = git -C $path ls-tree --name-only $relTag
    if ($LASTEXITCODE -ne 0) { throw "${r}: tag $relTag not found locally — git fetch --tags first" }
    $paths = $payload | Where-Object { $tree -contains $_ }

    $staging = Join-Path $env:TEMP "rimsynapse-pkg\$r"
    if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
    New-Item -ItemType Directory -Force $staging | Out-Null

    # No --prefix: the mod files sit at the ZIP ROOT. RimSort creates the mod folder itself
    # on install, so a zip with a top-level <Repo>/ folder ends up as <Repo>/<Repo>/ in Mods
    # and RimSort cannot load it.
    $tmpZip = Join-Path $env:TEMP "rimsynapse-pkg\$r-archive.zip"
    git -C $path archive --format=zip -o $tmpZip $relTag -- @paths
    if ($LASTEXITCODE -ne 0) { throw "${r}: git archive failed for $relTag" }
    Expand-Archive $tmpZip -DestinationPath $staging
    Remove-Item $tmpZip

    # Inject locally built DLLs when the tag tree has none (pre-#95 tags) —
    # verified against the tag's own checksum manifest, or refused.
    $stagedAsm = Join-Path $staging 'Assemblies'
    $localAsm = Join-Path $path 'Assemblies'
    $hasStagedDll = (Test-Path $stagedAsm) -and (Get-ChildItem $stagedAsm -Filter *.dll)
    $localDlls = if (Test-Path $localAsm) { Get-ChildItem $localAsm -Filter *.dll } else { @() }
    if (-not $hasStagedDll -and $localDlls) {
        $manifest = Join-Path $stagedAsm 'CHECKSUMS.sha256'
        if (-not (Test-Path $manifest)) { throw "${r}: tag $relTag tracks no DLLs and has no CHECKSUMS.sha256 to verify local ones against" }
        $recorded = @{}
        Get-Content $manifest | Where-Object { $_ -match '^[0-9a-f]{64}\s+\S' } | ForEach-Object {
            # TrimStart('*'): sha256sum binary-mode manifests record "<hash> *<name>" —
            # some repos' release-manifest.ps1 writes that form (their verify-binaries.ps1
            # accepts it), so tolerate both here rather than keying on "*<name>".
            $h, $n = $_ -split '\s+', 2; $recorded[$n.Trim().TrimStart('*')] = $h
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

    # Guard (Core#117): never emit a zip whose CHECKSUMS.sha256 lists DLLs the staged
    # payload does not contain. This is what shipped a hollow Core-0.9.1.zip: the local
    # Assemblies/ was empty at package time, so the injection block above was silently
    # skipped and a zip with only CHECKSUMS.sha256 was produced with no error. A missing
    # DLL here means the release source was not built before packaging.
    $manifestPath = Join-Path $stagedAsm 'CHECKSUMS.sha256'
    if (Test-Path $manifestPath) {
        $listed = Get-Content $manifestPath |
            Where-Object { $_ -match '^[0-9a-f]{64}\s+\S' } |
            ForEach-Object { ($_ -split '\s+', 2)[1].Trim().TrimStart('*') }   # tolerate "* <name>" binary-mode records
        $missing = @($listed | Where-Object { -not (Test-Path (Join-Path $stagedAsm $_)) })
        if ($missing.Count) {
            throw "${r}: staged zip is missing DLL(s) listed in CHECKSUMS.sha256: $($missing -join ', '). Build the release source (Assemblies/) before packaging."
        }
    }

    $zip = Join-Path $zipDir "$r-$version.zip"
    if (Test-Path $zip) { Remove-Item $zip }
    Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zip
    # HARD REQUIREMENT: About/About.xml must sit at the ZIP ROOT. RimSort creates the mod folder
    # itself on install, so a zip carrying a top-level <Repo>/ folder lands as Mods/<Repo>/<Repo>/
    # and RimSort never detects the mod. Verified on the produced archive, not the staging dir.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
    try {
        $entries = @($archive.Entries | ForEach-Object { $_.FullName -replace '\\', '/' })
        if (-not ($entries -contains 'About/About.xml')) {
            throw "${r}: $zip does not have About/About.xml at the zip root - RimSort would install it nested (<Repo>/<Repo>/) and never detect it. First entries: $(($entries | Select-Object -First 5) -join ', ')"
        }
    } finally { $archive.Dispose() }
    $size = [math]::Round((Get-Item $zip).Length / 1MB, 2)
    Write-Host "[package] $r $relTag -> $zip (${size} MB)"

    if ($Upload) {
        gh release upload -R $slug $relTag $zip --clobber
        if ($LASTEXITCODE -ne 0) { throw "${r}: upload to $slug $relTag failed" }
        Write-Host "[package] $r $relTag asset uploaded to $slug"
    }
    $results += [pscustomobject]@{ repo = $r; github = $slug; tag = $relTag; zip = $zip; mb = $size; uploaded = [bool]$Upload }
}

$results | Format-Table -AutoSize
