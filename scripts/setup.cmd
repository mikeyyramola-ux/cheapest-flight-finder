@echo off
rem ===========================================================================
rem  FARELOOP SANDBOX SETUP - double-click or run this. That's it.
rem
rem  Why this exists:
rem    - It resolves its OWN location (%~dp0), so it works from ANY directory.
rem      No "cd" to remember, no system32 trap.
rem    - It PROMPTS for the two credentials instead of taking them as
rem      arguments. Command-line arguments are visible in process listings and
rem      get saved into cmd.exe's history file. A prompt is neither.
rem    - Your values never appear in this file, never touch the chat, and are
rem      never written to disk. They go straight into the child node process.
rem
rem  WHAT YOU NEED BEFORE RUNNING THIS
rem  ---------------------------------
rem    The SANDBOX Client ID and Secret, from developer.paypal.com
rem    (Sandbox toggle ON -> your app -> Client ID, and Show for Secret).
rem
rem  WHAT IT DOES
rem  ------------
rem    Creates the sandbox billing plan and webhook, writes all five PayPal
rem    variables into Vercel, and deploys. Ends by telling you the next step.
rem ===========================================================================

setlocal enabledelayedexpansion

rem "%~dp0" is THIS script's folder (...\cff-live\scripts). ".." is the repo root.
cd /d "%~dp0.."

if not exist "scripts\sandbox-test.mjs" (
    echo.
    echo [STOP] Could not find scripts\sandbox-test.mjs next to this script.
    echo        Keep setup.cmd inside the cff-live\scripts folder.
    echo        Current directory is: %CD%
    echo.
    pause
    exit /b 1
)

echo.
echo  ==========================================================================
echo   Fareloop - PayPal SANDBOX setup
echo  ==========================================================================
echo.
echo  Working directory : %CD%
echo  PayPal host       : sandbox only (hardcoded - cannot reach live)
echo.
echo  Paste the two values from your SANDBOX app. They are read into this
echo  process only: not saved to disk, not sent to the chat, and not recorded
echo  in your command history.
echo.

rem If the values are ALREADY in the environment, use them silently. This makes
rem the script drivable two ways: interactive prompts (the normal, private path)
rem, or pre-set variables when a value is already available.
rem
rem set /p writes straight into the environment with no intermediate expansion,
rem so a value containing ^& or ^| cannot be re-interpreted as a command.
if not defined PAYPAL_CLIENT_ID     set /p PAYPAL_CLIENT_ID=        Paste SANDBOX Client ID : 
if not defined PAYPAL_CLIENT_SECRET set /p PAYPAL_CLIENT_SECRET=    Paste SANDBOX Secret    : 

echo.
echo.

if not defined PAYPAL_CLIENT_ID (
    echo [STOP] No Client ID entered.
    pause
    exit /b 1
)
if not defined PAYPAL_CLIENT_SECRET (
    echo [STOP] No Secret entered.
    pause
    exit /b 1
)

node "scripts\sandbox-test.mjs" setup
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
    echo  Setup did not complete. Read the message above before retrying.
) else (
    echo  Setup complete. Follow the instructions above - the only part left
    echo  is logging in as the SANDBOX BUYER and clicking Agree ^& Subscribe.
)
echo.
pause
endlocal
exit /b %RC%
