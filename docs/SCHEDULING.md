# Scheduling the comment-triage routine

The routine drives your **logged-in Chrome** through the extension and the MCP's
`127.0.0.1` loopback bridge, so it **must run on this machine** — a cloud
routine can't reach your browser. Use a local schedule (Windows Task Scheduler).

It runs in **draft mode**: each run writes `mcp-config/triage-report.json`
and creates/posts nothing. You review and approve interactively afterward.

## Preconditions at run time
- Chrome open, Steam Workshop Helper extension loaded, **logged into Steam**.
- `steam-workshop-helper` MCP registered (user scope) and `GITHUB_TOKEN` set.
- If Chrome is closed at run time, the run just records that and stops — no harm.

## Create the scheduled task

`harness/run-triage.ps1` is the runner. Register it with Task Scheduler.
The configured cadence is **hourly**:

```bash
schtasks /Create /TN "SteamWorkshopTriage" /SC HOURLY /MO 1 /F ^
  /TR "powershell -NoProfile -ExecutionPolicy Bypass -File \"C:\github\archdukejim\steam-workshop-helper\mcp\harness\run-triage.ps1\""
```

Change `/SC`/`/MO`/`/ST` for a different cadence (e.g. `/SC DAILY /ST 09:00`).

Remove it later:
```bash
schtasks /Delete /TN "SteamWorkshopTriage" /F
```

## The review loop
1. Task runs (draft only) → writes `triage-report.json` + a log at
   `harness/triage-last-run.log`.
2. In a Claude session: **"review the latest triage report"** — Claude reads the
   report and walks you through the drafted issues/replies.
3. You approve (all, or a subset) → Claude runs Phase 4 (create issues + post
   Steam replies as you) via the MCP.

## Notes
- Headless runs use only the read-only MCP tools (`--allowedTools`), so no
  public action can happen unattended even by accident.
- The task consumes Claude usage on each run; pick a cadence that matches how
  often you actually get comments.
