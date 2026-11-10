@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0" || exit /b 1
title LIAM - upload saved login to Supabase

echo.
echo This copies your saved WhatsApp login to your Supabase cloud folder.
echo Keep this window open until it says "WhatsApp login uploaded: yes".
echo.
echo If the two values below are already set in this window, just press Enter.
echo.

if not defined SUPABASE_URL set /p SUPABASE_URL=Paste your Supabase URL: 
if not defined SUPABASE_SECRET_KEY set /p SUPABASE_SECRET_KEY=Paste your Supabase secret key: 

set "LIAM_DATA_DIR=%LOCALAPPDATA%\LiamWhatsApp"

echo.
echo Uploading...
echo.
call npm run seed:supabase

echo.
echo ------------------------------------------------
echo If it says "WhatsApp login uploaded: yes", it worked.
echo If it says NO, copy the error above and send it to me.
echo ------------------------------------------------
pause
