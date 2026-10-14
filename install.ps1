<#
.SYNOPSIS
  把 dsh-model-guard（模型调用守卫）安装进 DSH 桌面端的 profile。

.DESCRIPTION
  安装动作只有两处，都可一键回滚：
    1. 在 <ProfilePath>\node_modules 下建立指向本仓库的目录联接（Junction）；
    2. 在 <ProfilePath>\cordis.patch.yml 末尾追加一个带标记的 managed block
       （两个标记之间的内容由本脚本负责增删，不会碰已有配置）。
  所有文件读写都走 .NET 的 UTF-8 API，避免 Windows PowerShell 代码页破坏中文注释。
  改写前会自动备份 cordis.patch.yml。

.PARAMETER Mode
  命中后的动作：block（拦截）/ redirect（改道）/ warn（仅告警）。

.PARAMETER Scope
  all = 拦截一切调用；auto = 只拦自动调用（上下文压缩、会话标题生成）。

.EXAMPLE
  # 最常用：禁止后台自动调用走 nvida 渠道，用户手动选用时仍然可用
  .\install.ps1 -BlockedProviders nvida -Scope auto

.EXAMPLE
  # 彻底禁止某个模型被任何流程调用
  .\install.ps1 -Scope all -BlockedModels 'deepseek-ai/deepseek-v4.1-flash'
