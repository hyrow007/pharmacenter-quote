@echo off
REM One-click deploy for the PharmaCenter Packing List Generator.
REM Launch it from the Run dialog (Win+R):  C:\q\push-packing.bat
REM Optional: add a commit message after the path, e.g.
REM   C:\q\push-packing.bat fix typo on sheet

setlocal
set "REPO=C:\code\pharmacenter-packing-list"

if not exist "%REPO%\.git" (
    echo ERROR: no git repo at %REPO%
    echo.
    pause
    exit /b 1
)

cd /d "%REPO%"

REM Use whatever the user typed after the path as the commit message.
REM If they typed nothing, stamp it with the date and time instead.
set "MSG=%*"
if not defined MSG set "MSG=deploy %DATE% %TIME%"

echo Deploying from %REPO%
echo Commit message: %MSG%
echo.

where pwsh >nul 2>&1
if %ERRORLEVEL%==0 (
    pwsh -NoProfile -ExecutionPolicy Bypass -File "%REPO%\deploy.ps1" "%MSG%"
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%REPO%\deploy.ps1" "%MSG%"
)

echo.
echo ---------------------------------------------
echo Done. This window stays open so you can read
echo the result. Press any key to close it.
echo ---------------------------------------------
pause >nul
endlocal
