param(
  [Parameter(Mandatory=$true)][ValidateSet('read','write')][string]$Action,
  [string]$Payload
)
$ErrorActionPreference = 'Stop'
$keyPath = 'Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($keyPath, ($Action -eq 'write'))
if (-not $key) { throw 'Windows Internet Settings is unavailable.' }
try {
  if ($Action -eq 'read') {
    $names = $key.GetValueNames()
    $enabledPresent = $names -contains 'ProxyEnable'
    $serverPresent = $names -contains 'ProxyServer'
    $result = @{
      enable = @{ present = $enabledPresent; value = if ($enabledPresent) { [int]$key.GetValue('ProxyEnable') } else { $null } }
      server = @{ present = $serverPresent; value = if ($serverPresent) { [string]$key.GetValue('ProxyServer') } else { $null } }
    }
    $result | ConvertTo-Json -Compress -Depth 4
  } else {
    $json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload))
    $settings = $json | ConvertFrom-Json
    if ($settings.server.present) { $key.SetValue('ProxyServer', [string]$settings.server.value, [Microsoft.Win32.RegistryValueKind]::String) }
    else { $key.DeleteValue('ProxyServer', $false) }
    if ($settings.enable.present) { $key.SetValue('ProxyEnable', [int]$settings.enable.value, [Microsoft.Win32.RegistryValueKind]::DWord) }
    else { $key.DeleteValue('ProxyEnable', $false) }
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class ProxyRefresh { [DllImport("wininet.dll", SetLastError=true)] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l); }'
    [void][ProxyRefresh]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)
    [void][ProxyRefresh]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)
  }
} finally { $key.Close() }
