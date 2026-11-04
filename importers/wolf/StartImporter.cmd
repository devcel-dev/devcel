@echo off
setlocal
powershell.exe -NoLogo -NoProfile -File "%~dp0Tools\StartImporter.ps1"
if errorlevel 1 pause
