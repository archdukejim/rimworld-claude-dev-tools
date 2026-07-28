<#
.SYNOPSIS  Package the RimSynapse MCP server as a .mcpb bundle.
.DESCRIPTION
    Compiles the TypeScript server, stages a bundle directory containing the manifest,
    the compiled JS, production node_modules and mcp-config, then zips it to .mcpb.

    Bundle layout (entry_point = server/index.js):
        manifest.json
        mcp-config/config.json
        server/index.js + tools/ + node_modules/

    The staged bundle is verified before it is zipped: every dependency declared in
    server/package.json must resolve from the bundle, and the packed server must complete an MCP
    handshake and list its tools. A bundle that ships without a dependency it requires at startup
    looks fine on disk and fails at install time with MODULE_NOT_FOUND, which is exactly what these
    gates exist to catch - that shipped once and cost a release.
.EXAMPLE   .\pack-mcpb.ps1
.EXAMPLE   .\pack-mcpb.ps1 -SkipVerify   # pack without the gates (not recommended)
#>
param(
    [string]$OutFile = "$PSScriptRoot\rimsynapse-mcp.mcpb",
    [switch]$SkipVerify
)
$ErrorActionPreference = 'Stop'

# Node is often installed after a shell starts, so refresh PATH from the registry.
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')

$server = Join-Path $PSScriptRoot 'server'
$stage  = Join-Path $env:TEMP ("mcpb-stage-" + [guid]::NewGuid().ToString('N'))

Write-Host "[pack] Compiling TypeScript..."
Push-Location $server
try {
    & npm install --no-audit --no-fund --silent
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "tsc build failed" }
} finally { Pop-Location }

if (-not (Test-Path (Join-Path $server 'build\index.js'))) { throw "build/index.js missing after compile" }

Write-Host "[pack] Staging bundle at $stage"
New-Item -ItemType Directory -Path $stage -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stage 'server') -Force | Out-Null

# 1. Manifest
Copy-Item (Join-Path $PSScriptRoot 'manifest.json') $stage

# 2. Compiled server. Only what the entry point actually reaches: src/ also holds a pile of one-off
#    maintenance scripts (migrate, push_epics, assign_teams, test_*) that compile into build/ and
#    have no business inside a shipped extension. The load test below proves the list is complete.
$serverFiles = @('index.js', 'config.js')
foreach ($f in $serverFiles) {
    $src = Join-Path $server "build\$f"
    if (-not (Test-Path $src)) { throw "expected compiled file missing: build\$f" }
    Copy-Item $src (Join-Path $stage 'server')
}
Copy-Item (Join-Path $server 'build\tools') (Join-Path $stage 'server') -Recurse -Force

# 3. mcp-config (loadConfig checks ../mcp-config from the server dir)
if (Test-Path (Join-Path $PSScriptRoot 'mcp-config')) {
    Copy-Item (Join-Path $PSScriptRoot 'mcp-config') $stage -Recurse -Force
}

# 3b. PowerShell harness (the rimworld tools shell out to these)
if (Test-Path (Join-Path $PSScriptRoot 'harness')) {
    Copy-Item (Join-Path $PSScriptRoot 'harness') $stage -Recurse -Force
    Remove-Item (Join-Path $stage 'harness\.logmarker') -Force -ErrorAction SilentlyContinue
}

# 4. Production dependencies, installed clean into the bundle
Write-Host "[pack] Installing production dependencies into bundle..."
$pkg = Get-Content (Join-Path $server 'package.json') -Raw | ConvertFrom-Json
$bundlePkg = [ordered]@{
    name         = 'rimsynapse-mcp'
    version      = $pkg.version
    private      = $true
    type         = $pkg.type
    main         = 'server/index.js'
    dependencies = $pkg.dependencies
}
$bundlePkg | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $stage 'package.json') -Encoding utf8

Push-Location $stage
try {
    & npm install --omit=dev --no-audit --no-fund --silent --prefix $stage
    if ($LASTEXITCODE -ne 0) { throw "production npm install failed" }
} finally { Pop-Location }

# node resolution walks upward from server/index.js, so bundle-root node_modules works;
# move it under server/ as well for clients that extract only that subtree.
if (Test-Path (Join-Path $stage 'node_modules')) {
    Move-Item (Join-Path $stage 'node_modules') (Join-Path $stage 'server\node_modules') -Force
}

if (-not $SkipVerify) {
    # --- Gate 1: every declared dependency resolves from inside the bundle ---
    Write-Host "[pack] Verifying declared dependencies are present..."
    $declared = $pkg.dependencies.PSObject.Properties.Name
    $missing = @()
    foreach ($dep in $declared) {
        if (-not (Test-Path (Join-Path $stage "server\node_modules\$dep\package.json"))) {
            $missing += $dep
        }
    }
    if ($missing.Count -gt 0) {
        Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
        throw "bundle is missing declared dependencies: $($missing -join ', ')"
    }
    Write-Host "[pack]   all $($declared.Count) declared dependencies present"

    # --- Gate 2: the packed server actually starts and lists its tools ---
    Write-Host "[pack] Verifying the packed server completes an MCP handshake..."
    $probe = Join-Path $stage '_verify.js'
    @'
const { spawn } = require("child_process");
const path = require("path");
const entry = path.join(__dirname, "server", "index.js");
const child = spawn(process.execPath, [entry], { cwd: path.dirname(entry), stdio: ["pipe","pipe","pipe"] });
let out = "", err = "";
child.stdout.on("data", d => out += d);
child.stderr.on("data", d => err += d);
const send = m => child.stdin.write(JSON.stringify(m) + "\n");
send({ jsonrpc:"2.0", id:1, method:"initialize", params:{ protocolVersion:"2024-11-05", capabilities:{}, clientInfo:{name:"pack-verify",version:"1.0.0"} }});
setTimeout(() => send({ jsonrpc:"2.0", id:2, method:"tools/list", params:{} }), 600);
setTimeout(() => {
  child.kill();
  const msgs = out.split("\n").filter(l => l.trim().startsWith("{")).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean);
  const init = msgs.find(m => m.id === 1), list = msgs.find(m => m.id === 2);
  if (!init || init.error) { console.error("handshake failed.\n" + err); process.exit(1); }
  if (!list || list.error) { console.error("tools/list failed.\n" + err); process.exit(1); }
  console.log(String((list.result.tools || []).length));
  process.exit(0);
}, 3500);
'@ | Set-Content $probe -Encoding utf8

    $toolCount = & node $probe
    $probeExit = $LASTEXITCODE
    Remove-Item $probe -Force -ErrorAction SilentlyContinue

    if ($probeExit -ne 0) {
        Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
        throw "the packed server failed to start - refusing to ship this bundle"
    }

    # --- Gate 3: the manifest tool list matches what the server registers ---
    $manifest = Get-Content (Join-Path $stage 'manifest.json') -Raw | ConvertFrom-Json
    $declaredTools = $manifest.tools.Count
    if ([int]$toolCount -ne [int]$declaredTools) {
        Write-Warning "manifest declares $declaredTools tools but the server registers $toolCount. Re-sync manifest.json."
    }
    Write-Host "[pack]   server started and registered $toolCount tools"
}

Write-Host "[pack] Zipping to $OutFile"
if (Test-Path $OutFile) { Remove-Item $OutFile -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath "$OutFile.zip" -Force
Move-Item "$OutFile.zip" $OutFile -Force

Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue

$size = [math]::Round((Get-Item $OutFile).Length / 1MB, 2)
Write-Host "[pack] Done: $OutFile ($size MB)"
