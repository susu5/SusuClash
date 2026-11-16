param(
  [Parameter(Mandatory=$true)][ValidateSet('read','write')][string]$Action,
  [string]$Payload
)
$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$keyPath = 'Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($keyPath, ($Action -eq 'write'))
if (-not $key) { throw 'Windows Internet Settings is unavailable.' }

function Read-ProxyState {
  $names = $key.GetValueNames()
  $enabledPresent = $names -contains 'ProxyEnable'
  $serverPresent = $names -contains 'ProxyServer'
  return @{
    enable = @{ present = $enabledPresent; value = if ($enabledPresent) { [int]$key.GetValue('ProxyEnable') } else { $null } }
    server = @{ present = $serverPresent; value = if ($serverPresent) { [string]$key.GetValue('ProxyServer') } else { $null } }
  }
}
function Test-ProxyState($Left, $Right) {
  foreach ($name in @('enable', 'server')) {
    if ($Left.$name.present -ne $Right.$name.present) { return $false }
    if ($Left.$name.present -and $Left.$name.value -cne $Right.$name.value) { return $false }
  }
  return $true
}
try {
  if ($Action -eq 'read') {
    Read-ProxyState | ConvertTo-Json -Compress -Depth 4
  } else {
    $json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload))
    $request = $json | ConvertFrom-Json
    $settings = if ($request.state) { $request.state } else { $request }
    # Load the notification helper before changing any registry values.
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class ProxyRefresh { [DllImport("wininet.dll", SetLastError=true)] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l); }'
    if ($request.expected -and -not (Test-ProxyState (Read-ProxyState) $request.expected)) { throw 'SC_PROXY_CHANGED' }
    if ($settings.server.present) { $key.SetValue('ProxyServer', [string]$settings.server.value, [Microsoft.Win32.RegistryValueKind]::String) }
    else { $key.DeleteValue('ProxyServer', $false) }
    if ($settings.enable.present) { $key.SetValue('ProxyEnable', [int]$settings.enable.value, [Microsoft.Win32.RegistryValueKind]::DWord) }
    else { $key.DeleteValue('ProxyEnable', $false) }
    $key.Flush()
    $notified = [ProxyRefresh]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)
    $refreshed = [ProxyRefresh]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)
    # The JS transaction retains its before/applied snapshots and performs the
    # same conditional write plus checked notification to roll back on failure.
    if (-not $notified -or -not $refreshed) { throw 'SC_PROXY_REFRESH_FAILED' }
  }
} finally { $key.Close() }
