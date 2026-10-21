@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
cd /d "%~dp0"

REM ============================================================
REM  Orb Orb - copy the project to D:\Orb
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
REM  This only COPIES. E:\Memo orb stays exactly as it is.
REM  Options 1 and 2 change nothing on disk.
REM  Option 3 really copies. Option 4 copies then opens the factory reset
REM  menu, which is a separate, deliberate step (it clears ~/.legacy, which
REM  is GLOBAL - the E master's memory zeroes too, but it is backed up).
REM
REM  Usage:
REM    double-click             -> interactive menu
REM    migrate_to_D.cmd 3       -> one-shot, runs option 3 then exits
REM    migrate_to_D.cmd 1 D:\x  -> dry run against a different target
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

REM --- target directory: arg 2 overrides, else D:\Orb ---
set "DEST=%~2"
if not defined DEST set "DEST=D:\Orb"

set "ONESHOT="

:menu
cls
echo ============================================================
echo   Orb Orb - copy project to D (master copy untouched)
echo ============================================================
echo.
echo   Target: %DEST%
echo.
echo   1  dry run  - list what would be copied, size, free space
echo   2  dry run  - same, against a different target directory
echo   3  COPY     - really copy everything to the target
echo   4  step 1+3 then open factory reset (see warning below)
echo   q  quit
echo.
echo   Not copied (with reasons): probe/ helper-src/ deco-plan/
echo   generated-images/ .userdata/ .workbuddy/ logs/ node_modules/
echo   node_modules is rebuilt in the target with `npm install`.
echo.
echo   WARNING: the factory reset clears ~/.legacy, which is GLOBAL.
echo   The E master's memory zeroes too. A timestamped backup is made
echo   first, so it is reversible.
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
"%NODE%" tools\migrate-to-D.mjs --dest "%DEST%"
goto after_run

:r2
echo.
set "T="
set /p T="new target directory (e.g. D:\Orb2) then Enter: "
for /f "tokens=* delims=" %%B in ("!T!") do set "T=%%B"
if not defined T (
  echo   Nothing entered - exiting.
  pause
  exit /b 0
)
"%NODE%" tools\migrate-to-D.mjs --dest "!T!"
goto after_run

:r3
call :confirm_and_copy
goto after_run

:r4
call :confirm_and_copy
echo.
echo   Opening the factory reset menu. Close the orb first.
echo.
if exist "%~dp0factory_reset.cmd" (
  call "%~dp0factory_reset.cmd"
) else (
  echo   factory_reset.cmd not found next to this launcher.
  pause
)
goto after_run

:after_run
REM  A one-shot run MUST exit here. Looping back to :menu would re-dispatch
REM  the very same %1 again - an infinite menu loop (measured: 353 KB of
REM  output in a couple of seconds before it got killed).
if defined ONESHOT exit /b 0
goto menu

REM -------------------------------------------------------------
REM  Shared by options 3 and 4: confirm, then really copy.
:confirm_and_copy
echo.
echo   *** This really copies to: %DEST% ***
echo   The master copy at %~dp0 is not touched.
echo.
set "OK="
set /p OK="type yes then Enter to proceed: "
for /f "tokens=* delims=" %%C in ("!OK!") do set "OK=%%C"
if /i not "!OK!"=="yes" (
  echo   cancelled - nothing changed.
  pause
  exit /b 0
)
echo.
"%NODE%" tools\migrate-to-D.mjs --apply --force --dest "%DEST%"
echo.
echo ------------------------------------------------------------
echo   Next, inside the target copy:
echo     1. cd /d %DEST%
echo     2. npm install        (rebuilds node_modules)
echo     3. run.cmd            (smoke test)
echo     4. factory_reset.cmd  (pick 1 to rehearse, then 4 to apply)
echo ------------------------------------------------------------
pause
exit /b 0
