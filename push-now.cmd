@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   dsh-model-guard  推送到 GitHub
echo   目标: https://github.com/changgeyinluoshu/dsh-model-guard
echo ============================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0publish-to-github.ps1" -GitHubUser changgeyinluoshu -RemoteUrl "https://github.com/changgeyinluoshu/dsh-model-guard.git" -Push -Force
set EXITCODE=%ERRORLEVEL%
echo.
if "%EXITCODE%"=="0" (
  echo [完成] 已推送，去浏览器刷新看看: https://github.com/changgeyinluoshu/dsh-model-guard
) else (
  echo [失败] 退出码 %EXITCODE%。上面的输出里有原因；若弹出 GitHub 登录窗口，请完成登录后重跑本文件。
)
echo.
if not defined DSH_NO_PAUSE pause
endlocal & exit /b %EXITCODE%
