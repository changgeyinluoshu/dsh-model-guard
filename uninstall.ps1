<#
.SYNOPSIS
  卸载 dsh-model-guard，把 profile 还原到安装前的状态。

.DESCRIPTION
  只移除由 install.ps1 生成的内容：
    1. cordis.patch.yml 里两个 managed 标记之间的块；
    2. node_modules\dsh-model-guard 目录联接。
  不会动 profile 里的任何其它配置，执行前自动备份。
#>
[CmdletBinding()]
param(
  [string]$ProfilePath = "$env:USERPROFILE\.dsh-beta\profiles\desktop"
)

$ErrorActionPreference = 'Stop'
$PackageName = 'dsh-model-guard'
$BeginMark = '# >>> dsh-model-guard managed block >>>'
$EndMark = '# <<< dsh-model-guard managed block <<<'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Read-Text([string]$path) { return [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8) }
function Write-Text([string]$path, [string]$text) { [System.IO.File]::WriteAllText($path, $text, $Utf8NoBom) }

Write-Host ""
Write-Host "=== 卸载 $PackageName ===" -ForegroundColor White

$patchFile = Join-Path $ProfilePath 'cordis.patch.yml'
if (Test-Path $patchFile) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  Copy-Item $patchFile "$patchFile.bak-$stamp-uninstall" -Force
  Write-Host "  [OK] 已备份补丁层" -ForegroundColor Green

  $raw = Read-Text $patchFile
  if ($raw -match [regex]::Escape($BeginMark)) {
    $pattern = "(?s)" + [regex]::Escape($BeginMark) + ".*?" + [regex]::Escape($EndMark) + "\r?\n?"
    $cleaned = [regex]::Replace($raw, $pattern, '')
    Write-Text $patchFile $cleaned
    Write-Host "  [OK] 已移除 cordis.patch.yml 里的 managed block" -ForegroundColor Green
  } else {
    Write-Host "  [i] 补丁层里没有 managed block，跳过" -ForegroundColor DarkGray
  }
}

$linkPath = Join-Path (Join-Path $ProfilePath 'node_modules') $PackageName
if (Test-Path $linkPath) {
  $item = Get-Item $linkPath -Force
  if (($item.LinkType -eq 'Junction') -or ($item.LinkType -eq 'SymbolicLink')) {
    Remove-Item $linkPath -Force -Recurse
    Write-Host "  [OK] 已移除目录联接" -ForegroundColor Green
  } else {
    Write-Host "  [!] $linkPath 是真实目录，未自动删除" -ForegroundColor Yellow
  }
} else {
  Write-Host "  [i] 目录联接不存在，跳过" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "=== 卸载完成，重启 DSH 生效 ===" -ForegroundColor Green
Write-Host ""
