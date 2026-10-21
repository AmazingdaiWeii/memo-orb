@echo off
REM ============================================================
REM 旧后端 Orb - build a clean, double-clickable runtime folder
REM
REM  Output shape:
REM    D:\Orb\orb.exe          <- double-click to run
REM    D:\Orb\resources\app\   <- program + assets + deps
REM
REM  Pure ASCII on purpose. A .cmd containing non-ASCII bytes is
REM  decoded line-by-line as GBK; the byte-offset bookkeeping then
REM  drifts and swallows following lines (node.exe / pause), so the
REM  window flashes shut with ZERO error message. All Chinese text
REM  is printed by Node instead.
REM ============================================================
setlocal enabledelayedexpansion
chcp 65001 >nul
cd /d "%~dp0"

set "DEST=D:\Orb"
if not "%~1"=="" set "ONESHOT=1"
if not "%~2"=="" set "DEST=%~2"

REM ---- locate node.exe (three-level fallback) ----
set "NODE=node"
where node >nul 2>&1
if errorlevel 1 set "NODE=%~dp0runtime\node\node.exe"
if not exist "%NODE%" set "NODE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if not exist "%NODE%" set "NODE=G:\nodejs\node.exe"
if not exist "%NODE%" (
  echo [ERROR] node.exe not found.
  goto :eof
)

REM ---- one-shot dispatch: `build_clean_orb.cmd 1 [dest]` runs and returns ----
REM Without this the menu would do `set /p` on a non-TTY stdin and hang.
if defined ONESHOT (
  if /i "%~1"=="1" goto :do_dry
  if /i "%~1"=="2" goto :do_build
)

:menu
cls
echo ============================================================
echo  旧后端 Orb - clean runtime builder
echo ============================================================
echo   Source  : %CD%
echo   Target  : %DEST%
echo   Node    : %NODE%
echo.
echo   1  Dry run          list what goes in, write nothing
echo   2  BUILD            write to %DEST%
echo   3  Change target    current: %DEST%
echo   q  Quit
echo.
set "ANS="
set /p "ANS=Choose [1/2/3/q]: "
if not defined ANS goto :eof
for /f "tokens=* delims=" %%A in ("!ANS!") do set "ANS=%%A"

if /i "!ANS!"=="1" goto :do_dry
if /i "!ANS!"=="2" goto :do_build
if /i "!ANS!"=="3" goto :do_dest
if /i "!ANS!"=="q" goto :eof
if /i "!ANS!"=="quit" goto :eof
echo.
echo  Unknown choice: !ANS!
call :pause_maybe
goto :menu

:do_dry
echo.
"%NODE%" tools\build-runtime.mjs --dest "%DEST%"
echo.
call :pause_maybe
if defined ONESHOT exit /b 0
goto :menu

:do_build
echo.
echo   Target : %DEST%
echo   NOTE   : if the target already exists it is RENAMED aside to
echo            %DEST%_old_^<timestamp^> (instant, rollback-safe).
echo            It is never silently deleted.
echo.
set "OK="
set /p "OK=Type yes to build: "
if not defined OK goto :eof
for /f "tokens=* delims=" %%A in ("!OK!") do set "OK=%%A"
if /i not "!OK!"=="yes" (
  echo.
  echo  Cancelled. Nothing was written.
  echo.
  call :pause_maybe
  if defined ONESHOT exit /b 0
  goto :menu
)
echo.
"%NODE%" tools\build-runtime.mjs --apply --dest "%DEST%"
echo.
call :pause_maybe
if defined ONESHOT exit /b 0
goto :menu

:do_dest
echo.
set "NEWDEST="
set /p "NEWDEST=New target dir (blank = keep %DEST%): "
if not defined NEWDEST goto :menu
for /f "tokens=* delims=" %%A in ("!NEWDEST!") do set "NEWDEST=%%A"
set "DEST=!NEWDEST!"
goto :menu

REM `pause` blocks forever when stdin is not a TTY (one-shot or piped
REM runs) and hangs the whole script. Skip it in one-shot mode.
:pause_maybe
if defined ONESHOT exit /b 0
pause
exit /b 0
