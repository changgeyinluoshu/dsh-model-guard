<#
.SYNOPSIS
  用 GitHub Personal Access Token 推送，完全不依赖凭据管理器弹窗。

.DESCRIPTION
  适用场景：双击 push-now.cmd 后登录窗口没出现、或登录始终完不成。
  token 只在本次推送的 URL 里使用，推送结束后立刻从 remote 里移除，不会留在配置中。

.PARAMETER Token
  GitHub Personal Access Token。不传则交互式输入（输入时不回显）。

.EXAMPLE
  .\push-with-token.ps1
  # 按提示粘贴 token
#>
[CmdletBinding()]
param(
  [string]$Token = '',
  [string]$RemoteUrl = 'https://github.com/changgeyinluoshu/dsh-model-guard.git',
  [string]$User = 'changgeyinluoshu'
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
if ([string]::IsNullOrEmpty($root)) { $root = Split-Path -Parent $MyInvocation.MyCommand.Path }
if ([string]::IsNullOrEmpty($root)) { $root = (Get-Location).Path }
Set-Location $root

Write-Host ''
Write-Host '=== 用 Token 推送到 GitHub ===' -ForegroundColor White
Write-Host ''

if ([string]::IsNullOrEmpty($Token)) {
  $tokenPage = 'https://github.com/settings/tokens/new?scopes=repo&description=dsh-model-guard'
  Write-Host '第 1 步：浏览器里点最下面的 Generate token，复制那一串 ghp_ 开头的字符' -ForegroundColor Yellow
  Write-Host '第 2 步：回到这个窗口，粘贴后回车（粘贴时屏幕上不会显示，这是正常的）' -ForegroundColor Yellow
  Write-Host ''
  Write-Host ("正在打开: " + $tokenPage) -ForegroundColor DarkGray
  try { Start-Process $tokenPage } catch { Write-Host '  （浏览器没能自动打开，请手动访问上面的地址）' -ForegroundColor DarkGray }
  Write-Host ''
  $secure = Read-Host -Prompt '请粘贴 Token 后回车' -AsSecureString
  $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $Token = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr) }
  finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

$Token = $Token.Trim()
if ([string]::IsNullOrEmpty($Token)) { Write-Host '  [X] 没有输入 token' -ForegroundColor Red; exit 1 }
if ($Token -notmatch '^(ghp_|github_pat_)') {
  Write-Host '  [!] 这个值不像 GitHub token（通常以 ghp_ 或 github_pat_ 开头），仍然继续尝试' -ForegroundColor Yellow
}

# 带凭据的地址只用于本次推送；用拼接避开反引号转义
$bare = $RemoteUrl -replace '^https://', ''
$pushUrl = 'https://' + $User + ':' + $Token + '@' + $bare
$plain = $RemoteUrl

Write-Host ''
Write-Host '  推送中（可能要几十秒）…' -ForegroundColor Cyan
$code = 1
try {
  & git push $pushUrl 'main:main' --force 2>&1 | ForEach-Object { Write-Host "    $_" }
  $code = $LASTEXITCODE
} finally {
  # 无论成败，都把 token 从 remote 配置里清掉
  $existing = ''
  try { $existing = (& git remote get-url origin 2>$null) } catch { $existing = '' }
  if ($existing) { & git remote set-url origin $plain 2>$null } else { & git remote add origin $plain 2>$null }
}

Write-Host ''
if ($code -eq 0) {
  Write-Host '=== 推送成功 ===' -ForegroundColor Green
  Write-Host "  去看: $plain" -ForegroundColor White
  Write-Host '  已把 token 从 remote 地址里移除。' -ForegroundColor DarkGray
} else {
  Write-Host "=== 推送失败（退出码 $code）===" -ForegroundColor Red
  Write-Host '  常见原因：' -ForegroundColor Yellow
  Write-Host '    - token 没有 repo 权限，或已过期' -ForegroundColor Yellow
  Write-Host '    - token 复制时带了空格或换行' -ForegroundColor Yellow
  Write-Host '    - 网络到 github.com 不通' -ForegroundColor Yellow
}
Write-Host ''
exit $code
