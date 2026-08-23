<#
.SYNOPSIS  Find work that never reached `development`. Run before a release.

.DESCRIPTION
  Work on this machine is committed straight to `development`, so nothing here should
  normally have anything to report. It exists for the work that arrives from somewhere
  else: the gaming PC, an older session, a branch opened for a risky refactor and then
  forgotten. That work is invisible until someone thinks to look for it.

  Two questions, because "no open PRs" answers only the first:

    1. Is any pull request open against `development`?
    2. Does any branch carry commits `development` does not have?

  (2) is the one that matters. A branch needs no PR to be lost. Psychology's counseling
  report path sat hardcoded to `d:\github\rimsynapse\...` on `development` — failing on
  every other machine, silently, because the write is inside a try — while the fix sat
  finished on an unmerged branch with no PR against it. Zero open PRs was true the whole
  time.

  COMMIT COUNTS LIE after a squash merge. Core's `fix/wiki-concept-knowledge-rebind`
  showed 7 commits "not in development" while every one of its changes was already there,
  landed by another route, with `development` since moved past it. So an unmerged branch
  is reported for a human to judge, never auto-merged, and the report names the files it
  would change so that judgement is cheap.

  Branches already merged into `main` are release records (`release-v0.5.0` and the like)
  and are not reported.

.EXAMPLE   .\verify-branches.ps1
.EXAMPLE   .\verify-branches.ps1 -Repo Psychology
.OUTPUTS   JSON: { ok, checked[], problems[] }
#>
param(
    # Check one repo instead of every repo in the workspace.
    [string]$Repo,
    # Where to look. Defaults to RIMSYNAPSE_ROOT, then an upward walk.
    [string]$Root,
    # Skip the pull-request half. Useful offline, or when `gh` is not authenticated —
    # the branch sweep is local and still works.
    [switch]$SkipPullRequests
)
. "$PSScriptRoot\lib.ps1"

$workspace = Resolve-WorkspaceRoot -Root $Root

$repoDirs = Get-ChildItem -Path $workspace -Directory |
    Where-Object { Test-Path (Join-Path $_.FullName ".git") } |
    Where-Object { -not $Repo -or $_.Name -eq $Repo }

if (-not $repoDirs) {
    RS-Json @{ ok = $false; checked = @(); problems = @(@{ issue = "no git repositories found under $workspace" }) }
    exit 2
}

$ghAvailable = $false
if (-not $SkipPullRequests) {
    $ghAvailable = [bool](Get-Command gh -ErrorAction SilentlyContinue)
    if (-not $ghAvailable) { RS-Log "gh not found; checking branches only." }
}

$checked  = @()
$problems = @()

foreach ($dir in $repoDirs) {
    $name = $dir.Name
    $path = $dir.FullName

    # A repo with no `development` is not a defect — Repo-MCP and the tooling repos may
    # differ — but it cannot be swept, and saying so is better than counting it as clean.
    git -C $path rev-parse --verify --quiet development *> $null
    if ($LASTEXITCODE -ne 0) {
        $checked += @{ repo = $name; skipped = "no development branch" }
        continue
    }

    git -C $path fetch --quiet --prune 2>$null | Out-Null

    # --- 1. open pull requests -------------------------------------------------------
    $openPrs = @()
    if ($ghAvailable) {
        $slug = (git -C $path remote get-url origin 2>$null) -replace '\.git$','' -replace '.*[:/]([^/]+/[^/]+)$','$1'
        if ($slug) {
            $raw = gh pr list --repo $slug --state open --limit 50 --json number,title,baseRefName 2>$null
            if ($LASTEXITCODE -eq 0 -and $raw) {
                foreach ($pr in ($raw | ConvertFrom-Json)) {
                    $openPrs += @{ number = $pr.number; title = $pr.title; base = $pr.baseRefName }
                    $problems += @{
                        repo  = $name
                        kind  = "open-pull-request"
                        ref   = "#$($pr.number) -> $($pr.baseRefName)"
                        issue = "pull request is open and unmerged: $($pr.title)"
                    }
                }
            }
        }
    }

    # --- 2. branches carrying commits development lacks ------------------------------
    $refs = git -C $path for-each-ref --format='%(refname:short)' refs/heads refs/remotes/origin 2>$null |
        Where-Object { $_ -and $_ -notmatch '(^|/)(development|main|HEAD)$' -and $_ -ne 'origin' } |
        Sort-Object -Unique

    $unmerged = @()
    foreach ($branch in $refs) {
        $ahead = git -C $path rev-list --count "development..$branch" 2>$null
        if (-not $ahead -or [int]$ahead -eq 0) { continue }

        # Already released: its commits reached main, so development trailing it is
        # expected rather than lost work.
        git -C $path merge-base --is-ancestor $branch origin/main *> $null
        if ($LASTEXITCODE -eq 0) { continue }

        # Name the files so a human can tell "pending" from "superseded" without
        # checking out. A branch whose changes are all already present shows up here
        # with a diff that reads as already-applied — that judgement is the point.
        $files = git -C $path diff --name-only "development...$branch" 2>$null
        $fileList = @($files | Where-Object { $_ } | Select-Object -First 6)

        $unmerged += @{ branch = $branch; commits = [int]$ahead; files = $fileList }
        $problems += @{
            repo  = $name
            kind  = "unmerged-branch"
            ref   = $branch
            issue = "$ahead commit(s) not in development, touching: " +
                    $(if ($fileList) { $fileList -join ', ' } else { "(no file differences — likely already merged by squash)" })
        }
    }

    $checked += @{ repo = $name; openPullRequests = @($openPrs); unmergedBranches = @($unmerged) }
}

$sweptCount = @($checked | Where-Object { -not $_.skipped }).Count
RS-Log "$sweptCount repo(s) swept, $($problems.Count) item(s) not in development."
RS-Json @{ ok = ($problems.Count -eq 0); checked = $checked; problems = $problems }
if ($problems.Count -gt 0) { exit 1 }
