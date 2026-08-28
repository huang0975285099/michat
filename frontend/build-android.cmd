@echo off
setlocal

set "BASH_EXE=%GIT_BASH%"
if not defined BASH_EXE if exist "D:\Program Files\Git\bin\bash.exe" set "BASH_EXE=D:\Program Files\Git\bin\bash.exe"
if not defined BASH_EXE if exist "C:\Program Files\Git\bin\bash.exe" set "BASH_EXE=C:\Program Files\Git\bin\bash.exe"

if not defined BASH_EXE (
    echo Git Bash was not found. Install Git for Windows or set GIT_BASH.
    exit /b 1
)

"%BASH_EXE%" "%~dp0build-android.sh" %*
exit /b %ERRORLEVEL%