#>
[CmdletBinding()]
param(
  [string]$ProfilePath = "$env:USERPROFILE\.dsh-beta\profiles\desktop",
  [string]$SourcePath = '',
  [ValidateSet('block', 'redirect', 'warn')][string]$Mode = 'block',
  [ValidateSet('all', 'auto')][string]$Scope = 'auto',
  [string[]]$BlockedProviders = @(),
  [string[]]$BlockedModels = @(),
  [string[]]$BlockedPurposes = @(),
  [string]$FallbackProvider = '',
  [string]$FallbackModel = '',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

# $PSScriptRoot 在 param 默认值里可能是空的（PowerShell 求值时机），在此补齐。
if ([string]::IsNullOrEmpty($SourcePath)) { $SourcePath = $PSScriptRoot }
if ([string]::IsNullOrEmpty($SourcePath)) { $SourcePath = Split-Path -Parent $MyInvocation.MyCommand.Path }
if ([string]::IsNullOrEmpty($SourcePath)) { $SourcePath = (Get-Location).Path }

$PackageName = 'dsh-model-guard'
$BeginMark = '# >>> dsh-model-guard managed block >>>'
$EndMark = '# <<< dsh-model-guard managed block <<<'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Read-Text([string]$path) { return [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8) }
function Write-Text([string]$path, [string]$text) { [System.IO.File]::WriteAllText($path, $text, $Utf8NoBom) }

# PowerShell 读回目录联接的 Target 时可能带 '\??\' 或 'Global\' 前缀，直接字符串比较会误判。
function Test-SamePath([string]$left, [string]$right) {
  if ([string]::IsNullOrEmpty($left) -or [string]::IsNullOrEmpty($right)) { return $false }
  $a = $left -replace '^\\\\\?\\', '' -replace '^Global\\', ''
  $b = $right -replace '^\\\\\?\\', '' -replace '^Global\\', ''
  try {
    $fa = [System.IO.Path]::GetFullPath($a).TrimEnd('\')
    $fb = [System.IO.Path]::GetFullPath($b).TrimEnd('\')
    return ($fa -ieq $fb)
  } catch { return $false }
}
function Write-Step($text) { Write-Host "  $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "  [OK] $text" -ForegroundColor Green }
function Write-Note($text) { Write-Host "  [!] $text" -ForegroundColor Yellow }

Write-Host ""
Write-Host "=== 安装 $PackageName ===" -ForegroundColor White
Write-Host ""

# ---- 1. 前置校验 ----
$manifestPath = Join-Path $SourcePath 'package.json'
if (-not (Test-Path $manifestPath)) { throw "源目录不对：$SourcePath 下没有 package.json" }
$manifest = (Read-Text $manifestPath) | ConvertFrom-Json
if ($manifest.name -ne $PackageName) { throw "源目录的 package.json 里 name 是 '$($manifest.name)'，期望 '$PackageName'" }
Write-Ok "源目录校验通过：$SourcePath"

if (-not (Test-Path $ProfilePath)) { throw "找不到 profile 目录：$ProfilePath" }
$patchFile = Join-Path $ProfilePath 'cordis.patch.yml'
if (-not (Test-Path $patchFile)) { throw "找不到补丁层文件：$patchFile" }
Write-Ok "profile 校验通过：$ProfilePath"

# ---- 2. 建立目录联接 ----
$nodeModules = Join-Path $ProfilePath 'node_modules'
if (-not (Test-Path $nodeModules)) { New-Item -ItemType Directory -Path $nodeModules -Force | Out-Null }
$linkPath = Join-Path $nodeModules $PackageName

if (Test-Path $linkPath) {
  $item = Get-Item $linkPath -Force
  $isLink = ($item.LinkType -eq 'Junction') -or ($item.LinkType -eq 'SymbolicLink')
  $pointsHere = $false
  foreach ($target in @($item.Target)) { if (Test-SamePath $target $SourcePath) { $pointsHere = $true } }
  if ($isLink -and $pointsHere) {
    Write-Ok "目录联接已存在且指向正确"
  } elseif ($isLink -and $Force) {
    Remove-Item $linkPath -Force -Recurse
    New-Item -ItemType Junction -Path $linkPath -Target $SourcePath | Out-Null
    Write-Ok "已重建目录联接"
  } elseif ($isLink) {
    throw "已存在 $linkPath（指向 $($item.Target)），与本仓库不符；确认后用 -Force 重建。"
  } else {
    throw "已存在真实目录 $linkPath；请先自行备份并移走它。"
  }
} else {
  New-Item -ItemType Junction -Path $linkPath -Target $SourcePath | Out-Null
  Write-Ok "已建立目录联接：$linkPath"
}

# ---- 3. 备份补丁层 ----
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = "$patchFile.bak-$stamp-$PackageName"
Copy-Item $patchFile $backup -Force
Write-Ok "已备份：$(Split-Path -Leaf $backup)"

# ---- 4. 写入 managed block（幂等）----
$raw = Read-Text $patchFile
if ($raw -match [regex]::Escape($BeginMark)) {
  Write-Note "补丁层里已有 managed block，先移除旧块再写入新块"
  $pattern = "(?s)" + [regex]::Escape($BeginMark) + ".*?" + [regex]::Escape($EndMark) + "\r?\n?"
  $raw = [regex]::Replace($raw, $pattern, '')
}

function Format-YamlList([string]$name, [string[]]$values) {
  if ($null -eq $values -or $values.Count -eq 0) { return "        " + $name + ": []" }
  $lines = @("        " + $name + ":")
  foreach ($value in $values) { $lines += "          - '" + $value + "'" }
  return ($lines -join "`n")
}

$nl = [Environment]::NewLine
$block = @"
$BeginMark
# 本段由 install.ps1 生成。要增删请用 install.ps1 / uninstall.ps1，不要手改中间内容。
- insert:
    - id: model-guard
      name: '$PackageName'
      config:
        enabled: true
        mode: $Mode
        scope: $Scope
$(Format-YamlList 'blockedProviders' $BlockedProviders)
$(Format-YamlList 'blockedModels' $BlockedModels)
$(Format-YamlList 'blockedPurposes' $BlockedPurposes)
        allowedProviders: []
        allowedModels: []
        fallback:
          provider: '$FallbackProvider'
          model: '$FallbackModel'
        rules: []
        autoPurposes:
          - compaction
          - session-title
        log: true
        blockMessage: ''
$EndMark
"@

$content = $raw.TrimEnd() + $nl + $block
Write-Text $patchFile $content
Write-Ok "已写入 managed block（mode=$Mode, scope=$Scope）"

# ---- 5. 校验 YAML 仍可解析 ----
$checkScript = @'
const { createRequire } = require('node:module')
const fs = require('node:fs')
// 优先用 profile 自带的 yaml 包；没有就回退到 DSH 应用自带的。都没有才跳过校验。
const candidates = [process.argv[2] + '/', (process.env.DSH_APP_ROOT || 'D:/dsh d/DSH Desktop Beta/resources/app') + '/node_modules/']
let YAML = null
for (const base of candidates) {
  try { YAML = createRequire(base)('yaml'); break } catch { /* 换下一个 */ }
}
if (YAML === null) { console.log('SKIP: 找不到 yaml 包，跳过校验'); process.exit(0) }
const raw = fs.readFileSync(process.argv[3], 'utf8')
const parsed = YAML.parse(raw)
const rows = parsed.filter((e) => e && (e.id === 'model-guard' || (Array.isArray(e.insert) && e.insert.some((i) => i.id === 'model-guard'))))
if (rows.length === 0) { console.error('未找到 model-guard 条目'); process.exit(2) }
console.log('YAML 解析成功：顶层条目 ' + parsed.length + ' 个，model-guard 条目 ' + rows.length + ' 个')
'@
$checkFile = Join-Path $env:TEMP ("dsh-model-guard-check-" + $stamp + ".cjs")
Write-Text $checkFile $checkScript
try {
  $result = & node $checkFile $ProfilePath $patchFile 2>&1
  if ($LASTEXITCODE -ne 0) { throw "YAML 校验失败：$result" }
  Write-Ok $result
} finally {
  Remove-Item $checkFile -Force -ErrorAction SilentlyContinue
}

# ---- 6. 完成 ----
Write-Host ""
Write-Host "=== 安装完成 ===" -ForegroundColor Green
Write-Host ""
Write-Host "接下来："
Write-Host "  1. 重启 DSH 桌面端（插件只在启动时加载）"
Write-Host "  2. 启动日志里应出现：[model-guard] 已启用：mode=$Mode scope=$Scope"
Write-Host "  3. 命中时会打印：[model-guard] 已拦截 provider=... model=... purpose=..."
Write-Host ""
Write-Host "改规则：重跑本脚本（自动替换 managed block），或编辑补丁层里两个标记之间的 config。" -ForegroundColor DarkGray
Write-Host "回滚：  .\uninstall.ps1" -ForegroundColor DarkGray
Write-Host ""
