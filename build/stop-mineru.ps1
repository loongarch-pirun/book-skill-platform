# stop-mineru.ps1 — 卸载时停掉随包 MinerU 的 doclib 进程（由 build/installer.nsh 调用）
#
# 为什么不能按进程名一刀切：用户机器上可能同时跑着**他自己的** doclib
# （系统 python，~/.mineru，standard 档）。按 python.exe 全杀会误伤别人的服务。
#
# 两道，从精确到兜底：
#   1. 读随包 home 下的 doclib.endpoint.json，里面的 pid 就是随包 doclib 自己的进程号，
#      整个进程树（含它拉起的 managed parse-server 子进程）一起停——不用猜路径。
#   2. 兜底：endpoint.json 丢了/过期了，才退到「exe 路径落在 $InstallDir\runtime\mineru-python
#      下的 python.exe」。用户自己的 python 不在这个前缀里，仍然不会误杀。
#
# 只负责停进程，不删任何东西——删目录是 installer.nsh 的活。但必须先停：
# doclib 锁着 mineru-home\doclib 下的缓存，不停就 RMDir 不掉，装一次留一份几百 MB。
param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][string]$HomeDir
)

$ErrorActionPreference = 'SilentlyContinue'
$stopped = @()

# ---- 1. 按 endpoint.json 里的 pid 停整棵树 ----
$epFile = Join-Path $HomeDir 'doclib.endpoint.json'
if (Test-Path -LiteralPath $epFile) {
  $rootPid = $null
  try { $rootPid = (Get-Content -LiteralPath $epFile -Raw | ConvertFrom-Json).pid } catch { }
  if ($rootPid) {
    $tree = @($rootPid)
    # 广度优先收集子孙进程（doclib → managed parse-server）
    for ($i = 0; $i -lt $tree.Count -and $tree.Count -lt 64; $i++) {
      $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($tree[$i])" |
        Select-Object -ExpandProperty ProcessId
      foreach ($c in $children) { if ($tree -notcontains $c) { $tree += $c } }
    }
    # 先子孙后父，避免父先死导致子进程被 reparent 抓不到
    [array]::Reverse($tree)
    foreach ($procId in $tree) {
      $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
      if ($p) {
        # 只停 python（及同名前缀的可执行），绝不对别的进程号动手
        if ($p.ProcessName -like 'python*') {
          Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
          $stopped += $procId
        }
      }
    }
  }
}

# ---- 2. 兜底：按随包 python 的 exe 路径前缀扫 ----
$prefix = (Join-Path $InstallDir 'runtime\mineru-python').TrimEnd('\')
foreach ($p in Get-CimInstance Win32_Process -Filter "Name='python.exe'") {
  $exe = $p.ExecutablePath
  if ($exe -and $exe.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    $stopped += $p.ProcessId
  }
}

# 句柄释放有延迟，给安装器一点时间再删目录
if ($stopped.Count -gt 0) { Start-Sleep -Milliseconds 800 }
