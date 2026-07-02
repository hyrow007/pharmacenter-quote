# auto-push.ps1  —  pharmacenter-quote auto-push watcher
# -----------------------------------------------------------------------------
# Polls C:\q every 4 seconds; when files under it change relative to the git
# checkout at C:\code\pharmacenter-quote, waits for a 12-second quiet period
# (so we don't commit mid-save), then robocopies the mount into the checkout,
# commits, and pushes to origin/main.
#
# Designed to run in the background — install via install-auto-push.ps1 which
# registers it as a scheduled task that fires at logon.
#
# Behavior:
#   * Every 4 s: quick check for changes (git status inside the repo after a
#     lazy robocopy /L — dry-run mirror — so we don't touch the repo until we
#     know something moved).
#   * When changes appear, start a 12-second debounce window.
#   * If more changes arrive during the window, extend it (typical editor save
#     patterns write partial files then finalize — we want the finalized state).
#   * Once 12 s of quiet, do the real robocopy + git add/commit/pull --rebase
#     /push cycle.
#
# Log:   %USERPROFILE%\.pharmacenter-quote-auto-push.log
# Config below — tweak SRC, REPO, or the timings without redeploying.
# -----------------------------------------------------------------------------

$ErrorActionPreference = 'Continue'   # Never let a transient hiccup kill the watcher.

$SRC       = 'C:\q'
$REPO      = 'C:\code\pharmacenter-quote'
$LOG       = Join-Path $env:USERPROFILE '.pharmacenter-quote-auto-push.log'
$POLL_SEC  = 4
$QUIET_SEC = 12

# robocopy exclusions — everything we DON'T want mirrored into the git repo.
# Kept in sync with push-quote.bat so the two are interchangeable.
$XD = @('.git', 'node_modules', '.next', 'assets', 'push-to-github')
$XF = @(
    'push-quote.bat', 'init-git.ps1', '.DS_Store',
    'qg-app.jsx', 'qg-editor.jsx', 'qg-sheet.jsx',
    'quote.css', 'generator.html'
)

function Write-Log([string]$msg) {
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg"
    Add-Content -Path $LOG -Value $line -ErrorAction SilentlyContinue
}

function Test-SourceHasChanges {
    # Robocopy dry-run (/L) prints how many files WOULD change. Exit code < 8
    # means it ran cleanly; presence of "Newer", "Extra", or non-zero Copied /
    # Mismatched counts means we have work to do.
    $robocopyArgs = @(
        $SRC, "$REPO\.robocopy-dry", '/E', '/L', '/NFL', '/NDL', '/NP', '/NJH', '/NS', '/NC'
    )
    foreach ($d in $XD) { $robocopyArgs += @('/XD', $d) }
    foreach ($f in $XF) { $robocopyArgs += @('/XF', $f) }
    $out = & robocopy @robocopyArgs 2>&1 | Out-String
    $rc = $LASTEXITCODE
    if ($rc -ge 8) {
        Write-Log "robocopy dry-run failed with $rc — assuming no changes"
        return $false
    }
    # Look for any non-zero "Copied", "Mismatch", or "Extras" counts.
    return ($out -match 'Copied\s*:\s*[1-9]' -or
            $out -match 'Mismatch\s*:\s*[1-9]' -or
            $out -match 'Extras\s*:\s*[1-9]')
}

function Invoke-SyncAndPush {
    Write-Log "starting sync"

    # Real mirror. Exit codes 0–7 are success; 8+ is failure.
    $robocopyArgs = @($SRC, $REPO, '/E', '/NFL', '/NDL', '/NP')
    foreach ($d in $XD) { $robocopyArgs += @('/XD', $d) }
    foreach ($f in $XF) { $robocopyArgs += @('/XF', $f) }
    & robocopy @robocopyArgs *> $null
    if ($LASTEXITCODE -ge 8) {
        Write-Log "robocopy failed with $LASTEXITCODE — skipping git"
        return
    }

    Push-Location $REPO
    try {
        # Nothing to commit? Bail early.
        $status = & git status --porcelain 2>&1
        if (-not $status) {
            Write-Log "no diff after mirror — noop"
            return
        }

        & git add -A 2>&1 | Out-Null
        # Count changed files for the commit message.
        $count = ($status | Measure-Object).Count
        $msg = "auto: sync $count file(s) from Cowork mount"
        & git commit -m $msg 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Log "commit failed (nothing to commit or hook fail)"
            return
        }
        # Rebase over any hand-pushed commits (e.g. someone edited via GitHub UI).
        & git pull --rebase origin main 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Log "pull --rebase failed — leaving commit local"
            return
        }
        & git push 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Log "push failed — will retry on next cycle"
            return
        }
        Write-Log "pushed: $msg"
    } finally {
        Pop-Location
    }
}

# --- Main loop ---------------------------------------------------------------

Write-Log "watcher started (SRC=$SRC, REPO=$REPO, POLL=${POLL_SEC}s, QUIET=${QUIET_SEC}s)"

if (-not (Test-Path $SRC)) {
    Write-Log "FATAL: source path $SRC does not exist — is the C:\q junction present?"
    exit 1
}
if (-not (Test-Path (Join-Path $REPO '.git'))) {
    Write-Log "FATAL: $REPO is not a git checkout — clone the repo first"
    exit 1
}

$lastChange = $null
while ($true) {
    try {
        $hasChanges = Test-SourceHasChanges
        if ($hasChanges) {
            $lastChange = Get-Date
        }
        if ($lastChange -and ((Get-Date) - $lastChange).TotalSeconds -ge $QUIET_SEC) {
            Invoke-SyncAndPush
            $lastChange = $null
        }
    } catch {
        Write-Log "loop iteration errored: $($_.Exception.Message)"
    }
    Start-Sleep -Seconds $POLL_SEC
}
