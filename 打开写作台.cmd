@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Blog Studio - http://127.0.0.1:4174/studio/
echo Keep this window open while writing.
call npm run studio
pause
