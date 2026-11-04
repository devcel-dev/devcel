@echo off
setlocal DisableDelayedExpansion
rem The shared script validates PowerShell 7. Do not change execution policy or associations.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -File "%~dp0build-all-windows.ps1" %*
set "DEVCEL_BUILD_EXIT=%ERRORLEVEL%"
echo.
echo Command exited with code %DEVCEL_BUILD_EXIT%.
echo A cancelled folder selection performs no build. For completed builds, see build_summary.txt in the output folder.
pause
exit /b %DEVCEL_BUILD_EXIT%
