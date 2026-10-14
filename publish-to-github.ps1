<#
.SYNOPSIS
  把 dsh-model-guard 仓库发布到你的 GitHub。

.DESCRIPTION
  一条命令完成四件事：
    1. 把 package.json / README.md 里的 <你的账号>、<你的名字> 占位符换成你的信息；
    2. 配置**只属于这个仓库**的 git 身份（不动你的全局配置）；
    3. 把首次提交的作者改写成你的身份（--reset-author）；
    4. 配好 origin remote，-Push 时直接推送。

  这台机器已有系统级 credential.helper=manager，推送时 Git Credential Manager
  会弹窗让你登录 GitHub，不需要手工输入 token。

.PARAMETER GitHubUser
  你的 GitHub 用户名（必填），例如 octocat。

.PARAMETER RepoName
  GitHub 上的仓库名，默认 dsh-model-guard。请先在 GitHub 上建好这个空仓库
  （不要勾选 README / .gitignore / license，保持全空仓库最省事）。

.PARAMETER DisplayName
  提交作者显示名，默认与 GitHubUser 相同。

.PARAMETER Email
  提交邮箱，默认 <GitHubUser>@users.noreply.github.com（不暴露真实邮箱）。

.PARAMETER RemoteUrl
  自定义远程地址。默认 https://github.com/<GitHubUser>/<RepoName>.git；
  想推到 Gitee 等其它托管时用它覆盖，例如
  -RemoteUrl https://gitee.com/你的用户名/dsh-model-guard.git

.PARAMETER Push
  加了这个开关才会真正推送。

.EXAMPLE
  .\publish-to-github.ps1 -GitHubUser octocat
  # 先只做本地准备，检查无误后再推

.EXAMPLE
  .\publish-to-github.ps1 -GitHubUser octocat -Push
  # 一步到位：替换占位符 + 改作者 + 配 remote + 推送
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$GitHubUser,
  [string]$RepoName = 'dsh-model-guard',
  [string]$DisplayName = '',
  [string]$Email = '',
  [string]$RemoteUrl = '',
  [switch]$Push
)

$ErrorActionPreference = 'Stop'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Read-Text([string]$p) { return [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8) }
function Write-Text([string]$p, [string]$t) { [System.IO.File]::WriteAllText($p, $t, $Utf8NoBom) }
function Ok([string]$m) { Write-Host "  [OK] $m" -ForegroundColor Green }
function Info([string]$m) { Write-Host "  [i] $m" -ForegroundColor DarkGray }
function Warn2([string]$m) { Write-Host "  [!] $m" -ForegroundColor Yellow }

# $PSScriptRoot 在 param 默认值里可能为空，正文里再解析
$root = $PSScriptRoot
if ([string]::IsNullOrEmpty($root)) { $root = Split-Path -Parent $MyInvocation.MyCommand.Path }
if ([string]::IsNullOrEmpty($root)) { $root = (Get-Location).Path }
Set-Location $root

if ($GitHubUser -notmatch '^[A-Za-z0-9][A-Za-z0-9-]*$') {
  throw "GitHub 用户名不合法：$GitHubUser（只允许字母、数字和连字符）"
}
if ([string]::IsNullOrEmpty($DisplayName)) { $DisplayName = $GitHubUser }
if ([string]::IsNullOrEmpty($Email)) { $Email = "$GitHubUser@users.noreply.github.com" }
if (-not (Test-Path (Join-Path $root '.git'))) { throw "这里不是 git 仓库：$root" }

Write-Host ''
Write-Host "=== 发布 dsh-model-guard 到 github.com/$GitHubUser/$RepoName ===" -ForegroundColor White
Write-Host ''

# ---- 1. 替换占位符 ----
$pkgPath = Join-Path $root 'package.json'
$pkg = Read-Text $pkgPath
if ($pkg -notmatch [regex]::Escape('<你的账号>') -and $pkg -notmatch [regex]::Escape('<你的名字>')) {
  Info 'package.json 里没有待替换的占位符（可能已经替换过）'
} else {
  $pkg = $pkg.Replace('<你的账号>', $GitHubUser).Replace('<你的名字>', $DisplayName)
  Write-Text $pkgPath $pkg
  Ok "package.json 占位符已替换为 $GitHubUser"
}

foreach ($rel in @('README.md', 'cordis.patch.yml')) {
  $p = Join-Path $root $rel
  if (-not (Test-Path $p)) { continue }
  $text = Read-Text $p
  if ($text -match [regex]::Escape('<你的账号>')) {
    Write-Text $p $text.Replace('<你的账号>', $GitHubUser)
    Ok "$rel 占位符已替换"
  }
}

# ---- 2. 仓库级 git 身份 ----
git config --local user.name $DisplayName
git config --local user.email $Email
Ok "已配置本仓库 git 身份：$DisplayName <$Email>"

# ---- 3. 提交（首次提交改写作者，之后正常新增）----
# 注意：$ErrorActionPreference='Stop' 时，外部命令往 stderr 写东西会变成
# NativeCommandError 并中断脚本（比如 origin 还不存在时 git remote get-url 的报错）。
# 这类"探测型"调用一律用 try/catch 包住。
function Invoke-Git([string[]]$Arguments) {
  try { return (& git @Arguments 2>$null) } catch { return $null }
}

$hasChanges = (git status --porcelain | Measure-Object).Count -gt 0
$commitCount = 0
$countText = Invoke-Git @('rev-list', '--count', 'HEAD')
if ($countText) { $commitCount = [int]$countText }
if ($commitCount -le 1 -and -not $hasChanges) {
  git add -A
  git commit -q --amend --reset-author --no-edit
  Ok '首次提交的作者已改写为你的身份'
} else {
  git add -A
  if ($hasChanges) {
    git commit -q -m "chore: 发布准备（替换仓库元数据）"
    Ok '已提交占位符替换'
  } else {
    Info '没有需要提交的改动'
  }
}

# ---- 4. remote ----
if ([string]::IsNullOrEmpty($RemoteUrl)) { $RemoteUrl = "https://github.com/$GitHubUser/$RepoName.git" }
$url = $RemoteUrl
$existing = Invoke-Git @('remote', 'get-url', 'origin')
if ($existing) {
  if ($existing -ne $url) { git remote set-url origin $url; Ok "origin 已更新为 $url" }
  else { Ok "origin 已正确：$url" }
} else {
  git remote add origin $url
  Ok "已添加 origin：$url"
}

# ---- 5. 推送 ----
if ($Push) {
  Write-Host ''
  Info '开始推送（若弹出登录窗口，请用浏览器完成 GitHub 登录）…'
  git push -u origin main
  if ($LASTEXITCODE -ne 0) {
    Warn2 '推送失败。常见原因：GitHub 上还没有这个仓库，或登录未完成。'
    Warn2 "请确认已在 https://github.com/new 建好空仓库 $RepoName（不要初始化 README），然后重跑本脚本加 -Push。"
    exit 1
  }
  Ok "推送成功：https://github.com/$GitHubUser/$RepoName"
} else {
  Write-Host ''
  Write-Host '本地准备完成。下一步执行：' -ForegroundColor White
  Write-Host "  git push -u origin main" -ForegroundColor Cyan
  Write-Host ''
  Info "推送前请先在 https://github.com/new 建好空仓库 $RepoName（不要勾选 README/.gitignore/license）"
}

Write-Host ''
