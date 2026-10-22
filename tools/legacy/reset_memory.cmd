@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
cd /d "%~dp0"

REM ============================================================
REM  Orb Orb - memory reset (memory + chats only)
REM
REM  *** ASCII ONLY - do NOT put Chinese characters in this file. ***
REM
REM  WHY THIS FILE WAS REWRITTEN (2026-10-08):
REM  The old version did:  git -C <memfs>\memory reset --hard HEAD
REM  That is NOT a reset to factory. The memory folder is a git repo, so
REM  `reset --hard HEAD` only rewinds to the MOST RECENT commit - which is
REM  the version already full of accumulated memory. Every older memory is
REM  still in .git/objects and recoverable with `git log`. It also had a
REM  hardcoded agent-id path, and it contained raw Chinese, so under
REM  codepage 936 cmd.exe parsed the file wrong and the window closed
REM  instantly (exit 255).
REM
REM  All of that is fixed by delegating to tools\reset-to-factory.mjs,
REM  which MOVES the whole memory repo into a timestamped backup folder.
REM
REM  This script clears : memfs/ + conversations/ + transcripts/ + logs/
REM  This script keeps  : the agent, the persona in `system`, config.json,
REM                       locks.json, providers/ (the API key)
REM  For a FULL factory reset use factory_reset.cmd instead.
REM
REM  Close orb first - it rewrites state when it exits.
REM ============================================================

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

cls
echo ============================================================
echo   Orb Orb - memory reset  (preview first)
echo ============================================================
echo.
"%NODE%" tools\reset-to-factory.mjs --memory-only --force
echo.
echo ============================================================
echo   The above is only a PREVIEW - nothing has been changed yet.
echo ============================================================
echo.
echo   Close orb BEFORE applying, or it will rewrite state on exit.
echo.
set "OK="
set /p OK="type yes then Enter to really clear memory: "
if /i not "%OK%"=="yes" (
  echo.
  echo   cancelled - nothing changed.
  pause
  exit /b 0
)
echo.
"%NODE%" tools\reset-to-factory.mjs --memory-only --apply
echo.
pause
