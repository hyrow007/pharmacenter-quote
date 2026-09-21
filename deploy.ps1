# One-shot deploy for the PharmaCenter Quote app (and the formula,
# meeting and order subdomains the same deployment serves).
#
# Usage from PowerShell in this folder:
#   .\deploy.ps1 "short description of the change"
#   .\deploy.ps1                    # prompts, rather than reusing a stale message
#   .\deploy.ps1 -FullBuild "..."     # real next build, not just tsc
#   .\deploy.ps1 -SkipTypecheck "..." # emergency escape hatch, avoid
#
# It typechecks first and refuses to commit if that fails, then stages,
# commits, rebases over origin/main and pushes. Vercel builds in ~60s.
#
# A commit message is REQUIRED. Generated messages are how this project ended
# up with eight consecutive commits reading "workflow: gummy formula
# calculator (Bulk -> Gummy -> PC)" -- that stretch of history cannot be
# bisected. `git log` is only worth having if the messages are.
#
# THIS REPO IS THE SOURCE OF TRUTH -- edit files here.
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
    [switch] $SkipTypecheck,
    # Run a real `next build` instead of `tsc`. Slower (~60s vs ~10s) but it
    # catches a class `tsc` structurally cannot -- see the note on the gate
    # below. Use it whenever package.json, next.config or a route's props
    # change; deploy.ps1 turns it on by itself when it spots the first of those.
    [switch] $FullBuild,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $Message
)

$ErrorActionPreference = "Stop"

$msg = if ($Message) { $Message -join " " } else { Read-Host "Commit message" }
if (-not $msg) { Write-Error "A commit message is required."; exit 1 }

