@echo off
rem Serves this folder with Python's built-in HTTP server so a phone or tablet can load
rem the app. Plain HTTP on purpose: an HTTPS page cannot reach the game's http:// stream
rem or its ws:// API port.
rem
rem Usage: serve.bat [port]      (default 45000, since spice2x uses 8080 for -ea)

setlocal

set "PORT=%~1"
if "%PORT%"=="" set "PORT=45000"

set "PYTHON="
call :probe "py -3"
if not defined PYTHON call :probe "python"
if not defined PYTHON call :probe "python3"

if not defined PYTHON (
    echo Python 3 is required to serve this folder.
    echo.
    echo Windows may have just opened the Microsoft Store on the Python page - installing
    echo from there is enough. Otherwise: https://www.python.org/downloads/
    echo.
    echo Run this again once it is installed.
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
exit /b

rem Windows ships stub launchers that only open the Store, so being on PATH proves nothing
rem and a candidate has to answer before it can be trusted
:probe
for /f "delims=" %%v in ('%~1 -c "print(1)" 2^>nul') do if "%%v"=="1" set "PYTHON=%~1"
goto :eof
