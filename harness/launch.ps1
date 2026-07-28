<#
.SYNOPSIS  Launch RimWorld for a test run, then stop it, so readlog.ps1 can scrape Player.log.
.DESCRIPTION
    Unity truncates Player.log on each start, so we record the pre-launch byte length as a
    marker and read from it afterward (readlog falls back to offset 0 if the file was truncated).
    Smoke mode: launch, wait -BootWaitSec for mods to load, then kill.
    Test mode (-Test): pass -synapse-test; the in-game TestRunner runs cases and calls
    Root.Shutdown(), so we wait up to -TimeoutSec for a clean exit (kill if it overruns).
.EXAMPLE   .\launch.ps1                       # smoke: load mods, then kill
.EXAMPLE   .\launch.ps1 -Test -TimeoutSec 300 # functional: run TestRunner, wait for auto-quit
.OUTPUTS   JSON: { ok, mode, exited, killed, timedOut, elapsedSec }
#>
param(
    [switch]$Test,
    [int]$BootWaitSec = 90,     # smoke: how long to let mods load before killing (Intel iGPU = slow)
    [int]$TimeoutSec  = 300     # test: max wait for TestRunner auto-quit
)
. "$PSScriptRoot\lib.ps1"

if (-not (Test-Path $RS_GameExe)) { Write-Error "RimWorld exe not found: $RS_GameExe"; exit 2 }

# Kill any stale instance so this run owns the log.
Get-Process -Name 'RimWorldWin64' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

# Rotate the previous log out of the way so everything we read belongs to this run.
# Without this, polling for [SYNAPSE-TEST] SUMMARY can match the previous run's results
# in the window before Unity truncates the file. Falls back to a byte marker if the
# file is locked.
$marker = 0
if (Test-Path $RS_PlayerLog) {
    $prev = Join-Path (Split-Path -Parent $RS_PlayerLog) 'Player.prev.log'
    try {
        Move-Item -Path $RS_PlayerLog -Destination $prev -Force -ErrorAction Stop
        RS-Log "Rotated previous log to Player.prev.log"
    } catch {
        $marker = (Get-Item $RS_PlayerLog).Length
        RS-Log "Could not rotate log (in use); falling back to byte marker $marker"
    }
}
Set-Content -Path $RS_Marker -Value $marker -NoNewline

$args = @('-quicktest')
if ($Test) { $args += '-synapse-test' }

RS-Log "Launching: RimWorldWin64.exe $($args -join ' ')"
$proc = Start-Process -FilePath $RS_GameExe -ArgumentList $args -PassThru
$sw = [System.Diagnostics.Stopwatch]::StartNew()

$exited = $false; $killed = $false; $timedOut = $false; $sawSummary = $false
if ($Test) {
    # Don't rely on the game exiting by itself: a mod throwing every frame can wedge
    # Root.Shutdown(). Poll the log for the TestRunner's SUMMARY line and stop the game
    # once results are in, falling back to the timeout if it never appears.
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if ($proc.HasExited) { $exited = $true; break }
        if (Test-Path $RS_PlayerLog) {
            try {
                $tail = Get-Content $RS_PlayerLog -Tail 200 -ErrorAction SilentlyContinue
                if ($tail -match '\[SYNAPSE-TEST\] SUMMARY') {
                    $sawSummary = $true
                    RS-Log "TestRunner reported SUMMARY; allowing 10s for clean shutdown."
                    if ($proc.WaitForExit(10000)) { $exited = $true }
                    else { $proc | Stop-Process -Force -ErrorAction SilentlyContinue; $killed = $true }
                    break
                }
            } catch { }
        }
        Start-Sleep -Milliseconds 1000
    }
    if (-not $exited -and -not $killed) {
        $timedOut = $true
        $proc | Stop-Process -Force -ErrorAction SilentlyContinue
        $killed = $true
    }
} else {
    if ($proc.WaitForExit($BootWaitSec * 1000)) { $exited = $true }  # crashed during load
    else { $proc | Stop-Process -Force -ErrorAction SilentlyContinue; $killed = $true }
}
$sw.Stop()
Get-Process -Name 'RimWorldWin64' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# ok was hardcoded $true here, which made every launch look successful no matter how it
# ended. A run whose game exited before the TestRunner printed SUMMARY reported ok with
# sawSummary=$false sitting right beside it, and the caller believed the ok.
#
# In test mode the SUMMARY line is the only evidence the suite ran to completion, so it is
# the condition. In smoke mode the game is expected to still be alive when we stop it;
# having exited on its own means it died during load.
$reason = $null
if ($Test) {
    if (-not $sawSummary) {
        $reason = if ($timedOut)   { "timed out after ${TimeoutSec}s without a SUMMARY line" }
                  elseif ($exited) { "game exited before the TestRunner printed SUMMARY" }
                  else             { "no SUMMARY line seen" }
    }
} elseif ($exited) {
    $reason = "game exited during load (crash on boot)"
}
$launchOk = ($null -eq $reason)
if ($reason) { RS-Log "Launch not ok: $reason" }

RS-Json @{ ok=$launchOk; reason=$reason; mode=$(if($Test){'test'}else{'smoke'}); exited=$exited; killed=$killed; timedOut=$timedOut; sawSummary=$sawSummary; elapsedSec=[math]::Round($sw.Elapsed.TotalSeconds,1) }
