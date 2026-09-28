@echo off
setlocal

where node >nul 2>nul
if errorlevel 1 (
  echo Claudex needs Node.js 22 or newer. Install Node.js, then run this file again.
  pause
  exit /b 1
)

set "CLAUDEX_DIR=%~dp0"
set "CLAUDEX_WORKSPACE=%~1"
if not defined CLAUDEX_WORKSPACE set "CLAUDEX_WORKSPACE=%CLAUDEX_DIR%.."

node "%CLAUDEX_DIR%bin\claudex.mjs" setup --workspace "%CLAUDEX_WORKSPACE%"
set "CLAUDEX_EXIT=%ERRORLEVEL%"

echo.
if "%CLAUDEX_EXIT%"=="0" (
  echo Claudex setup finished. Run doctor from this workspace to verify the installation.
) else (
  echo Claudex setup did not finish. Nothing is written until you confirm its summary.
)
pause
exit /b %CLAUDEX_EXIT%
