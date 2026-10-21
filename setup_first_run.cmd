@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
cd /d "%~dp0"

REM ============================================================
REM  Orb - first-time setup in this copy
REM
REM  *** ASCII ONLY - do NOT put Chinese characters in this file. ***
REM
REM  Why: a fresh cmd.exe starts at codepage 936. `chcp 65001` on a later
REM  line comes too late - cmd.exe has already begun decoding the batch
REM  file, mis-decodes the multibyte lines, and its byte-offset bookkeeping
REM  drifts, which SWALLOWS the following lines (including `node` / `pause`).
REM  Symptom: window flashes and closes instantly = "it won't open".
REM  All Chinese output is printed by the Node script - that renders fine.
REM
REM  This runs, in order:
REM    1. check the copy is complete (no half-copied files)
REM    2. check dependencies    (this project has none - just report it)
REM    3. smoke test            (start the orb, wait, then close it)
REM
REM  Nothing here touches your memory or your API key.
REM
REM  Usage:
REM    double-click             -> interactive menu
REM    setup_first_run.cmd 2    -> one-shot, runs option 2 then exits
REM ============================================================

REM --- resolve node (bare `node` first, then known fallbacks) ---
set "NODE=node"
where node >nul 2>nul
if errorlevel 1 (
  set "NODE="
  if exist "%~dp0runtime\node\node.exe" set "NODE=%~dp0runtime\node\node.exe"
  if not defined NODE if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe" set "NODE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
  if not defined NODE if exist "G:\nodejs\node.exe" set "NODE=G:\nodejs\node.exe"
)
if not defined NODE (
  echo Cannot find node.exe. Install Node.js 22+ first.
  pause
  exit /b 1
)

REM --- dependencies: this project is zero-dependency by design (see package.json).
REM     We deliberately do NOT resolve or run npm here; `npm install` on a
REM     zero-dependency tree is unnecessary and would create a node_modules
REM     folder that the app never reads.

set "ONESHOT="

:menu
cls
echo ============================================================
echo   Orb - first-run setup for this copy
echo ============================================================
echo.
echo   This folder: %~dp0
echo.
echo   1  check files   - verify the copy is complete
echo   2  dependencies  - report dependency state (none needed)
echo   3  smoke test    - start the orb, wait 8s, then stop it
echo   4  all of the above, in order
echo   q  quit
echo.
echo   Your memory and API key are NOT touched by any of these.
echo   For a factory reset, use factory_reset.cmd instead.
echo.
set "ANS="
if not "%~1"=="" (
  set "ANS=%~1"
  set "ONESHOT=1"
  goto dispatch
)
set /p ANS="choose 1 / 2 / 3 / 4 / q then Enter: "

:dispatch
REM  Normalise: redirected stdin can leave a CR/LF behind, which turns
REM  `if "%ANS%"=="1"` into a multi-line command and throws a syntax error.
for /f "tokens=* delims=" %%A in ("!ANS!") do set "ANS=%%A"

if /i "!ANS!"=="1" goto r1
if /i "!ANS!"=="2" goto r2
if /i "!ANS!"=="3" goto r3
if /i "!ANS!"=="4" goto r4
if /i "!ANS!"=="q" exit /b 0

REM  Empty input must EXIT, never `goto menu`.
echo.
echo   Nothing selected - exiting.
exit /b 0

:r1
call :checkfiles
goto after_run

:r2
call :install
goto after_run

:r3
call :smoke
goto after_run

:r4
call :checkfiles
if errorlevel 1 goto after_run
call :install
if errorlevel 1 goto after_run
call :smoke
goto after_run

:after_run
if defined ONESHOT exit /b 0
goto menu

REM -------------------------------------------------------------
REM  `pause` blocks forever when stdin is not a TTY (one-shot / piped
REM  runs), which hangs the whole script. Skip it in one-shot mode.
:pause_maybe
if defined ONESHOT exit /b 0
pause
exit /b 0

REM -------------------------------------------------------------
:checkfiles
echo.
"%NODE%" tools\check-copy.mjs
echo.
call :pause_maybe
exit /b 0

REM -------------------------------------------------------------
:install
echo.
echo   This project has NO npm dependencies - nothing to install.
echo   (dependencies is an empty object in package.json, by design)
echo.
if exist "%~dp0node_modules" (
  echo   A node_modules folder exists here. It is not needed by the app and
  echo   can be deleted.
) else (
  echo   node_modules is absent, which is the expected state.
)
echo.
call :pause_maybe
exit /b 0

REM -------------------------------------------------------------
:smoke
echo.
echo   Starting the orb for 8 seconds, then stopping it.
echo   Watch it appear near the bottom-right of your screen.
echo.
if not exist "%~dp0src\launch.mjs" (
  echo   src\launch.mjs is missing - this copy is incomplete.
  call :pause_maybe
  exit /b 1
)
start "" "%NODE%" src\launch.mjs
timeout /t 8 /nobreak >nul
taskkill /IM electron.exe /F >nul 2>nul
echo   Stopped. If the orb appeared, this copy works.
echo   Next: run factory_reset.cmd if you want a clean memory.
echo.
call :pause_maybe
exit /b 0
