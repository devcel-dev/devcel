@echo off
REM No ExecutionPolicy bypass: honor the machine's script/security settings.
powershell.exe -NoProfile -File "%~dp0importer.ps1" %*
if errorlevel 1 pause
