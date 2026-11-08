param([Parameter(Mandatory=$true)][int]$ParentPid,[Parameter(Mandatory=$true)][string]$StopFile)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$context = New-Object System.Windows.Forms.ApplicationContext
$icon = New-Object System.Windows.Forms.NotifyIcon
$appIcon = New-Object System.Drawing.Icon -ArgumentList (Join-Path $PSScriptRoot '..\app\icon.ico'),32,32
$icon.Icon = $appIcon
$icon.Text = 'SusuClash'
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$open = $menu.Items.Add('打开')
$exit = $menu.Items.Add('退出')
$icon.ContextMenuStrip = $menu
$open.Add_Click({ [Console]::Out.WriteLine('OPEN'); [Console]::Out.Flush() })
$icon.Add_DoubleClick({ [Console]::Out.WriteLine('OPEN'); [Console]::Out.Flush() })
$exit.Add_Click({ [Console]::Out.WriteLine('EXIT'); [Console]::Out.Flush() })
$icon.Visible = $true
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 500
$timer.Add_Tick({
  if (Test-Path -LiteralPath $StopFile) { $context.ExitThread(); return }
  if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { $context.ExitThread() }
})
$timer.Start()
try {
  [Console]::Out.WriteLine('READY'); [Console]::Out.Flush()
  [System.Windows.Forms.Application]::Run($context)
} finally {
  $timer.Stop(); $timer.Dispose(); $icon.Visible = $false; $icon.Dispose(); $appIcon.Dispose(); $menu.Dispose(); $context.Dispose()
}
