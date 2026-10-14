@echo off
rem dsh-model-guard 卸载包装器：把 profile 还原到安装前。
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
set EXITCODE=%ERRORLEVEL%
if not "%EXITCODE%"=="0" (
  echo.
  echo 卸载失败，退出码 %EXITCODE%
)
endlocal & exit /b %EXITCODE%
