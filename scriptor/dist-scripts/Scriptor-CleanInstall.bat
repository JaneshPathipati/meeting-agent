@echo off
:: Scriptor Clean Install — double-click launcher
:: Runs the PowerShell clean install script with the correct execution policy.
:: Automatically requests admin elevation if needed.

:: ── Check for admin rights and re-launch elevated if missing ────────────────
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo Requesting administrator privileges...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

:: ── Run the PowerShell script from the same directory as this .bat ──────────
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Scriptor-CleanInstall.ps1"

pause
