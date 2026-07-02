# install-auto-push.ps1  —  one-shot installer for the pharmacenter-quote
# auto-push watcher. Run this ONCE from an elevated PowerShell (Run as
# Administrator not required for scheduled task creation targeting your own
# user, but the script needs write access to C:\ for the junction).
#
# What it does:
#   1. Deletes any stale C:\q junction (points at a previous Cowork session).
#   2. Recreates C:\q → the current Cowork quote/ mount folder passed in via
#      -MountPath, which becomes the source Truth for Claude's edits.
#   3. Copies auto-push.ps1 into C:\pharmacenter-quote-scripts\ so it's
#      independent of the Cowork mount (which changes between sessions).
#   4. Registers a Scheduled Task ("PharmaCenter-Quote-AutoPush") that starts
#      the watcher at logon, in the background, hidden window, restart on fail.
#   5. Kicks off the watcher immediately so you don't have to log out/in.
#
# Usage (from PowerShell):
#   .\install-auto-push.ps1 -MountPath "<full-path-to-this-folder-on-your-machine>"
#
# The MountPath you want is wherever the Cowork app has THIS quote/ folder
# mounted right now. On Windows that's typically under:
#   C:\Users\<you>\AppData\Local\Packages\Claude_*\LocalCache\Roaming\Claude\
#       local-agent-mode-sessions\<session-id>\...\outputs\packing-list\quote
#
# If Claude tells you a specific path in chat, paste that.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$MountPath,

    # These are stable — override only if your setup diverges.
    [string]$JunctionPath  = 'C:\q',
    [string]$RepoPath      = 'C:\code\pharmacenter-quote',
    [string]$ScriptsDir    = 'C:\pharmacenter-quote-scripts',
    [string]$TaskName      = 'PharmaCenter-Quote-AutoPush'
)

$ErrorActionPreference = 'Stop'

function Say([string]$msg) { Write-Host "  $msg" -ForegroundColor Cyan }
function Ok([string]$msg)  { Write-Host "  $msg" -ForegroundColor Green }
function Warn([string]$msg){ Write-Host "  $msg" -ForegroundColor Yellow }

Write-Host ""
Write-Host "=== PharmaCenter-Quote Auto-Push Installer ===" -ForegroundColor White
Write-Host ""

# --- 1. Validate inputs ------------------------------------------------------
if (-not (Test-Path $MountPath)) {
    throw "MountPath does not exist: $MountPath"
}
if (-not (Test-Path (Join-Path $RepoPath '.git'))) {
    throw "RepoPath is not a git checkout: $RepoPath  (run init-git.ps1 first)"
}

# --- 2. Refresh the C:\q junction --------------------------------------------
Say "Refreshing junction $JunctionPath -> $MountPath"
if (Test-Path $JunctionPath) {
    # cmd's `rmdir /Q` deletes junctions cleanly without recursing into the
    # target (which is what happens if you Remove-Item -Recurse on a junction).
    cmd /c "rmdir /Q `"$JunctionPath`""
}
cmd /c "mklink /J `"$JunctionPath`" `"$MountPath`"" | Out-Null
if (-not (Test-Path $JunctionPath)) {
    throw "Failed to create junction $JunctionPath"
}
Ok "junction is ready"

# --- 3. Stage the watcher script outside the Cowork mount --------------------
# We want the watcher to keep running even after Claude's session ends and the
# Cowork mount goes away. So we copy the watcher into a stable path.
Say "Staging watcher at $ScriptsDir\auto-push.ps1"
New-Item -ItemType Directory -Force -Path $ScriptsDir | Out-Null
$srcWatcher = Join-Path $PSScriptRoot 'auto-push.ps1'
if (-not (Test-Path $srcWatcher)) {
    throw "Can't find $srcWatcher — run this installer from the scripts/ folder next to auto-push.ps1"
}
Copy-Item -Force $srcWatcher (Join-Path $ScriptsDir 'auto-push.ps1')
Ok "watcher staged"

# --- 4. Register the Scheduled Task -----------------------------------------
Say "Registering scheduled task '$TaskName' (runs at logon, restarts on failure)"

# Kill any prior version of the task first so re-running the installer is
# idempotent.
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Say "  removed prior task"
}

$powershell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$watcher    = Join-Path $ScriptsDir 'auto-push.ps1'
$action     = New-ScheduledTaskAction `
                -Execute $powershell `
                -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$watcher`""
$trigger    = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings   = New-ScheduledTaskSettingsSet `
                -AllowStartIfOnBatteries `
                -DontStopIfGoingOnBatteries `
                -StartWhenAvailable `
                -Hidden `
                -RestartCount 999 `
                -RestartInterval (New-TimeSpan -Minutes 1)
$principal  = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Watches C:\q and auto-pushes changes to pharmacenter-quote's main branch." `
    | Out-Null
Ok "scheduled task registered"

# --- 5. Kick it off immediately ---------------------------------------------
Say "Starting watcher now (no need to log out / in)"
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 2
$state = (Get-ScheduledTask -TaskName $TaskName).State
Ok "task state: $state"

Write-Host ""
Write-Host "=== Done ===" -ForegroundColor White
Write-Host ""
Write-Host "  Any file Claude saves under $MountPath will now appear in the" -ForegroundColor Gray
Write-Host "  $RepoPath repo and get committed + pushed within ~15 seconds." -ForegroundColor Gray
Write-Host ""
Write-Host "  Watcher log:    $env:USERPROFILE\.pharmacenter-quote-auto-push.log" -ForegroundColor Gray
Write-Host "  Stop watcher:   Stop-ScheduledTask -TaskName $TaskName" -ForegroundColor Gray
Write-Host "  Start watcher:  Start-ScheduledTask -TaskName $TaskName" -ForegroundColor Gray
Write-Host "  Uninstall:      Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false" -ForegroundColor Gray
Write-Host ""