# --- Typecheck gate ---------------------------------------------------------
# Nothing here used to compile the code before it was pushed. Vercel's build
# was the first thing that ever typechecked it, so a type error cost a push,
# a wait, and a dashboard check to discover -- and `deploy.ps1` would report
# success on a commit that never became a deployment.
#
# This runs BEFORE `git add`, so a failure leaves the working tree exactly as
# it was. Nothing is staged, committed or pushed.
#
# Both repos typechecked clean when this gate was added (2026-09-19), so a
# failure here means something you just changed, not pre-existing debt.
if (-not $SkipTypecheck) {
    if (-not (Get-Command npx -ErrorAction SilentlyContinue)) {
        Write-Host "npx not found - skipping typecheck. Install Node to enable it." -ForegroundColor Yellow
    } else {
        # Dependencies can be stale as well as missing. npm rewrites
        # node_modules\.package-lock.json on every install, so if package.json is
        # NEWER than that file, what is installed is not what package.json asks
        # for -- and typechecking against the old tree proves nothing about the
        # build Vercel is about to run. Found during the Next 14 -> 15 upgrade:
        # the gate would happily have passed on React 18 types while the commit
        # said React 19.
        $depsStale = $false
        $installedMarker = Join-Path $PSScriptRoot "node_modules\.package-lock.json"
        $pkgJson = Join-Path $PSScriptRoot "package.json"
        if ((Test-Path $installedMarker) -and (Test-Path $pkgJson)) {
            if ((Get-Item $pkgJson).LastWriteTime -gt (Get-Item $installedMarker).LastWriteTime) {
                $depsStale = $true
                $FullBuild = $true   # a dependency change is exactly when tsc is not enough
                Write-Host "package.json is newer than the installed tree - reinstalling." -ForegroundColor Yellow
            }
        }
        if ($depsStale) {
            Push-Location $PSScriptRoot
            npm install
            $instCode = $LASTEXITCODE
            Pop-Location
            if ($instCode -ne 0) { Write-Error "Dependency install failed - cannot typecheck."; exit 1 }
        }
        if (-not (Test-Path "$PSScriptRoot\node_modules")) {
            # First run on a fresh clone. ~1-2 minutes, once.
            #
            # `npm ci` REQUIRES a lockfile and errors out without one. This repo
            # has never had a committed package-lock.json, so the original
            # `npm ci` here could not succeed on any fresh clone -- which meant
            # the typecheck gate added in H7 was silently un-runnable from the
            # day it shipped. Found 2026-09-20, the first time anyone deployed
            # from a tree with no node_modules.
            #
            # npm install writes a lockfile as a side effect, and `git add -A`
            # below commits it. After the first successful run this branch
            # takes the `npm ci` path for good, which is the reproducible one.
            $lock = Join-Path $PSScriptRoot "package-lock.json"
            Push-Location $PSScriptRoot
            if (Test-Path $lock) {
                Write-Host "node_modules missing - running npm ci (one-time, ~1-2 min)..." -ForegroundColor Cyan
                npm ci
            } else {
                Write-Host "node_modules and package-lock.json both missing - running npm install (~1-2 min)." -ForegroundColor Cyan
                Write-Host "The lockfile it generates will be committed, so this is the last time." -ForegroundColor DarkGray
                npm install
            }
            $ciCode = $LASTEXITCODE
            Pop-Location
            if ($ciCode -ne 0) { Write-Error "Dependency install failed - cannot typecheck."; exit 1 }
        }
        # next-env.d.ts is gitignored and generated by `next dev`/`next build`,
        # neither of which may have run here. Without it tsc cannot see Next's
        # ambient types. Writing it is exactly what Next itself does.
        $nextEnv = Join-Path $PSScriptRoot "next-env.d.ts"
        if (-not (Test-Path $nextEnv)) {
            Set-Content -Path $nextEnv -Encoding ASCII -Value @(
                '/// <reference types="next" />',
                '/// <reference types="next/image-types/global" />'
            )
        }
        # WHAT tsc HERE CANNOT CATCH, and why -FullBuild exists.
        #
        # tsconfig-check.json deliberately excludes ".next/types/**/*.ts", which
        # only exists after a build. That directory is where Next puts the
        # generated PageProps/LayoutProps constraints that check a route's
        # `params` and `searchParams` against the framework's expectations.
        #
        # So a route typed `searchParams?: { from?: string }` passes this gate
        # and fails Vercel's build. That is exactly what happened on the Next 15
        # upgrade, where those props became Promises: tsc said 0 errors, the
        # real build failed on src/app/feedback/page.tsx. The gate is still worth
        # having -- it catches everything else in seconds -- but it is not a
        # substitute for a build, and it should not be described as one.
        Push-Location $PSScriptRoot
        if ($FullBuild) {
            Write-Host "Running a full next build (slower, checks route props too)..." -ForegroundColor Cyan
            npx next build
        } else {
            Write-Host "Typechecking..." -ForegroundColor Cyan
            npx tsc -p tsconfig-check.json --noEmit
        }
        $tscCode = $LASTEXITCODE
        Pop-Location
        if ($tscCode -ne 0) {
            Write-Host ""
            if ($FullBuild) {
                Write-Host "BUILD FAILED - nothing staged, committed or pushed." -ForegroundColor Red
            } else {
                Write-Host "TYPECHECK FAILED - nothing staged, committed or pushed." -ForegroundColor Red
                Write-Host "If this passes but Vercel fails, retry with -FullBuild." -ForegroundColor DarkGray
            }
            Write-Host "Fix the errors above, then run deploy again." -ForegroundColor Red
            Write-Host "To deploy anyway (you almost never want this): .\deploy.ps1 -SkipTypecheck ""msg""" -ForegroundColor DarkGray
            exit 1
        }
        Write-Host $(if ($FullBuild) { "Build passed." } else { "Typecheck passed." }) -ForegroundColor Green
    }
}
# A zero-byte .git/index.lock left behind by a crashed git process blocks
# every subsequent `git add`. Git writes this file and renames it within
# milliseconds, so a zero-byte lock more than 10 minutes old is debris, never
# a live operation.
#
# Hit twice on 2026-09-20. The second time it cost a whole deploy, and the way
# it cost it is the part worth fixing: `git add -A` failed, nothing was
# staged, and the check below then printed "Nothing to commit." and exited 0.
# A hard failure wearing the costume of a clean no-op -- the same shape as the
# C4 auto-updater, and as a deploy that reports success on a commit Vercel
# never built.
$lockFile = Join-Path $PSScriptRoot ".git\index.lock"
if (Test-Path $lockFile) {
    $lock = Get-Item $lockFile -Force
    $ageMin = ([DateTime]::Now - $lock.LastWriteTime).TotalMinutes
    if ($lock.Length -eq 0 -and $ageMin -gt 10) {
        Write-Host ("Removing stale .git/index.lock - 0 bytes, {0:N0} min old." -f $ageMin) -ForegroundColor Yellow
        Remove-Item $lockFile -Force
    } else {
        Write-Error ("A git process is holding .git/index.lock ({0} bytes, {1:N0} min old). Close any running git or editor operation, then retry." -f $lock.Length, $ageMin)
        exit 1
    }
}

