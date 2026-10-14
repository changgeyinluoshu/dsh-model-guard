@echo off
rem dsh-model-guard 安装包装器。
rem 直接双击或用命令行调用均可；绕过 PowerShell 执行策略，参数原样透传。
rem 例：install.cmd -BlockedProviders nvida -Scope auto
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set EXITCODE=%ERRORLEVEL%
if not "%EXITCODE%"=="0" (
  echo.
  echo 安装失败，退出码 %EXITCODE%
)
endlocal & exit /b %EXITCODE%
