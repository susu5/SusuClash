param(
  [Parameter(Mandatory=$true)][ValidateSet('read','set','remove')][string]$Action,
  [string]$Payload
)
$ErrorActionPreference = 'Stop'
$runPath = 'Software\Microsoft\Windows\CurrentVersion\Run'
$entry = 'ClashStandalone'
if ($Action -eq 'read') { $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($runPath, $false) }
else { $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($runPath, $true) }
try {
  $exists = $key -and ($key.GetValueNames() -contains $entry)
  $value = if ($exists) { $key.GetValue($entry, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { $null }
  if ($Action -eq 'read') {
    @{present=[bool]$exists; value=$value} | ConvertTo-Json -Compress
  } else {
    $expected = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload))
    if ($Action -eq 'set') {
      if ($exists -and $value -cne $expected) { throw '同名启动项不属于本软件。' }
      if (-not $exists) { $key.SetValue($entry, $expected, [Microsoft.Win32.RegistryValueKind]::String) }
    } else {
      if ($exists -and $value -cne $expected) { throw '同名启动项已被修改。' }
      if ($exists) { $key.DeleteValue($entry, $false) }
    }
    @{ok=$true} | ConvertTo-Json -Compress
  }
} finally { if ($key) { $key.Close() } }
