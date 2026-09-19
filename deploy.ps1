# One-shot deploy for the PharmaCenter Quote app (and the formula,
# meeting and order subdomains the same deployment serves).
#
# Usage from PowerShell in this folder:
#   .\deploy.ps1 "gummy formula calculator: fix scaling"
#   .\deploy.ps1                 # prompts, rather than reusing a stale message
#
# Identical in shape to the packing list's deploy.ps1. THIS REPO IS THE
# SOURCE OF TRUTH -- edit files here.
#
# History: this app used to be edited in C:\q, with the git checkout as a
# disposable robocopy mirror of it. That mirror was copy-only (robocopy /E,
# no /PURGE, so deletions never propagated), carried an exclude list that
# silently dropped some files, and -- worst -- overwrote any edit made in
# the checkout on the next deploy, with no warning. C:\q was retired on
# 2026-09-19; the checkout already contained everything the mirror fed it.
# Do not reintroduce a mirror step. If anything still writes into C:\q,
# those changes will NOT reach production.

param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $Message
)

$ErrorActionPreference = "Stop"

$msg = if ($Message) { $Message -join " " } else { Read-Host "Commit message" }
if (-not $msg) { Write-Error "A commit message is required."; exit 1 }

git add -A
$staged = git diff --cached --name-only
if (-not $staged) {
    Write-Host "Nothing to commit." -ForegroundColor Yellow
    exit 0
}

Write-Host ""
Write-Host "Deploying $(@($staged).Count) file(s):" -ForegroundColor Cyan
$staged | Select-Object -First 20 | ForEach-Object { Write-Host "    $_" }
if (@($staged).Count -gt 20) { Write-Host "    ... and $(@($staged).Count - 20) more" }

git commit -m $msg
# Rebase over anything pushed from elsewhere so a stale local main can't
# turn a deploy into a rejected push.
git pull --rebase origin main
git push

Write-Host ""
Write-Host "Pushed. Vercel is rebuilding - give it ~60s." -ForegroundColor Green
