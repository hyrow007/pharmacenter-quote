# One-shot deploy for the PharmaCenter Quote app (and the formula,
# meeting and order subdomains it serves).
#
# Usage from PowerShell:
#   .\deploy.ps1 "gummy formula calculator: fix scaling"
#   .\deploy.ps1                 # prompts, rather than reusing a stale message
#
# Mirrors the packing list's deploy.ps1 so both repos deploy the same
# way. The extra first step exists because this app is edited in C:\q
# and the git checkout is a copy of it.
#
# Replaces push-now.bat, which had its commit message hardcoded in the
# file -- that is why eight consecutive commits all read
# "workflow: gummy formula calculator (Bulk -> Gummy -> PC)".

param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $Message,

    # Also delete files from the repo that no longer exist in C:\q.
    # OFF by default: the mirror has always been copy-only, so the repo
    # may hold files (legacy/, CLAUDE.md, README) that never lived in
    # the source. Run with -WhatIfPurge first to see what would go.
    [switch] $Purge,
    [switch] $WhatIfPurge
)

$ErrorActionPreference = "Stop"

$SRC  = "C:\q"
$REPO = "C:\code\pharmacenter-quote"

# Kept identical to what the old watcher and push-now.bat used.
$XD = @(".git", "node_modules", ".next", "assets", "push-to-github")
$XF = @("push-quote.bat", "push-now.bat", "init-git.ps1", ".DS_Store",
        "qg-app.jsx", "qg-editor.jsx", "qg-sheet.jsx",
        "quote.css", "generator.html")

if (-not (Test-Path $SRC))              { Write-Error "Source $SRC not found - is the C:\q junction present?"; exit 1 }
if (-not (Test-Path "$REPO\.git"))      { Write-Error "No git repo at $REPO"; exit 1 }

$msg = if ($Message) { $Message -join " " } else { Read-Host "Commit message" }
if (-not $msg) { Write-Error "A commit message is required."; exit 1 }

# ---- 1. copy C:\q into the checkout ---------------------------------
$args = @($SRC, $REPO, "/E", "/NFL", "/NDL", "/NP", "/NJH", "/NJS")
foreach ($d in $XD) { $args += @("/XD", $d) }
foreach ($f in $XF) { $args += @("/XF", $f) }
& robocopy @args | Out-Null
if ($LASTEXITCODE -ge 8) { Write-Error "robocopy failed with $LASTEXITCODE"; exit 1 }

# ---- 2. surface anything the copy-only mirror can never remove ------
# /E copies but never deletes, so a file deleted in C:\q lingers in the
# repo and keeps deploying. Report those instead of hiding them.
$extraArgs = @($SRC, $REPO, "/E", "/L", "/NJH", "/NJS", "/NP", "/FP", "/NS", "/NC", "/NDL")
foreach ($d in $XD) { $extraArgs += @("/XD", $d) }
foreach ($f in $XF) { $extraArgs += @("/XF", $f) }
$extras = & robocopy @extraArgs | Select-String -SimpleMatch "*EXTRA File" |
          ForEach-Object { ($_ -split "\s{2,}")[-1].Trim() } | Where-Object { $_ }

if ($extras) {
    Write-Host ""
    Write-Host "In the repo but no longer in $SRC ($($extras.Count)):" -ForegroundColor Yellow
    $extras | ForEach-Object { Write-Host "    $_" }
    if ($WhatIfPurge) { Write-Host "`n-WhatIfPurge: nothing deleted." -ForegroundColor Cyan; exit 0 }
    if ($Purge) {
        $extras | ForEach-Object { Remove-Item -LiteralPath $_ -Force -ErrorAction SilentlyContinue }
        Write-Host "Purged." -ForegroundColor Yellow
    } else {
        Write-Host "  (left in place - re-run with -Purge to remove them)" -ForegroundColor DarkGray
    }
}
if ($WhatIfPurge) { Write-Host "Nothing stale to purge." -ForegroundColor Green; exit 0 }

# ---- 3. commit and push ---------------------------------------------
Push-Location $REPO
try {
    git add -A
    $staged = git diff --cached --name-only
    if (-not $staged) { Write-Host "Nothing to commit." -ForegroundColor Yellow; exit 0 }

    Write-Host ""
    Write-Host "Deploying $(@($staged).Count) file(s):" -ForegroundColor Cyan
    $staged | Select-Object -First 20 | ForEach-Object { Write-Host "    $_" }
    if (@($staged).Count -gt 20) { Write-Host "    ... and $(@($staged).Count - 20) more" }

    git commit -m $msg
    git pull --rebase origin main
    git push

    Write-Host ""
    Write-Host "Pushed. Vercel is rebuilding - give it ~60s." -ForegroundColor Green
} finally {
    Pop-Location
}
