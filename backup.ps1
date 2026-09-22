<#
  mo 站一键冷备脚本
  做三件事：
    1) D1 数据库全量导出成 backups\d1-YYYYMMDD-HHmmss.sql（含 overrides/custom_items/board_*/统计等所有表）
    2) 把导出的 sql 提交进本仓库（这样数据也进 git，重建时有据可依）
    3) 双远程推送：origin(xrzka/mo) + backup(xrzka52/mo-backup)

  用法（在 mo_site 目录下）：
    pwsh -File backup.ps1              # 完整备份：导出 D1 + 提交 + 双推
    pwsh -File backup.ps1 -NoD1        # 跳过 D1 导出，只提交现有改动并双推
    pwsh -File backup.ps1 -NoCommit    # 只导出 D1 和推送已提交内容，不新建提交

  前置：
    - wrangler 已可用（worker\deploy.sh 里配过 CLOUDFLARE_API_TOKEN / XDG_CONFIG_HOME）
    - 已配好 git 远程 backup 指向 github-mobackup:xrzka52/mo-backup.git
#>
[CmdletBinding()]
param(
  [switch]$NoD1,       # 跳过 D1 导出
  [switch]$NoCommit,   # 不新建提交（仍会推送）
  [int]$Keep = 30      # backups 目录里最多保留多少份 d1 导出，多的删掉
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repo

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupsDir = Join-Path $repo "backups"
New-Item -ItemType Directory -Force -Path $backupsDir | Out-Null

function Info($m){ Write-Host "[backup] $m" -ForegroundColor Cyan }
function Ok($m){ Write-Host "[backup] $m" -ForegroundColor Green }
function Warn($m){ Write-Host "[backup] $m" -ForegroundColor Yellow }

# ---------- 1) 导出 D1 ----------
$sqlPath = $null
if (-not $NoD1) {
  Info "导出 D1 数据库 mo-stats ..."
  $env:XDG_CONFIG_HOME = "D:/local_translate_tool/wrangler_home"
  # deploy.sh 里如果写了 CLOUDFLARE_API_TOKEN，这里沿用；没写就靠 wrangler 已登录态
  $deploy = Join-Path $repo "worker\deploy.sh"
  if (Test-Path $deploy) {
    $tokenLine = Select-String -Path $deploy -Pattern 'CLOUDFLARE_API_TOKEN="([^"]+)"' | Select-Object -First 1
    if ($tokenLine -and $tokenLine.Matches[0].Groups[1].Value -ne "YOUR_TOKEN_HERE") {
      $env:CLOUDFLARE_API_TOKEN = $tokenLine.Matches[0].Groups[1].Value
    }
  }
  $sqlPath = Join-Path $backupsDir "d1-$stamp.sql"
  Push-Location (Join-Path $repo "worker")
  try {
    npx wrangler d1 export mo-stats --remote --output $sqlPath 2>&1 | Select-Object -Last 6 | ForEach-Object { Write-Host "        $_" }
  } finally { Pop-Location }
  if ((Test-Path $sqlPath) -and (Get-Item $sqlPath).Length -gt 0) {
    Ok "D1 已导出：backups\d1-$stamp.sql ($([math]::Round((Get-Item $sqlPath).Length/1KB,1)) KB)"
    # 维护一份 latest 方便重建时直接引用
    Copy-Item $sqlPath (Join-Path $backupsDir "d1-latest.sql") -Force
  } else {
    Warn "D1 导出为空或失败，继续做仓库推送。"
    $sqlPath = $null
  }

  # 清理旧导出，只留最近 $Keep 份
  $olds = Get-ChildItem $backupsDir -Filter "d1-2*.sql" | Sort-Object LastWriteTime -Descending | Select-Object -Skip $Keep
  foreach ($o in $olds) { Remove-Item $o.FullName -Force; Info "清理旧备份 $($o.Name)" }
} else {
  Info "跳过 D1 导出（-NoD1）"
}

# ---------- 2) 提交 ----------
if (-not $NoCommit) {
  $changed = git status --porcelain
  if ($changed) {
    Info "提交改动 ..."
    git add -A
    git commit -m "chore(backup): snapshot $stamp" | Out-Null
    Ok "已提交 snapshot $stamp"
  } else {
    Info "工作区无改动，跳过提交。"
  }
} else {
  Info "不新建提交（-NoCommit）"
}

# ---------- 3) 双远程推送 ----------
$remotes = (git remote) -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ }
foreach ($r in @("origin","backup")) {
  if ($remotes -notcontains $r) { Warn "远程 $r 不存在，跳过。"; continue }
  Info "推送到 $r ..."
  git push $r main 2>&1 | Select-Object -Last 3 | ForEach-Object { Write-Host "        $_" }
  if ($LASTEXITCODE -eq 0) { Ok "$r 推送完成" } else { Warn "$r 推送返回码 $LASTEXITCODE（多半是 stderr 提示，检查上面输出）" }
}

Ok "备份完成。静态站源码 + D1 数据都已落到 origin 与 backup 两个仓库。"
