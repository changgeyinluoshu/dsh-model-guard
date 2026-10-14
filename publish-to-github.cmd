@echo off
rem dsh-model-guard 发布包装器：绕过 PowerShell 执行策略，参数原样透传。
rem 用法：publish-to-github.cmd -GitHubUser 你的用户名 [-Push]
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0publish-to-github.ps1" %*
set EXITCODE=%ERRORLEVEL%
endlocal & exit /b %EXITCODE%
