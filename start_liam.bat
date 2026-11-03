@echo off
setlocal
chcp 65001 >nul
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "LIAM_DIR=%~dp0"
cd /d "%LIAM_DIR%" || exit /b 1
title LIAM

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on PATH. Install Node 20 or newer first.
  pause
  exit /b 1
)

:run
echo.
echo Starting Liam from "%LIAM_DIR%" ...
node whatsapp_bridge.js
set "CODE=%ERRORLEVEL%"
echo.
echo Liam stopped with exit code %CODE%.
echo Restarting in 5 seconds - press Ctrl+C to stop.
timeout /t 5 /nobreak >nul
goto run
