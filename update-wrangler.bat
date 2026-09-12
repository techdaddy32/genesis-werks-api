@echo off
REM ============================================================================
REM  Update wrangler (Cloudflare's deploy tool) to the latest version.
REM  Double-click to run. Safe to run anytime the "wrangler is out of date"
REM  message appears. Runs from THIS folder so it updates the project's copy.
REM ============================================================================
cd /d "%~dp0"

echo Updating wrangler to the latest version...
echo.
call npm install --save-dev wrangler@latest

echo.
echo ============================================================================
echo  Done. wrangler is now up to date. You can close this window.
echo  (Next deploy: just double-click deploy.bat as usual.)
echo ============================================================================
pause
