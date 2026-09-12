@echo off
REM ============================================================================
REM  FHI Service Work Order backend — one-click deploy.
REM  Double-click this file to publish the Worker. It always runs from THIS
REM  folder (so no "wrong directory" / Application Data permission error), and
REM  it runs in cmd (so no PowerShell script-execution-policy error).
REM ============================================================================
cd /d "%~dp0"

if not exist node_modules (
  echo First run - installing dependencies...
  call npm install
  echo.
)

echo Deploying the Worker to Cloudflare...
echo.
call npx wrangler deploy

echo.
echo ============================================================================
echo  If it says you are not logged in, run this once:  npx wrangler login
echo  Otherwise: deploy complete. You can close this window.
echo ============================================================================
pause
