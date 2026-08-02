<#
.SYNOPSIS  Run the comment-triage routine unattended, in draft mode.
.DESCRIPTION
    Self-contained hands-off run:
      1. Launches a DEDICATED background Chrome (its own profile, no window shown,
         Steam Workshop Helper extension preloaded) if not already running. This
         never touches your normal Chrome, so it doesn't disrupt you.
      2. Runs Claude Code headlessly to follow docs/COMMENT-TRIAGE.md Phases 1-3
         (classify + dedup + write the review report). Creates/posts NOTHING.

    AUTH: a scheduled headless run cannot refresh the subscription OAuth session,
    so this uses ANTHROPIC_API_KEY (set it as a user env var). Without it, the run
    logs a clear error and stops.

    ONE-TIME SETUP (see docs/SCHEDULING.md):
      - setx ANTHROPIC_API_KEY "sk-ant-..."   (you set it; never stored in the repo)
      - Log into Steam once in the dedicated profile (helper command in the docs).

    Report -> mcp-config/triage-report.json. Review + approve interactively later.
.EXAMPLE   .\run-triage.ps1
#>
$ErrorActionPreference = 'Stop'

# Node/claude/chrome are often installed after a shell starts; refresh PATH.
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')

$repo   = Split-Path $PSScriptRoot -Parent          # ...\rimworld-claude-dev-tools
$spec   = Join-Path $repo 'docs\COMMENT-TRIAGE.md'
$ext    = Join-Path $repo 'extension'
$log    = Join-Path $PSScriptRoot 'triage-last-run.log'
$profileDir = if ($env:SWH_CHROME_PROFILE) { $env:SWH_CHROME_PROFILE } else { Join-Path $env:LOCALAPPDATA 'swh-triage-chrome' }

# --- resolve chrome.exe ---
$chrome = $env:SWH_CHROME_PATH
if (-not $chrome) {
    foreach ($p in @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    )) { if (Test-Path $p) { $chrome = $p; break } }
}
if (-not $chrome) { throw "Chrome not found. Set SWH_CHROME_PATH to chrome.exe." }

"[triage] $(Get-Date -Format s) starting" | Out-File $log

# A Scheduled Task's environment may not inherit a user-scoped `setx` var, so
# resolve ANTHROPIC_API_KEY directly from the registry (user, then machine).
# ANTHROPIC_API_KEY takes precedence over the (unrefreshable) subscription OAuth,
# which is what makes an unattended `claude -p` run authenticate reliably.
if (-not $env:ANTHROPIC_API_KEY) {
    $env:ANTHROPIC_API_KEY = [Environment]::GetEnvironmentVariable('ANTHROPIC_API_KEY','User')
    if (-not $env:ANTHROPIC_API_KEY) {
        $env:ANTHROPIC_API_KEY = [Environment]::GetEnvironmentVariable('ANTHROPIC_API_KEY','Machine')
    }
}
if (-not $env:ANTHROPIC_API_KEY) {
    "[triage] ERROR: ANTHROPIC_API_KEY is not set (user or machine). A headless run cannot authenticate. See docs/SCHEDULING.md." |
        Tee-Object -FilePath $log -Append
    exit 1
}

# --- launch the dedicated background Chrome (no window; extension SW runs) ---
# Singleton per profile: a second launch is a no-op if it's already running, so
# hourly runs don't stack windows.
Write-Host "[triage] Ensuring dedicated Chrome (profile: $profileDir)..."
Start-Process -FilePath $chrome -WindowStyle Hidden -ArgumentList @(
    "--user-data-dir=$profileDir",
    "--load-extension=$ext",
    "--no-startup-window",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=DialMediaRouteProvider"
)
Start-Sleep -Seconds 6   # let the extension service worker spin up

# --- run the draft triage agent (API-key auth, read-only tools only) ---
$prompt = @"
Follow the routine in $spec exactly, in draft mode (Phases 1-3 ONLY).
First call swh_open_item for one of your workshop items to guarantee a
steamcommunity.com tab exists, then classify recent comments, dedup against
existing GitHub issues, and write the review report to
mcp-config/triage-report.json. Do NOT create any GitHub issue and do NOT post
any Steam reply. If Steam is not logged in, write a report noting that and stop.
"@

$allowed = @(
    'mcp__rimworld-claude-dev-tools__swh_open_item',
    'mcp__rimworld-claude-dev-tools__swh_review_notifications',
    'mcp__rimworld-claude-dev-tools__swh_get_notifications',
    'mcp__rimworld-claude-dev-tools__swh_list_comments',
    'mcp__rimworld-claude-dev-tools__swh_repo_for_item',
    'mcp__rimworld-claude-dev-tools__swh_find_issue',
    'Write'
) -join ','

Write-Host "[triage] Running draft triage (headless, API key)..."
Push-Location $repo
try {
    claude -p $prompt --allowedTools $allowed 2>&1 | Tee-Object -FilePath $log -Append
    if ($LASTEXITCODE -ne 0) { throw "claude exited with code $LASTEXITCODE (see $log)" }
} finally { Pop-Location }

Write-Host "[triage] Done. Report at $repo\mcp-config\triage-report.json"
