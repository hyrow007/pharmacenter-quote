@echo off
setlocal
title Push PharmaCenter-Quote to GitHub NOW

rem  push-now.bat  --  manual one-shot push, in case the auto-watcher isn't
rem  running for some reason (task died, mount path went stale, etc.).
rem
rem  Steps:
rem   1. Robocopy current mount folder into the C:\code\pharmacenter-quote
rem      repo checkout (with the same excludes the watcher uses).
rem   2. git add / commit / pull --rebase / push to origin/main.

set "REPO=C:\code\pharmacenter-quote"
set "SRC=%~dp0"
if "%SRC:~-1%"=="\" set "SRC=%SRC:~0,-1%"

echo === Manual push ===
echo SRC : %SRC%
echo REPO: %REPO%
echo.

if not exist "%REPO%\.git" (
  echo ERROR: no git repo at %REPO%
  pause
  exit /b 1
)

echo --- Step 1: mirror mount into repo ---
robocopy "%SRC%" "%REPO%" /E ^
  /XD ".git" "node_modules" ".next" "assets" "push-to-github" ^
  /XF "push-quote.bat" "push-now.bat" "install-quote-watcher.bat" "init-git.ps1" ".DS_Store" ^
      "qg-app.jsx" "qg-editor.jsx" "qg-sheet.jsx" ^
      "quote.css" "generator.html" ^
  /NFL /NDL
if errorlevel 8 (
  echo Robocopy failed.
  pause
  exit /b 1
)

pushd "%REPO%"

echo.
echo --- Step 2: commit and push ---
git add -A
git status --short
git commit -m "formulas: catalog + three-tab editor + workflow ref plumbing"
git pull --rebase origin main
git push

popd

echo.
echo === Done ===
pause
endlocal
