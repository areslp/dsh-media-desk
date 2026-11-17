<#
把本地 fork 的构建产物同步到 DSH profile。

profile 里的插件是用 `pnpm add dsh-media-desk@file:<repo>` 装的，pnpm 装成了**拷贝**
（不是软链），所以改完代码必须重新同步一次，否则跑的还是旧文件。

用法：
  powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1              # 先构建，再同步
  powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1 -SkipBuild   # 只同步（client 没改时省时间）

同步完记得让插件重新加载：DSH 里把 dsh-media-desk 关掉再打开（不用重启整个 app）。
如果 dist/client.js 被占用（host 正在对外提供它），先关插件再跑这个脚本。
#>
param(
  [string]$Profile = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop'),
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$target = Join-Path $Profile 'node_modules\dsh-media-desk'

if (-not (Test-Path $target)) {
  throw "没找到已安装的插件：$target`n先装一次：pnpm add dsh-media-desk@file:$repo --dir `"$Profile`""
}

if (-not $SkipBuild) {
  Write-Host "构建 client bundle ..."
  Push-Location $repo
  try { npm run build } finally { Pop-Location }
}

Write-Host "同步 src / dist / package.json 到 $target"

# 插件正在运行时，Windows 会锁住已加载的模块：原地覆盖会失败，但「先写新文件再改名覆盖」可以，
# 而且正在运行的进程继续用旧内容，不会被打断。
function Copy-WithRetry {
  param([string]$From, [string]$To, [int]$Tries = 10)
  $staged = "$To.new"
  for ($i = 0; $i -lt $Tries; $i++) {
    try {
      Copy-Item $From $staged -Force -ErrorAction Stop
      Move-Item $staged $To -Force -ErrorAction Stop
      return $true
    } catch {
      Remove-Item $staged -Force -ErrorAction SilentlyContinue
      Start-Sleep -Milliseconds 300
    }
  }
  return $false
}

$locked = @()
Get-ChildItem (Join-Path $repo 'src') -Filter '*.js' | ForEach-Object {
  if (-not (Copy-WithRetry $_.FullName (Join-Path (Join-Path $target 'src') $_.Name))) { $locked += $_.Name }
}
if (-not (Copy-WithRetry (Join-Path $repo 'package.json') (Join-Path $target 'package.json'))) { $locked += 'package.json' }
if (-not (Copy-WithRetry (Join-Path $repo 'dist\client.js') (Join-Path $target 'dist\client.js'))) { $locked += 'dist/client.js' }

if ($locked.Count) {
  Write-Host "这些文件被占用，没同步成功：" -ForegroundColor Yellow
  $locked | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
  Write-Host "在 DSH 里把 dsh-media-desk 关掉（插件页或侧栏开关），再跑一次："
  Write-Host "  powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1 -SkipBuild"
  exit 1
}

# 校验：以 md5 为准，不看 Copy-Item 的报错（Windows 上偶尔误报占用但内容已写入）
$problems = @()
Get-ChildItem (Join-Path $repo 'src') -Filter '*.js' | ForEach-Object {
  $dst = Join-Path (Join-Path $target 'src') $_.Name
  if (-not (Test-Path $dst)) { $problems += "缺文件 $($_.Name)" }
  elseif ((Get-FileHash $_.FullName -Algorithm MD5).Hash -ne (Get-FileHash $dst -Algorithm MD5).Hash) { $problems += "内容不一致 $($_.Name)" }
}
if ((Get-FileHash (Join-Path $repo 'dist\client.js') -Algorithm MD5).Hash -ne (Get-FileHash (Join-Path $target 'dist\client.js') -Algorithm MD5).Hash) {
  $problems += 'client bundle 内容不一致'
}

if ($problems.Count) {
  Write-Host "同步有问题：" -ForegroundColor Red
  $problems | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
  exit 1
}

Write-Host "同步完成，全部 md5 一致。" -ForegroundColor Green
Write-Host "现在到 DSH 里把 dsh-media-desk 关掉再打开；只改了 client 的话刷新页面即可。"
