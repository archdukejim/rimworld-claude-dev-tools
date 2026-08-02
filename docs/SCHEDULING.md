# Scheduling the comment-triage routine

Runs **hands-off** on this machine: the runner launches a **dedicated background
Chrome** (its own profile, no window, extension preloaded) and then runs the
draft triage headlessly. It never touches your normal Chrome, so it doesn't
disrupt you. It **must run locally** (it drives that Chrome via the `127.0.0.1`
loopback bridge) — a cloud routine can't reach the browser.

Draft mode: each run writes `mcp-config/triage-report.json` and creates/posts
nothing. You review and approve interactively afterward.

## One-time setup (required for unattended runs)

1. **API key** — a scheduled headless run can't refresh the subscription OAuth
   session, so Claude Code authenticates via an API key (`ANTHROPIC_API_KEY`
   takes precedence over OAuth and is used immediately in `-p` mode). Set it (you
   set it; it's never stored in the repo):
   ```bash
   setx ANTHROPIC_API_KEY "sk-ant-..."
   ```
   The runner reads it from the registry (user, then machine) at run time, so a
   user-scoped `setx` reaches the Scheduled Task even though the task's inherited
   environment might not include it. (For a task running as SYSTEM/another
   account, use `setx /M` instead — needs an elevated shell.)
2. **Log into Steam once in the dedicated profile** — launch it visibly, sign in,
   then close it. The login cookie persists in that profile for future runs:
   ```bash
   "%ProgramFiles%\Google\Chrome\Application\chrome.exe" --user-data-dir="%LOCALAPPDATA%\swh-triage-chrome" --load-extension="C:\github\rimworld-claude-dev-tools\extension" "https://steamcommunity.com/login/home/"
   ```
   Steam sessions expire every few weeks; when they do, a run cleanly writes
   "not logged in" and stops — just repeat this step to refresh.

GitHub auth needs nothing extra — it reuses your `gh` CLI keyring login.

## Create / update the scheduled task

`harness/run-triage.ps1` is the runner. Hourly cadence:

```bash
schtasks /Create /TN "SteamWorkshopTriage" /SC HOURLY /MO 1 /F ^
  /TR "powershell -NoProfile -ExecutionPolicy Bypass -File \"C:\github\rimworld-claude-dev-tools\harness\run-triage.ps1\""
```

Change `/SC`/`/MO`/`/ST` for a different cadence (e.g. `/SC DAILY /ST 09:00`).
Remove it: `schtasks /Delete /TN "SteamWorkshopTriage" /F`.

## Config (env overrides)
- `ANTHROPIC_API_KEY` — required for the headless run.
- `SWH_CHROME_PATH` — path to chrome.exe (auto-detected if unset).
- `SWH_CHROME_PROFILE` — dedicated profile dir (default `%LOCALAPPDATA%\swh-triage-chrome`).

## The review loop
1. Task runs (draft only) → writes `mcp-config/triage-report.json` + a log at
   `harness/triage-last-run.log`.
2. In a Claude session: **"review the latest triage report"** — Claude walks you
   through the drafted issues/replies.
3. You approve (all or a subset) → Claude runs Phase 4 (create issues + post
   Steam replies as you) via the MCP.

## Notes
- Headless runs are limited to read-only MCP tools (`--allowedTools`), so no
  public action can happen unattended even by accident.
- The dedicated Chrome is a singleton per profile: hourly launches are a no-op if
  it's already running (no window pile-up).
- Each run consumes API-billed usage; pick a cadence that matches your comment
  volume.
