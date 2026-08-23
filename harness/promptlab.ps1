<#
.SYNOPSIS  Universal game-free RimSynapse prompt harness: build the PromptLab console (linking each mod's pure
           composer from the workspace) and run a job through it. The harness link the `simulate_llm_prompt`
           MCP tool calls.
.DESCRIPTION
    The PromptLab console lives in THIS repo (../promptlab). Each prompt "family" <Compile>-links the PURE,
    Verse-free composer authored once in its mod (from the workspace at $RS_Root\<Mod>), so the lab builds the
    SAME prompt the game sends and reads the SAME live Core config — without launching RimWorld. It does NOT
    judge; it returns the raw response (+ composed prompt, optional family parse, metadata).

    A mod whose pure composer isn't present in the workspace simply contributes no family (its linked source +
    adapter are conditionally excluded). To test a family against a mod BRANCH/worktree before it lands in the
    workspace, set the matching *_SRC env var (e.g. CONVERSATIONS_SRC, WORLDNEWS_SRC) to that checkout.

    stdout carries ONLY the console's JSON; build/progress noise goes to stderr.
.OUTPUTS   The console's JSON (raw responses + composed prompts + metadata), or { ok:false, error } on failure.
#>
param(
    [string]$JobFile,          # path to a job JSON (required for a run)
    [switch]$Rebuild,          # force a clean rebuild
    [switch]$ListFamilies,     # print registered families + input contracts and exit
    [string]$Root              # workspace root override (passed to lib.ps1's resolver)
)

. "$PSScriptRoot\lib.ps1"

function Fail($msg, $extra) {
    $o = @{ ok = $false; error = $msg }
    if ($extra) { $o.details = $extra }
    $o | ConvertTo-Json -Depth 6 -Compress
    exit 1
}

$proj = Join-Path $PSScriptRoot '..\promptlab\PromptLab.csproj'
if (-not (Test-Path $proj)) { Fail "PromptLab.csproj not found at $proj." }
$proj = (Resolve-Path $proj).Path
$projDir = Split-Path $proj -Parent
$dll = Join-Path $projDir 'bin\Release\net8.0\PromptLab.dll'

# Build props: the workspace root, plus optional per-mod source overrides (env) so a family can be tested
# against a mod branch/worktree before it lands in the workspace.
$buildProps = @("-p:WorkspaceRoot=$RS_Root")
if ($env:CONVERSATIONS_SRC) { $buildProps += "-p:ConversationsSrc=$($env:CONVERSATIONS_SRC)" }
if ($env:WORLDNEWS_SRC)     { $buildProps += "-p:WorldNewsSrc=$($env:WORLDNEWS_SRC)" }
if ($env:PSYCHOLOGY_SRC)    { $buildProps += "-p:PsychologySrc=$($env:PSYCHOLOGY_SRC)" }

# Always build (incremental — fast when up to date) so the console reflects the current workspace and any
# edited mod composer. A clean rebuild on -Rebuild.
$target = if ($Rebuild) { 'rebuild' } else { 'build' }
RS-Log "Building PromptLab ($target) ..."
$buildOut = & dotnet $target $proj -c Release --nologo @buildProps 2>&1
if ($LASTEXITCODE -ne 0) {
    $errLines = $buildOut | Select-String -Pattern ': error ' | ForEach-Object { $_.Line.Trim() }
    Fail "PromptLab build failed (exit $LASTEXITCODE)." @{ errors = @($errLines) }
}
if (-not (Test-Path $dll)) { Fail "PromptLab built but DLL missing at $dll." }

# lib.ps1 sets ErrorActionPreference=Stop; a native command writing to stderr then becomes a terminating
# NativeCommandError. The console writes progress to stderr on purpose — relax that and drop its stderr.
$ErrorActionPreference = 'Continue'

if ($ListFamilies) {
    & dotnet $dll --list-families 2>$null
    exit $LASTEXITCODE
}
if (-not $JobFile) { Fail "No -JobFile given (and -ListFamilies not set)." }
if (-not (Test-Path $JobFile)) { Fail "JobFile not found: $JobFile" }

& dotnet $dll --job $JobFile 2>$null
exit $LASTEXITCODE
