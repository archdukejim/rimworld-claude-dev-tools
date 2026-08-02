<#
.SYNOPSIS  Run the comment-triage routine locally in draft mode.
.DESCRIPTION
    Invokes Claude Code headlessly to follow docs/COMMENT-TRIAGE.md, Phases 1-3
    only (classify + dedup + write the review report). It creates/posts NOTHING —
    it just produces mcp-config/triage-report.json for you to review and
    approve later in an interactive session.

    MUST run locally: the routine drives your logged-in Chrome via the extension
    and the MCP's 127.0.0.1 bridge. Preconditions at run time:
      - Chrome open, Steam Workshop Helper extension loaded, logged into Steam
      - rimworld-claude-dev-tools MCP registered (user scope) + a GitHub token

    Intended to be launched by Windows Task Scheduler (see docs/SCHEDULING.md).
.EXAMPLE   .\run-triage.ps1
#>
$ErrorActionPreference = 'Stop'

# Node/claude are often installed after a shell starts; refresh PATH.
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')

$repo = Split-Path $PSScriptRoot -Parent   # ...\rimworld-claude-dev-tools (harness is one level down)
$spec = Join-Path $repo 'docs\COMMENT-TRIAGE.md'
$logDir = $PSScriptRoot
$log = Join-Path $logDir 'triage-last-run.log'

$prompt = @"
Follow the routine in $spec exactly. Run Phases 1 through 3 ONLY (draft mode):
classify recent comments, dedup against existing GitHub issues, and write the
review report to mcp-config/triage-report.json. Do NOT create any GitHub
issue and do NOT post any Steam reply. If Chrome is not open/logged in, write a
report noting that and stop.
"@

Write-Host "[triage] Running draft triage via Claude Code (local, draft-only)..."
Push-Location $repo
try {
    # Read-only MCP tools this draft pass is allowed to use, so a headless run
    # doesn't stall on permission prompts. (No create/post tools here.)
    $allowed = @(
        'mcp__rimworld-claude-dev-tools__swh_review_notifications',
        'mcp__rimworld-claude-dev-tools__swh_get_notifications',
        'mcp__rimworld-claude-dev-tools__swh_list_comments',
        'mcp__rimworld-claude-dev-tools__swh_repo_for_item',
        'mcp__rimworld-claude-dev-tools__swh_find_issue',
        'Write'
    ) -join ','

    claude -p $prompt --allowedTools $allowed 2>&1 | Tee-Object -FilePath $log
    if ($LASTEXITCODE -ne 0) { throw "claude exited with code $LASTEXITCODE (see $log)" }
} finally { Pop-Location }

Write-Host "[triage] Done. Report at $repo\mcp-config\triage-report.json"
Write-Host "[triage] Review it interactively, then approve to file issues / post replies."
