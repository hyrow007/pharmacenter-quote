# Check-Cohesion.ps1 -- the drift gate.
#
# Three things in this ecosystem are held together by whoever happens to
# remember them. All three have gone wrong already. All three are mechanical,
# which means they should be a check that runs, not a habit someone keeps:
#
#   1. SIX FILES ARE BYTE-IDENTICAL ACROSS THE TWO APP REPOS. There is no
#      shared package. Editing one from one repo breaks the OTHER repo
#      silently -- nothing fails, the copies just drift.
#
#   2. EVERY DICTIONARY KEY NEEDS AN EN AND AN ES. A key in one block and not
#      the other renders the raw key name to a Spanish-speaking operator.
#
#   3. deploy.ps1 RUNS `git add -A`. It commits the whole working tree,
#      including another chat's half-finished work, under your message. Done
#      three times: d147c18 and twice since. Nothing was lost, but the history
#      lies about who changed what.
#
# Read-only. It never writes, stages or deletes anything, so it is safe to run
# at any time, including while another chat is mid-edit.
#
# Exit codes:  0 = clean   1 = hard failure, do not deploy   2 = warning, ask
#
# Usage:
#   .\Check-Cohesion.ps1                       # standalone, any time
#   .\Check-Cohesion.ps1 -CommitMessage "..."  # how deploy.ps1 calls it

