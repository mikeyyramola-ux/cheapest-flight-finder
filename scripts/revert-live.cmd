@echo off
rem ===========================================================================
rem  FARELOOP - PUT LIVE PAYPAL BACK
rem
rem  THE SAFETY NET. Run this if the single-click test was closed early, or if
rem  you ever see the site refusing real payments. It restores production to
rem  live PayPal and redeploys.
rem
rem  WHY THIS EXISTS
rem  ---------------
rem  While PAYPAL_MODE is not exactly "live", production accepts only SANDBOX
rem  subscriptions. That is correct and deliberate during a test - but it also
rem  means a real customer cannot complete a purchase until it is switched
rem  back. This file makes switching back a single action.
rem
rem  It prompts for the four LIVE values rather than reading them from the
rem  environment, because after a sandbox run the environment holds SANDBOX
rem  values. Writing those back as "live" would silently break payments, so
rem  this file will not guess.
rem
rem  VALUES ARE TYPED AT THE PROMPT: never into the chat, never into your
rem  command history, never written to disk.
rem ===========================================================================

setlocal

cd /d "%~dp0.."

if not exist "scripts\sandbox-test.mjs" (
    echo.
    echo  [STOP] Could not find scripts\sandbox-test.mjs next to this script.
    echo         Keep revert-live.cmd inside the cff-live\scripts folder.
    echo.
    pause
    exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo  [STOP] Node.js is not on the PATH.
    echo.
    pause
    exit /b 1
)

echo.
echo  ==========================================================================
echo   FARELOOP - restore LIVE PayPal on production
echo  ==========================================================================
echo.
echo  Enter the four LIVE values from developer.paypal.com
echo  (Sandbox toggle OFF - the Live tab - your live REST app).
echo.
echo  These are written to Vercel only. They are never sent anywhere else.
echo.

if not defined PAYPAL_CLIENT_ID     set /p PAYPAL_CLIENT_ID=     Live Client ID  : 
if not defined PAYPAL_CLIENT_SECRET set /p PAYPAL_CLIENT_SECRET= Live Secret      : 
if not defined PAYPAL_PREMIUM_PLAN_ID     set /p PAYPAL_PREMIUM_PLAN_ID=     Live Plan ID     : 
if not defined PAYPAL_WEBHOOK_ID          set /p PAYPAL_WEBHOOK_ID=          Live Webhook ID  : 

echo.
if not defined PAYPAL_CLIENT_ID (
    echo  [STOP] No Live Client ID entered. Nothing was changed.
    echo.
    pause
    exit /b 1
)

node "scripts\sandbox-test.mjs" revert
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
    echo  ==========================================================================
    echo   PRODUCTION MAY STILL BE ON SANDBOX. A real customer cannot complete a
    echo   purchase until PAYPAL_MODE is "live". Read the failures above, then
    echo   run this file again.
    echo  ==========================================================================
) else (
    echo  ==========================================================================
    echo   RESTORED. Production is on live PayPal again.
    echo.
    echo   Sanity-check once: a real checkout should issue a genuine I-... id and
    echo   verifyPayPal should report APPROVAL_PENDING, not ACTIVE.
    echo  ==========================================================================
)
echo.
pause
endlocal
exit /b %RC%
