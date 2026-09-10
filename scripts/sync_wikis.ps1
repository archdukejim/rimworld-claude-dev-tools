param (
    [string]$TokenFile = "github_token.txt",
    [string]$OrgName = "RimSynapse"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $TokenFile)) {
    Write-Error "Token file '$TokenFile' not found. Please ensure it exists."
    exit 1
}

# Parse the config file
$token = $null
$wikiUrls = @{}
$inWikisSection = $false

foreach ($line in Get-Content $TokenFile) {
    $line = $line.Trim()
    if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith("#")) { continue }

    if ($line -eq "[Wikis]") {
        $inWikisSection = $true
        continue
    } elseif ($line.StartsWith("[")) {
        $inWikisSection = $false
        continue
    }

    if ($line.StartsWith("TOKEN=")) {
        $token = $line.Substring(6).Trim()
    } elseif ($inWikisSection -and $line.Contains("=")) {
        $parts = $line.Split("=", 2)
        $wikiUrls[$parts[0].Trim()] = $parts[1].Trim()
    }
}

if (-not $token) {
    Write-Error "Valid GitHub token (TOKEN=...) not found in '$TokenFile'."
    exit 1
}

$baseDir = Get-Location
$parentDir = Split-Path $baseDir -Parent
# Any sibling folder that is a mod checkout (About\About.xml) — not just RimSynapse-* names.
$repoDirs = Get-ChildItem -Path $parentDir -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'About\About.xml') }

foreach ($dir in $repoDirs) {
    $repoName = $dir.Name
    Write-Host "==============================================" -ForegroundColor Cyan
    Write-Host "Syncing Wiki for $repoName..." -ForegroundColor Cyan

    # A [Wikis] entry in the token file wins; otherwise the wiki lives beside the repo's own
    # origin remote (<owner>/<repo>.wiki.git), whichever org that is. $OrgName is the last resort.
    $configuredUrl = $null
    if ($wikiUrls.ContainsKey($repoName)) {
        $configuredUrl = $wikiUrls[$repoName]
    } else {
        $originUrl = git -C $dir.FullName remote get-url origin 2>$null
        if ($originUrl -match 'github\.com[:/]([^/]+/[^/]+?)(\.git)?/?$') {
            $configuredUrl = "https://github.com/$($Matches[1]).wiki.git"
        } elseif ($OrgName) {
            $configuredUrl = "https://github.com/$OrgName/$repoName.wiki.git"
        }
    }
    if (-not $configuredUrl) {
        Write-Warning "No wiki URL for $repoName (no [Wikis] entry, no GitHub origin). Skipping."
        continue
    }

    # Inject the token into the configured URL for authentication
    $wikiUrl = $configuredUrl -replace "https://", "https://${token}@"
    
    $tempDir = Join-Path $baseDir "wiki_temp_$repoName"
    
    # Cleanup any previous interrupted run
    if (Test-Path $tempDir) {
        Remove-Item -Path $tempDir -Recurse -Force
    }

    try {
        Write-Host "Cloning $repoName wiki..."
        $env:GIT_TERMINAL_PROMPT = 0
        git clone $wikiUrl $tempDir -q
        
        if (Test-Path $tempDir) {
            Write-Host "Copying files to wiki repo..."
            $learningPath = Join-Path $dir.FullName "Learning"
            if (Test-Path $learningPath) {
                Copy-Item -Path "$learningPath\*" -Destination $tempDir -Recurse -Force -ErrorAction SilentlyContinue
            }
            
            # --- Homepage Generation ---
            $siblingRepoPath = $dir.FullName
            $aboutXmlPath = Join-Path $siblingRepoPath "About\About.xml"
            
            if (Test-Path $aboutXmlPath) {
                Write-Host "Generating Home.md from About.xml..."
                [xml]$aboutXml = Get-Content $aboutXmlPath -Raw -Encoding UTF8
                $modName = $aboutXml.ModMetaData.name
                $modDesc = $aboutXml.ModMetaData.description
                
                if ([string]::IsNullOrWhiteSpace($modDesc)) {
                    $modDesc = "Welcome to the $modName wiki!"
                } else {
                    # Simple Steam formatting to Markdown converter
                    $modDesc = $modDesc -replace '\[h1\](.*?)\[/h1\]', '# $1'
                    $modDesc = $modDesc -replace '\[h2\](.*?)\[/h2\]', '## $1'
                    $modDesc = $modDesc -replace '\[h3\](.*?)\[/h3\]', '### $1'
                    $modDesc = $modDesc -replace '\[b\](.*?)\[/b\]', '**$1**'
                    $modDesc = $modDesc -replace '\[i\](.*?)\[/i\]', '*$1*'
                    $modDesc = $modDesc -replace '\[list\]', ''
                    $modDesc = $modDesc -replace '\[/list\]', ''
                    $modDesc = $modDesc -replace '\[\*\]', '-'
                    $modDesc = $modDesc -replace '\[url=(.*?)\](.*?)\[/url\]', '[$2]($1)'
                }
                
                $homeContent = "# $modName`n`n## Table of Contents`n"
                
                $mdFiles = Get-ChildItem -Path $tempDir -Filter "*.md" | Where-Object { $_.Name -ne "Home.md" }
                if ($mdFiles.Count -gt 0) {
                    foreach ($file in $mdFiles) {
                        $pageName = $file.BaseName
                        $displayText = $pageName -replace '_', ' '
                        $homeContent += "- [$displayText]($pageName)`n"
                    }
                } else {
                    $homeContent += "*No additional documentation pages have been uploaded yet.*`n"
                }
                
                $homeContent += "`n## About $modName`n`n$modDesc`n"
                
                $homePath = Join-Path $tempDir "Home.md"
                Set-Content -Path $homePath -Value $homeContent -Encoding UTF8
            }
            # ---------------------------
            
            Push-Location $tempDir
            
            git config user.name "Wiki Sync Script"
            git config user.email "sync@rimsynapse.local"
            
            git add .
            
            # Check if there are changes to commit
            $status = git status --porcelain
            if ([string]::IsNullOrWhiteSpace($status)) {
                Write-Host "No changes to commit for $repoName. Wiki is up to date." -ForegroundColor Yellow
            } else {
                git commit -m "Automated wiki sync for $repoName" | Out-Null
                Write-Host "Pushing changes to GitHub..."
                git push | Out-Null
                Write-Host "Successfully synced $repoName!" -ForegroundColor Green
            }
            
            Pop-Location
        } else {
            Write-Warning "Failed to clone $repoName wiki. Ensure it has been initialized with a first page on GitHub."
        }
    } catch {
        Write-Error "An error occurred while syncing $repoName : $_"
    } finally {
        # Cleanup
        if (Test-Path $tempDir) {
            # Make sure we're definitely out of the directory before trying to delete it
            if ((Get-Location).Path -eq $tempDir) {
                Pop-Location -ErrorAction SilentlyContinue
                Set-Location $baseDir
            }
            Start-Sleep -Seconds 1
            Remove-Item -Path $tempDir -Recurse -Force
        }
    }
}

Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "Sync process complete!" -ForegroundColor Cyan
