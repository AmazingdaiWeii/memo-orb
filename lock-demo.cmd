@echo off
chcp 65001 >nul
cd /d "%~dp0"
REM ============================================================
REM  Whale-Orb soft-lock mask demo (verification switch, not a product feature)
REM
REM  Why it exists: soft lock auto-arms only when BOTH gates are on -
REM    1. settings.softEnabled === true
REM    2. a usable agreement phrase exists (lock.hasAgreement())
REM  plus the default 30-minute idle timeout. Reproducing the mask by hand
REM  is nearly impossible. This script opens gate 1 and squeezes the idle
REM  timeout to 3 seconds so the mask pops up on its own.
REM
REM  Usage (double-click this file):
REM     double-click  -> show current state (read-only, changes nothing)
REM     type on  + Enter -> enable demo (mask after 3 s idle)
REM     type off + Enter -> disable demo, restore original settings
REM
REM  NOTE: you MUST restart orb (run.cmd) for changes to take effect -
REM  the idle watchdog reads settings once at process startup.
REM
REM  All Chinese text lives in tools\lock-demo.mjs (Node prints UTF-8).
REM  This .cmd is pure ASCII on purpose: cmd misparses UTF-8 bytes without
REM  BOM under a GBK codepage and starts executing REM lines as commands.
REM ============================================================

node tools\lock-demo.mjs show

echo.
echo ------------------------------------------------------------
echo  What next?
echo    on  = enable demo (mask after 3 s idle)
echo    off = disable demo, restore original settings
echo    Enter alone = do nothing, exit
echo ------------------------------------------------------------
set /p ACT="Type on / off then Enter: "

if /i "%ACT%"=="on"  node tools\lock-demo.mjs on
if /i "%ACT%"=="off" node tools\lock-demo.mjs off
if /i "%ACT%"==""   echo No change made.

echo.
echo  Remember: restart orb (run.cmd) for the setting to take effect.
pause
