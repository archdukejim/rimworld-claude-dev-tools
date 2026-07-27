<#
.SYNOPSIS  Verify every shipped binary matches its source of truth. Run before a release.

.DESCRIPTION
  Two failure modes, two checks:

  1. Repos that TRACK their DLLs (the companions — a cloned companion repo is a playable
     mod, so the binary has to be in git). The hazard is drift: source lands, the DLL is
     never rebuilt, and the repo quietly describes a mod that does not exist. This happened
     — Psychology's ceremony escalation was source-only for weeks. With -Build, this
     rebuilds and fails if any committed DLL differs from a fresh build of its own source.

  2. Repos that do NOT track their DLLs (Core — its assemblies ship as Release assets).
     There is nothing in git to compare against, so the record is Assemblies/CHECKSUMS.sha256
     written by release-manifest.ps1. This fails if a DLL is missing from the manifest,
     absent from disk, or hashes differently — which is how you confirm the files you are
     about to upload to the Workshop are byte-for-byte the released build.

  Exit 1 on any problem, so this can gate a release.

.EXAMPLE   .\verify-binaries.ps1 -Build     # rebuild first, then verify (use before releasing)
.EXAMPLE   .\verify-binaries.ps1            # verify what is on disk right now
.OUTPUTS   JSON: { ok, checked[], problems[] }
#>
param(
    [switch]$Build
)
. "$PSScriptRoot\lib.ps1"

if ($Build) {
    RS-Log "Rebuilding all mods before verification ..."
    $buildOut = & "$PSScriptRoot\build.ps1" 2>&1
    $buildJson = $null
    try { $buildJson = ($buildOut | Where-Object { $_ -match '^\s*[\{"]' } | Out-String | ConvertFrom-Json) } catch { }
    if ($LASTEXITCODE -ne 0 -or ($buildJson -and -not $buildJson.ok)) {
        RS-Json @{ ok=$false; checked=@(); problems=@(@{ repo='(build)'; issue='build failed — cannot verify binaries' }) }
        exit 1
    }
}

$checked  = @()
$problems = @()

foreach ($name in $RS_BuildOrder.Keys) {
    $repoDir = Join-Path $RS_Root $name
    $asmDir  = Join-Path $repoDir 'Assemblies'
    if (-not (Test-Path $asmDir)) { continue }

    Push-Location $repoDir
    try {
        $tracked = @(git ls-files 'Assemblies/*.dll' 2>$null)

        if ($tracked.Count -gt 0) {
            # --- Tracked: working tree must equal HEAD -------------------------------
            foreach ($rel in $tracked) {
                $full = Join-Path $repoDir $rel
                if (-not (Test-Path $full)) {
                    $problems += @{ repo=$name; file=$rel; issue='tracked DLL missing from the working tree' }
                    continue
                }
                $workBlob = (git hash-object $full 2>$null)
                $headBlob = (git rev-parse "HEAD:$rel" 2>$null)
                if ($workBlob -ne $headBlob) {
                    $problems += @{ repo=$name; file=$rel
                                    issue='built DLL differs from the committed one — commit the rebuild, or the repo ships stale code' }
                } else {
                    $checked += @{ repo=$name; file=$rel; mode='tracked'; result='matches HEAD' }
                }
            }
        }
        else {
            # --- Untracked: disk must equal the release manifest ---------------------
            $manifest = Join-Path $asmDir 'CHECKSUMS.sha256'
            $dlls = @(Get-ChildItem (Join-Path $asmDir '*.dll') -ErrorAction SilentlyContinue)
            if ($dlls.Count -eq 0) { Pop-Location; continue }   # nothing shipped from here

            if (-not (Test-Path $manifest)) {
                $problems += @{ repo=$name
                                issue="ships $($dlls.Count) untracked DLL(s) with no CHECKSUMS.sha256 — run release-manifest.ps1 so the release has a record" }
                Pop-Location; continue
            }

            $expected = @{}
            foreach ($line in Get-Content $manifest) {
                if ($line -match '^\s*#' -or -not $line.Trim()) { continue }
                $parts = $line -split '\s+', 2
                if ($parts.Count -eq 2) { $expected[$parts[1].Trim()] = $parts[0].Trim().ToLower() }
            }

            foreach ($dll in $dlls) {
                $actual = (Get-FileHash $dll.FullName -Algorithm SHA256).Hash.ToLower()
                if (-not $expected.ContainsKey($dll.Name)) {
                    $problems += @{ repo=$name; file=$dll.Name; issue='on disk but absent from the manifest' }
                } elseif ($expected[$dll.Name] -ne $actual) {
                    $problems += @{ repo=$name; file=$dll.Name
                                    issue='hash differs from the manifest — this is not the build that was released' }
                } else {
                    $checked += @{ repo=$name; file=$dll.Name; mode='manifest'; result='matches CHECKSUMS.sha256' }
                }
            }

            foreach ($missing in $expected.Keys | Where-Object { $_ -notin $dlls.Name }) {
                $problems += @{ repo=$name; file=$missing; issue='listed in the manifest but missing from disk' }
            }
        }
    }
    finally { Pop-Location }
}

$ok = ($problems.Count -eq 0)
RS-Log "$($checked.Count) binary/binaries verified, $($problems.Count) problem(s)."
RS-Json @{ ok=$ok; checked=$checked; problems=$problems }
if (-not $ok) { exit 1 }