git add -A
if ($LASTEXITCODE -ne 0) {
    Write-Error "git add failed - nothing staged, nothing committed, nothing pushed."
    exit 1
}
$staged = git diff --cached --name-only
if (-not $staged) {
    # "Nothing to commit" is NOT "nothing to ship". A commit made outside this
    # script -- by an agent working in the repo, by git on the command line, by
    # another chat -- leaves the working tree clean while main sits AHEAD of
    # origin. Exiting 0 here printed a calm yellow "Nothing to commit." while
    # production kept serving the old build, which is the precise failure this
    # script exists to prevent. Cost a deploy on 2026-09-20 (the hidden
    # Meetings tile stayed visible after a "successful" run).
    # NOTE the ErrorActionPreference dance. git writes progress ("From
    # https://github.com/...") to STDERR even on success, and under
    # $ErrorActionPreference = "Stop" a redirected stderr stream from a native
    # command becomes a terminating NativeCommandError. Redirecting with
    # `2>$null` is what turns a healthy fetch into a red wall of text -- which
    # is exactly what the first version of this block did. Suppress the
    # preference for the duration, then put it back.
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    git fetch origin main --quiet 2>&1 | Out-Null
    $ahead = git rev-list --count origin/main..HEAD 2>&1
    $ErrorActionPreference = $prevEAP
    if ($LASTEXITCODE -eq 0 -and [int]$ahead -gt 0) {
        Write-Host ""
        Write-Host ("Nothing new to stage, but {0} local commit(s) are not on origin - pushing those." -f $ahead) -ForegroundColor Cyan
        git log --oneline origin/main..HEAD | ForEach-Object { Write-Host "    $_" }
        git pull --rebase origin main
        if ($LASTEXITCODE -ne 0) { Write-Error "git pull --rebase failed - nothing pushed."; exit 1 }
        git push
        if ($LASTEXITCODE -ne 0) { Write-Error "git push FAILED - this deploy did not ship."; exit 1 }
        Write-Host ""
        Write-Host "Pushed. Vercel is rebuilding - give it ~60s." -ForegroundColor Green
        Write-Host "A push is not a deployment: check the Vercel dashboard before" -ForegroundColor DarkGray
        Write-Host "believing this shipped." -ForegroundColor DarkGray
        exit 0
    }
    Write-Host "Nothing to commit, and nothing unpushed." -ForegroundColor Yellow
    exit 0
}

Write-Host ""
Write-Host "Deploying $(@($staged).Count) file(s):" -ForegroundColor Cyan
$staged | Select-Object -First 20 | ForEach-Object { Write-Host "    $_" }
if (@($staged).Count -gt 20) { Write-Host "    ... and $(@($staged).Count - 20) more" }

git commit -m $msg
if ($LASTEXITCODE -ne 0) { Write-Error "git commit failed - nothing pushed."; exit 1 }
# Rebase over anything pushed from elsewhere (another chat, the GitHub UI,
# another machine) so a stale local main can't turn a deploy into a rejected
# push.
git pull --rebase origin main
git push
if ($LASTEXITCODE -ne 0) { Write-Error "git push FAILED - this deploy did not ship."; exit 1 }

Write-Host ""
Write-Host "Pushed. Vercel is rebuilding - give it ~60s." -ForegroundColor Green
Write-Host "A push is not a deployment: check the Vercel dashboard before" -ForegroundColor DarkGray
Write-Host "believing it shipped. An invalid vercel.json produces no" -ForegroundColor DarkGray
Write-Host "deployment record at all, which looks exactly like success here." -ForegroundColor DarkGray
