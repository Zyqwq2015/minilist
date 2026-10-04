@echo off
setlocal
cd /d "%~dp0"
chcp 65001 >nul 2>nul

where node >nul 2>nul
if errorlevel 1 goto nonode

echo.
echo   Starting minilist ...
echo.
node "src\launch.js" %*
set "CODE=%ERRORLEVEL%"

if not "%CODE%"=="0" (
  echo.
  echo   [minilist] exited with code %CODE%
  echo.
  pause
)
exit /b %CODE%

:nonode
echo.
echo   [minilist] Node.js was not found on PATH.
echo   Install Node.js 16 or newer from https://nodejs.org/ and run this file again.
echo.
pause
exit /b 1