param(
    # The commit message about to be used. Supplying it turns on check 3: the
    # message's app prefix is compared against whose files are in the tree.
    [string] $CommitMessage = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = $PSScriptRoot
$repoName = Split-Path $repoRoot -Leaf
$hardFail = $false
$warn     = $false

function Write-Pass([string] $text) { Write-Host ("  PASS  " + $text) -ForegroundColor Green }
function Write-Fail([string] $text) { Write-Host ("  FAIL  " + $text) -ForegroundColor Red }
function Write-Warn([string] $text) { Write-Host ("  WARN  " + $text) -ForegroundColor Yellow }
function Write-Skip([string] $text) { Write-Host ("  SKIP  " + $text) -ForegroundColor DarkGray }

Write-Host ""
Write-Host ("Cohesion check - " + $repoName) -ForegroundColor Cyan

# ---------------------------------------------------------------------------
# 1. Shared-file parity
# ---------------------------------------------------------------------------
# The paths differ between the repos because packing puts its components under
# the (app) route group. The CONTENTS must match; the locations need not.
$quotePaths = [ordered]@{
    "freshness.ts"      = "src\lib\freshness.ts"
    "hub-href.ts"       = "src\lib\hub-href.ts"
    "app-chrome.css"    = "src\app\app-chrome.css"
    "SyncNowButton.tsx" = "src\app\_components\SyncNowButton.tsx"
    "HeaderMenu.tsx"    = "src\app\_components\HeaderMenu.tsx"
    "HubLink.tsx"       = "src\app\_components\HubLink.tsx"
}
$packingPaths = [ordered]@{
    "freshness.ts"      = "src\lib\freshness.ts"
    "hub-href.ts"       = "src\lib\hub-href.ts"
    "app-chrome.css"    = "src\app\app-chrome.css"
    "SyncNowButton.tsx" = "src\app\(app)\_components\SyncNowButton.tsx"
    "HeaderMenu.tsx"    = "src\app\(app)\_components\HeaderMenu.tsx"
    "HubLink.tsx"       = "src\app\(app)\_components\HubLink.tsx"
}

# SyncNowButton is the one documented exception: the quote repo keeps its
# strings in i18n/dict, packing in i18n/editor, and packing carries an extra
# comment block explaining exactly that. So it is compared with comment-only
# lines dropped and the two import paths folded together. Everything else is
# compared character for character, with line endings normalised because
# .gitattributes checks these out LF while PowerShell writes CRLF.
$relaxed = @("SyncNowButton.tsx")

function Get-Comparable([string] $path, [bool] $isRelaxed) {
    $text = [System.IO.File]::ReadAllText($path)
    $text = $text -replace "`r`n", "`n"
    if ($isRelaxed) {
        $kept = $text -split "`n" | Where-Object { $_.TrimStart() -notlike "//*" }
        $text = $kept -join "`n"
        $text = $text -replace "@/lib/i18n/dict", "@/lib/i18n/SHARED"
        $text = $text -replace "@/lib/i18n/editor", "@/lib/i18n/SHARED"
    }
    return $text
}

$siblingOf = @{
    "pharmacenter-quote"        = "pharmacenter-packing-list"
    "pharmacenter-packing-list" = "pharmacenter-quote"
}

Write-Host ""
Write-Host "1. Shared files, identical across both repos"

if (-not $siblingOf.ContainsKey($repoName)) {
    Write-Skip ("unrecognised repo folder '" + $repoName + "' - cannot find its sibling")
} else {
    $otherName = $siblingOf[$repoName]
    $otherRoot = Join-Path (Split-Path $repoRoot -Parent) $otherName
    if (-not (Test-Path $otherRoot)) {
        # Not a failure. A machine may legitimately have only one repo checked
        # out, and refusing to deploy over that would be worse than the drift.
        Write-Skip ("sibling repo not found at " + $otherRoot)
    } else {
        if ($repoName -eq "pharmacenter-quote") { $mine = $quotePaths; $theirs = $packingPaths }
        else                                    { $mine = $packingPaths; $theirs = $quotePaths }
        foreach ($name in $mine.Keys) {
            $a = Join-Path $repoRoot  $mine[$name]
            $b = Join-Path $otherRoot $theirs[$name]
            if (-not (Test-Path $a)) {
                Write-Fail ($name + " - missing here: " + $mine[$name]); $hardFail = $true; continue
            }
            if (-not (Test-Path $b)) {
                Write-Fail ($name + " - missing in " + $otherName + ": " + $theirs[$name]); $hardFail = $true; continue
            }
            $isRelaxed = $relaxed -contains $name
            if ((Get-Comparable $a $isRelaxed) -eq (Get-Comparable $b $isRelaxed)) {
                if ($isRelaxed) { Write-Pass ($name + " (ignoring comments and the i18n import)") }
                else            { Write-Pass $name }
            } else {
                Write-Fail ($name + " DIFFERS from " + $otherName)
                Write-Host ("        here:  " + $a) -ForegroundColor DarkGray
                Write-Host ("        there: " + $b) -ForegroundColor DarkGray
                $hardFail = $true
            }
        }
    }
}

# ---------------------------------------------------------------------------
# 2. Dictionary parity
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "2. Dictionary parity, every key in both EN and ES"

if ($repoName -eq "pharmacenter-quote") { $dictRel = "src\lib\i18n\dict.ts" }
else                                    { $dictRel = "src\lib\i18n\editor.ts" }
$dictPath = Join-Path $repoRoot $dictRel

if (-not (Test-Path $dictPath)) {
    Write-Skip ("no dictionary at " + $dictRel)
} else {
    $dict = [System.IO.File]::ReadAllText($dictPath) -replace "`r`n", "`n"
    $enMatch = [regex]::Match($dict, "(?m)^const en\s*(:[^=\n]*)?=\s*\{")
    $esMatch = [regex]::Match($dict, "(?m)^const es\s*(:[^=\n]*)?=\s*\{")
    if ((-not $enMatch.Success) -or (-not $esMatch.Success) -or ($esMatch.Index -le $enMatch.Index)) {
        # A hard failure rather than a skip: if this stops matching, the
        # dictionary was restructured and the check is now watching nothing.
        Write-Fail ("could not locate both 'const en' and 'const es' in " + $dictRel)
        $hardFail = $true
    } else {
        $enBlock = $dict.Substring($enMatch.Index, $esMatch.Index - $enMatch.Index)
        $esBlock = $dict.Substring($esMatch.Index)
        # Top-level keys only: exactly two spaces of indent inside the literal.
        $keyPattern = "(?m)^  ([A-Za-z0-9_]+)\s*:"
        $enKeys = @([regex]::Matches($enBlock, $keyPattern) | ForEach-Object { $_.Groups[1].Value })
        $esKeys = @([regex]::Matches($esBlock, $keyPattern) | ForEach-Object { $_.Groups[1].Value })
        $missingEs = @($enKeys | Where-Object { $esKeys -notcontains $_ })
        $extraEs   = @($esKeys | Where-Object { $enKeys -notcontains $_ })
        if (($missingEs.Count -eq 0) -and ($extraEs.Count -eq 0)) {
            Write-Pass ($dictRel + " - " + $enKeys.Count + " keys, EN and ES match")
        } else {
            foreach ($k in $missingEs) { Write-Fail ("missing from ES: " + $k) }
            foreach ($k in $extraEs)   { Write-Fail ("in ES but not EN: " + $k) }
            $hardFail = $true
        }
    }
}

# ---------------------------------------------------------------------------
# 3. Whose work is in the tree
# ---------------------------------------------------------------------------
# deploy.ps1 is about to run `git add -A`. This does not block it -- plenty of
# commits legitimately span apps -- it just refuses to let it happen silently.
Write-Host ""
Write-Host "3. Working tree vs the commit message"

$ErrorActionPreference = "Continue"
$statusLines = @(& git -C $repoRoot status --porcelain 2>$null)
$gitCode = $LASTEXITCODE
$ErrorActionPreference = "Stop"

if ($gitCode -ne 0) {
    Write-Skip "git status failed - skipping"
} elseif ($statusLines.Count -eq 0) {
    Write-Pass "working tree is clean"
} else {
    $changed = @()
    foreach ($line in $statusLines) {
        if ($line.Length -le 3) { continue }
        $p = $line.Substring(3).Trim()
        # Renames read "old -> new"; the destination is what matters.
        if ($p -match " -> ") { $p = ($p -split " -> ")[-1] }
        $changed += (($p.Trim('"')) -replace "\\", "/")
    }
    Write-Host ("        " + $changed.Count + " changed file(s) will be committed") -ForegroundColor DarkGray

    # Only the quote repo serves several apps out of one tree, so it is the
    # only place a foreign-app file can hide inside a commit.
    $appDirs = [ordered]@{
        "dielines" = @("src/app/dielines")
        "yields"   = @("src/app/yields", "src/app/api/yields")
        "orders"   = @("src/app/orders")
        "formula"  = @("src/app/formulas")
        "hub"      = @("src/app/hub")
        "quote"    = @("src/app/workflow", "src/app/workflows", "src/app/start", "src/app/pricing", "src/app/customer")
    }

    $prefix = ""
    if ($CommitMessage -match "^([A-Za-z0-9\-]+)\s*:") { $prefix = $Matches[1].ToLower() }

    if ($repoName -ne "pharmacenter-quote") {
        Write-Pass "single-app repo - nothing to attribute"
    } elseif (-not $prefix) {
        Write-Skip "no app prefix on the commit message - cannot attribute"
    } elseif (-not $appDirs.Contains($prefix)) {
        Write-Skip ("'" + $prefix + ":' is not an app prefix - treating as shared work")
    } else {
        $foreign = @()
        foreach ($file in $changed) {
            foreach ($owner in $appDirs.Keys) {
                if ($owner -eq $prefix) { continue }
                foreach ($dir in $appDirs[$owner]) {
                    if ($file.StartsWith($dir + "/")) { $foreign += ($owner + ":  " + $file) }
                }
            }
        }
        $foreign = @($foreign | Sort-Object -Unique)
        if ($foreign.Count -eq 0) {
            Write-Pass ("nothing outside " + $prefix + " and the shared files")
        } else {
            Write-Warn ("the tree holds files owned by another app that '" + $prefix + ":' does not name:")
            foreach ($f in $foreign) { Write-Host ("        " + $f) -ForegroundColor Yellow }
            Write-Host "        That is another chat's work. Committing it here puts it under your message." -ForegroundColor Yellow
            $warn = $true
        }
    }
}

Write-Host ""
if ($hardFail) {
    Write-Host "Cohesion check FAILED." -ForegroundColor Red
    exit 1
}
if ($warn) {
    Write-Host "Cohesion check passed with warnings." -ForegroundColor Yellow
    exit 2
}
Write-Host "Cohesion check passed." -ForegroundColor Green
exit 0
