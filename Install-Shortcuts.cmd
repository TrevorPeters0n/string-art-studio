@echo off
rem Adds String Art Studio to your Desktop and Start Menu.
rem Run again with /remove to take them away.
cd /d "%~dp0"
if /i "%~1"=="/remove" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-Shortcuts.ps1" -Remove
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-Shortcuts.ps1"
)
echo.
pause
