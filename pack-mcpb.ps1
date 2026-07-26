<#
.SYNOPSIS  Package the RimSynapse MCP server as a .mcpb bundle.
.DESCRIPTION
    Compiles the TypeScript server, stages a bundle directory containing the manifest,
    the compiled JS, production node_modules and mcp-config, then zips it to .mcpb.

    Bundle layout (entry_point = server/index.js):
        manifest.json
        mcp-config/config.json
        server/index.js + tools/ + node_modules/
.EXAMPLE   .\pack-mcpb.ps1
#>
param(
    [string]$OutFile = "$PSScriptRoot\rimsynapse-mcp.mcpb"
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

# 2. Compiled server (build/* flattened into server/ so entry is server/index.js)
Copy-Item (Join-Path $server 'build\*') (Join-Path $stage 'server') -Recurse -Force

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

Write-Host "[pack] Zipping to $OutFile"
if (Test-Path $OutFile) { Remove-Item $OutFile -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath "$OutFile.zip" -Force
Move-Item "$OutFile.zip" $OutFile -Force

Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue

$size = [math]::Round((Get-Item $OutFile).Length / 1MB, 2)
Write-Host "[pack] Done: $OutFile ($size MB)"
