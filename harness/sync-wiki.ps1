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
    [switch]$WhatIf
)
. "$PSScriptRoot\lib.ps1"

$work = Join-Path ([System.IO.Path]::GetTempPath()) "rimsynapse-wiki-sync"
if (-not (Test-Path $work)) { New-Item -ItemType Directory -Force $work | Out-Null }

$targets = if ($Repo) { @($Repo) } else {
    @(Get-ChildItem $RS_Root -Directory |
      Where-Object { Test-Path (Join-Path $_.FullName 'Learning') } |
      Select-Object -ExpandProperty Name | Sort-Object)
}

$synced = @(); $skipped = @(); $problems = @()

foreach ($name in $targets) {
    $learning = Join-Path $RS_Root "$name\Learning"
    if (-not (Test-Path $learning)) { $skipped += @{ repo=$name; reason='no Learning/ folder' }; continue }

    $clone = Join-Path $work $name
    if (Test-Path $clone) { Remove-Item $clone -Recurse -Force }

    # SSH, matching how the mod repos authenticate — an HTTPS wiki clone pushes to a
    # credential prompt that cannot be answered non-interactively.
    $null = git clone --quiet "git@github.com:RimSynapse/$name.wiki.git" $clone 2>&1
    if (-not (Test-Path (Join-Path $clone '.git'))) {
        # GitHub does not create the wiki repo until the first page exists.
        $skipped += @{ repo=$name; reason='wiki not initialised — create a first page in the GitHub UI, then re-run' }
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
if (-not $ok) { exit 1 }
