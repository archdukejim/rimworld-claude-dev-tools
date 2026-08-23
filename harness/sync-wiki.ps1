<#
.SYNOPSIS  Publish each mod's Learning/ docs to its GitHub wiki.

.DESCRIPTION
  Every mod's Learning/*.md files are injected into RimWorld's Learning Helper at
  startup AND are the source for that repo's GitHub wiki — the "Official Wiki and
  Documentation" link in every mod description. Nothing kept the two in step: the
  wikis were last synced by hand, drifted for weeks, and ended up serving renamed
  and deleted pages.

  This mirrors Learning/ into <repo>.wiki.git: adds new pages, updates changed ones,
  and deletes pages whose source file is gone (a renamed doc must not linger under
  its old title). Repos whose wiki has never been initialised are reported and
  skipped — GitHub creates the wiki repo only after the first page is made in the
  web UI.

.EXAMPLE   .\sync-wiki.ps1 -WhatIf     # report what would change, push nothing
.EXAMPLE   .\sync-wiki.ps1             # sync and push every repo
.EXAMPLE   .\sync-wiki.ps1 -Repo Core
.OUTPUTS   JSON: { ok, synced[], skipped[], problems[] }
#>
param(
    [string]$Repo,
    # Where to look. In CI this is the single-repo checkout, which is the mod folder itself.
    [string]$Root,
    [switch]$WhatIf
)
. "$PSScriptRoot\lib.ps1"

if ($Root) { $Global:RS_Root = Resolve-WorkspaceRoot -Root $Root }

$work = Join-Path ([System.IO.Path]::GetTempPath()) "rimsynapse-wiki-sync"
if (-not (Test-Path $work)) { New-Item -ItemType Directory -Force $work | Out-Null }

# Resolve to real folders rather than assuming "$RS_Root\$name": in a single-repo checkout
# the root IS the mod, so that join would point one level too deep and silently find nothing.
# Throws when the root or the -Repo filter matches no mod at all.
$targets = Get-HarnessMods -Root $RS_Root -Repo $Repo

$synced = @(); $skipped = @(); $problems = @()

foreach ($mod in $targets) {
    $name     = $mod.Name
    $learning = Join-Path $mod.FullName 'Learning'
    if (-not (Test-Path $learning)) { $skipped += @{ repo=$name; reason='no Learning/ folder' }; continue }

    $clone = Join-Path $work $name
    if (Test-Path $clone) { Remove-Item $clone -Recurse -Force }

    # Clone the wiki. CI runners have no SSH key, so prefer HTTPS with a PAT
    # (WIKI_PAT, falling back to GH_TOKEN / GITHUB_TOKEN) which authenticates
    # non-interactively; fall back to SSH for local runs where a key is present.
    # The token is only ever embedded in the throwaway clone's remote URL and the
    # clone output is discarded, so it is never printed. The same URL carries the
    # push credential below, so no separate auth step is needed.
    $pat = @($env:WIKI_PAT, $env:GH_TOKEN, $env:GITHUB_TOKEN) |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -First 1
    $wikiUrl = if ($pat) {
        "https://x-access-token:$pat@github.com/RimSynapse/$name.wiki.git"
    } elseif ($WhatIf) {
        # The gate path only reads, and the wikis are public: clone anonymously so a
        # hosted runner with no PAT and no SSH key can still check drift (Core#85).
        "https://github.com/RimSynapse/$name.wiki.git"
    } else {
        "git@github.com:RimSynapse/$name.wiki.git"
    }
    git clone --quiet $wikiUrl $clone 2>&1 | Out-Null
    # A failed clone leaves a non-zero $LASTEXITCODE; clear it so it cannot leak into
    # this script's exit status (GitHub's pwsh wrapper exits the step with $LASTEXITCODE).
    # Failure is detected by the missing .git dir below instead.
    $global:LASTEXITCODE = 0
    if (-not (Test-Path (Join-Path $clone '.git'))) {
        # GitHub creates the wiki repo only after the first page exists; a missing
        # credential lands here too, so name both causes.
        $skipped += @{ repo=$name; reason='wiki clone failed — wiki not initialised, or no wiki credentials (set WIKI_PAT)' }
        continue
    }

    $added = @(); $updated = @(); $removed = @()

    $sourceFiles = @(Get-ChildItem $learning -Filter *.md -File)
    foreach ($src in $sourceFiles) {
        $dest = Join-Path $clone $src.Name
        if (-not (Test-Path $dest)) {
            Copy-Item $src.FullName $dest
            $added += $src.Name
        } elseif ((Get-FileHash $src.FullName).Hash -ne (Get-FileHash $dest).Hash) {
            Copy-Item $src.FullName $dest -Force
            $updated += $src.Name
        }
    }

    # A page whose source is gone was renamed or retired; leaving it would serve
    # documentation that no longer exists anywhere else.
    $sourceNames = @($sourceFiles | Select-Object -ExpandProperty Name)
    foreach ($page in @(Get-ChildItem $clone -Filter *.md -File)) {
        if ($page.Name -notin $sourceNames) {
            Remove-Item $page.FullName -Force
            $removed += $page.Name
        }
    }

    if ($added.Count + $updated.Count + $removed.Count -eq 0) {
        $synced += @{ repo=$name; result='already up to date' }
        continue
    }

    if ($WhatIf) {
        $synced += @{ repo=$name; result='would change'; added=$added; updated=$updated; removed=$removed }
        continue
    }

    Push-Location $clone
    try {
        git add -A 2>&1 | Out-Null
        $msg = "Sync wiki from Learning/ (+$($added.Count) ~$($updated.Count) -$($removed.Count))"
        git commit -m $msg 2>&1 | Out-Null
        $push = git push origin 2>&1
        if ($LASTEXITCODE -ne 0) {
            $problems += @{ repo=$name; issue="push failed: $push" }
        } else {
            $synced += @{ repo=$name; result='pushed'; added=$added; updated=$updated; removed=$removed }
            RS-Log "$name wiki: +$($added.Count) ~$($updated.Count) -$($removed.Count)"
        }
    }
    finally { Pop-Location }
}

$ok = ($problems.Count -eq 0)
RS-Json @{ ok=$ok; synced=$synced; skipped=$skipped; problems=$problems }
# Exit explicitly on the success path too: a git call earlier (e.g. a failed wiki
# clone) can leave $LASTEXITCODE non-zero, and GitHub's pwsh wrapper would otherwise
# fail the step on that stale code even though nothing is actually wrong.
if (-not $ok) { exit 1 }
exit 0
