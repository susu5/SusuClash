$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$caption = 'SusuClash 恢复助手'
function Show-Info([string]$message) { [void][System.Windows.Forms.MessageBox]::Show($message,$caption,'OK','Information') }
try {
  $sessionFile = Join-Path $env:LOCALAPPDATA 'ClashStandalone\recovery-session.json'
  if (-not (Test-Path -LiteralPath $sessionFile)) { Show-Info '没有找到当前 SusuClash 会话。请从开始菜单正常打开 SusuClash，再检查连接。'; exit }
  $session = Get-Content -LiteralPath $sessionFile -Raw | ConvertFrom-Json
  $processInfo = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$session.pid)
  if (-not $processInfo -or $processInfo.ExecutablePath -ne $session.node -or [Math]::Abs((([datetime]$processInfo.CreationDate).ToUniversalTime() - ([datetime]$session.startedAt).ToUniversalTime()).TotalSeconds) -gt 10) { throw '无法确认原客户端身份。' }
  $target = [uri]$session.url
  if ($target.Scheme -ne 'http' -or $target.Host -ne '127.0.0.1' -or $target.AbsolutePath -notmatch '^/[A-Za-z0-9_-]{32}/$') { throw '本机恢复入口无法确认。' }
  $answer = [System.Windows.Forms.MessageBox]::Show('将保存本次记录，正常关闭并重新打开 SusuClash。代理会短暂中断。请先保存其他应用中正在进行的工作。是否继续？',$caption,'YesNo','Question')
  if ($answer -ne 'Yes') { exit }
  $headers = @{ Origin = $target.GetLeftPart([System.UriPartial]::Authority) }
  $plan = Invoke-RestMethod -Uri ($session.url + 'api/doctor/preview') -Method Post -Headers $headers -ContentType 'application/json' -Body '{"kind":"client-restart"}' -TimeoutSec 8
  $payload = @{ id=$plan.plan.id;confirmed=$true } | ConvertTo-Json -Compress
  $result = Invoke-RestMethod -Uri ($session.url + 'api/doctor/apply') -Method Post -Headers $headers -ContentType 'application/json' -Body $payload -TimeoutSec 12
  if ($result.task.phase -ne 'handoff' -or $result.task.handoffReady -ne $true -or $result.task.error) { throw '独立恢复进程尚未确认接手。' }
  Show-Info '恢复任务已交给独立进程。请等待 SusuClash 正常重开并继续代理基础检查。若未重开，请从托盘正常退出后，再从开始菜单打开。'
} catch {
  Show-Info '自动恢复未确认完成，助手没有强制结束任何进程。请从 SusuClash 托盘菜单正常退出，再重新打开。若窗口与托盘均无响应，请保存工作后，在任务管理器核对 SusuClash 的窗口与安装路径，再手动处理。'
}
