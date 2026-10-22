@echo off
rem Rebuild Orb.exe (the double-click launcher shipped in the factory package).
rem Pure ASCII on purpose: cmd.exe decodes batch files with the OEM codepage (GBK here),
rem and non-ASCII bytes can swallow the rest of a line.
rem Needs nothing but Windows itself: csc.exe ships with .NET Framework 4.x.
rem The icon is the project's own tray icon (helper\assets\tray.ico).
setlocal
chcp 65001 >nul
cd /d "%~dp0"

set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%CSC%" (
  echo [build-launcher] csc.exe not found - install .NET Framework 4.x
  exit /b 1
)

set ICON=..\..\helper\assets\tray.ico
if not exist "%ICON%" (
  echo [build-launcher] missing icon: %ICON%  ^(run tools\make_tray_icon.py first^)
  exit /b 1
)

"%CSC%" /nologo /target:winexe /platform:anycpu /optimize+ /win32icon:"%ICON%" ^
  /out:Orb.exe /r:System.Windows.Forms.dll /r:System.Drawing.dll OrbLauncher.cs
if errorlevel 1 (
  echo [build-launcher] FAILED
  exit /b 1
)

for %%F in (Orb.exe) do echo [build-launcher] OK  %%~zF bytes  -^>  %CD%\Orb.exe
endlocal
