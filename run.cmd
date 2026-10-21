@echo off
chcp 65001 >nul
cd /d "%~dp0"
node src\launch.mjs
if errorlevel 1 pause
