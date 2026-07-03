@echo off
setlocal
title Install PharmaCenter-Quote Auto-Push Watcher

rem  install-quote-watcher.bat  --  one-click installer.
rem
rem  Runs the full sync + install sequence:
rem    1. robocopy the Cowork mount (%~dp0) into C:\code\pharmacenter-quote
rem    2. git add / commit / pull --rebase / push  (last manual push ever)
rem    3. cd into scripts\ and run install-auto-push.ps1 with the current
rem       mount path baked in — %~dp0 is exactly where this .bat lives,
rem       which IS the current Cowork mount folder.
rem
rem  Just double-click me from File Explorer.

set "REPO=C:\code\pharmacenter-quote"
set "SRC=%~dp0"
rem strip trailing backslash off %~dp0 for the ps1 -MountPath param
if "%SRC:~-1%"=="\" set "SRC=%SRC:~0,-1%"

echo === Install PharmaCenter-Quote Auto-Push Watcher ===
echo.
echo SRC : %SRC%
echo REPO: %REPO%
echo.

if not exist "%REPO%\.git" (
  echo ERROR: no git repo at %REPO% -- run init-git.ps1 first
  pause
  exit /b 1
)

echo --- Step 1: mirror mount into repo ---
robocopy "%SRC%" "%REPO%" /E ^
  /XD ".git" "node_modules" ".next" "assets" "push-to-github" ^
  /XF "push-quote.bat" "install-quote-watcher.bat" "init-git.ps1" ".DS_Store" ^
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
git commit -m "scripts: sanitize non-ASCII for PowerShell 5.1"
git pull --rebase origin main
git push

popd

echo.
echo --- Step 3: run the installer ---
pushd "%REPO%\scripts"
powershell -NoProfile -ExecutionPolicy Bypass -File ".\install-auto-push.ps1" -MountPath "%SRC%"
set INSTALLER_RC=%ERRORLEVEL%
popd

echo.
if "%INSTALLER_RC%"=="0" (
  echo === All done. From now on, every file Claude saves auto-pushes. ===
) else (
  echo === Installer exited with code %INSTALLER_RC% -- scroll up for the error. ===
)
echo.
pause
endlocal
