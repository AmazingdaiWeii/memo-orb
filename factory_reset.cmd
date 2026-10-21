@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
cd /d "%~dp0"

REM ============================================================
REM  Orb Orb - factory reset launcher
REM
REM  *** ASCII ONLY - do NOT put Chinese characters in this file. ***
REM
REM  Why: a fresh cmd.exe starts at codepage 936. `chcp 65001` on a later
REM  line comes too late - cmd.exe has already begun decoding the batch
REM  file, mis-decodes the multibyte lines, and its byte-offset bookkeeping
REM  drifts, which SWALLOWS the following lines (including `node` / `pause`).
REM  Symptom: window flashes and closes instantly = "it won't open".
REM  reset_memory.cmd was broken exactly this way. Keep this file ASCII.
REM
REM  All Chinese output is printed by the Node script - that renders fine.
REM
REM  Options 1 and 2 are DRY RUNS (nothing on disk is touched).
REM  Options 3 and 4 really move files - but always into a timestamped
REM  backup folder first, so they are reversible.
REM
REM  Close orb before using option 3 or 4.
REM
REM  Usage:
REM    double-click            -> interactive menu
REM    factory_reset.cmd 2     -> one-shot, runs option 2 then exits
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
  echo Cannot find node.exe. Install Node.js 22+ or run the .mjs by hand.
  pause
  exit /b 1
)

set "ONESHOT="

:menu
cls
echo ============================================================
echo   Orb Orb - factory reset
echo ============================================================
echo.
echo   1  dry run  - full factory reset   (changes nothing)
echo   2  dry run  - memory only          (changes nothing)
echo   3  APPLY    - memory only          (keeps agent + persona)
echo   4  APPLY    - FULL factory reset   (agent + persona + config + lock)
echo   q  quit
echo.
echo   Backup folder: ..\Orb_factory_backup_^<timestamp^>
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
REM  `set /p` does not assign anything when stdin is at EOF, so ANS stays
REM  empty and the menu would redraw forever.
echo.
echo   Nothing selected - exiting.
exit /b 0

:r1
call :run "" ""
goto after_run
:r2
call :run "--memory-only" ""
goto after_run
:r3
call :run "--memory-only" "--apply"
goto after_run
:r4
call :run "" "--apply"
goto after_run

:after_run
REM  A one-shot run MUST exit here. Looping back to :menu would re-dispatch
REM  the very same %1 again - an infinite menu loop (measured: 353 KB of
REM  output in a couple of seconds before it got killed).
if defined ONESHOT exit /b 0
goto menu

REM -------------------------------------------------------------
REM  %1 = extra flags   %2 = --apply or empty
:run
set "EXTRA=%~1"
set "MODE=%~2"
if "%MODE%"=="--apply" (
  echo.
  echo   *** This really moves files off disk. ***
  echo   Everything is copied to a backup folder first, so it is reversible.
  echo.
  set "OK="
  set /p OK="type yes then Enter to proceed: "
  for /f "tokens=* delims=" %%B in ("!OK!") do set "OK=%%B"
  if /i not "!OK!"=="yes" (
    echo   cancelled - nothing changed.
    pause
    exit /b 0
  )
)
echo.
"%NODE%" tools\reset-to-factory.mjs %EXTRA% %MODE%
echo.
pause
exit /b 0
