@echo off
rem ===========================================================================
rem  FARELOOP - SINGLE CLICK SANDBOX TEST
rem
rem  DOUBLE-CLICK THIS FILE. That is the whole procedure on your side.
rem
rem  It resolves its own folder (%~dp0), so it works from anywhere - no "cd"
rem  to remember and no system32 trap.
rem
rem  WHAT IT DOES, UNATTENDED
rem  ------------------------
rem    1. Asks you for six values, once (see the list it prints).
rem    2. Builds the sandbox product, plan and webhook.
rem    3. Points production at sandbox and deploys.
rem    4. Opens the paywall in your browser.
rem    5. WAITS for you to approve. It finds the subscription id from PayPal
rem       itself, so there is no F12 and nothing to copy.
rem    6. Verifies: PayPal must say ACTIVE AND fareloop must grant premium.
rem    7. Puts production back on live PayPal and redeploys.
rem
rem  WHAT STAYS YOURS, PERMANENTLY
rem  -----------------------------
rem    The two logins. I will never ask you to share them:
rem      - signing in to fareloop.in, and
rem      - logging in as the SANDBOX BUYER to click Agree & Subscribe.
rem
rem  IF YOU CLOSE THIS WINDOW EARLY
rem  ------------------------------
rem    Production may be left pointing at sandbox, which means real customers
rem    cannot complete a purchase. Run scripts\revert-live.cmd to fix it.
rem ===========================================================================

setlocal

cd /d "%~dp0.."

if not exist "scripts\sandbox-test.mjs" (
    echo.
    echo  [STOP] Could not find scripts\sandbox-test.mjs.
    echo         Keep this file inside the cff-live\scripts folder.
    echo         Current directory is: %CD%
    echo.
    pause
    exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo  [STOP] Node.js is not on the PATH, so the test cannot run.
    echo         Install it from https://nodejs.org and double-click again.
    echo.
    pause
    exit /b 1
)

node "scripts\sandbox-test.mjs" full
set "RC=%ERRORLEVEL%"

echo.
echo.
pause
endlocal
exit /b %RC%
