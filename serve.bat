@echo off
rem Serves this folder with Python's built-in HTTP server so a phone or tablet can load
rem the app. Plain HTTP on purpose: an HTTPS page cannot reach the game's http:// stream
rem or its ws:// API port.
rem
rem Usage: serve.bat [port]      (default 8080)

setlocal

set "PORT=%~1"
if "%PORT%"=="" set "PORT=8080"

set "PYTHON="
where py >nul 2>&1 && set "PYTHON=py -3"
if not defined PYTHON (
    where python >nul 2>&1 && set "PYTHON=python"
)
if not defined PYTHON (
    echo Python 3 was not found on PATH.
    exit /b 1
)

echo Serving %~dp0
echo.
echo   this pc      http://127.0.0.1:%PORT%/
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
    for /f "tokens=*" %%b in ("%%a") do echo   this network http://%%b:%PORT%/
)
echo.
echo Press Ctrl+C to stop.
echo.

%PYTHON% "%~dp0serve.py" %PORT%
