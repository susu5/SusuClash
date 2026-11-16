param([switch]$NoOpen)
$ErrorActionPreference = 'Stop'
$previewRoot = Split-Path -Parent $PSScriptRoot
$previewUrl = 'http://127.0.0.1:4541/'
$previewLogDir = Join-Path $previewRoot 'outputs/log'
New-Item -ItemType Directory -Path $previewLogDir -Force | Out-Null

function Test-PreviewReady {
  try {
    $health = Invoke-RestMethod -Uri ($previewUrl + '__preview/health') -TimeoutSec 1
    return ($health.preview -eq $true -and $health.style -eq 'author-v3')
  } catch { return $false }
}

try {
  if (!(Test-PreviewReady)) {
    $previewNode = Join-Path $previewRoot 'runtime/node/node.exe'
    if (!(Test-Path -LiteralPath $previewNode -PathType Leaf)) {
      $previewNode = (Get-Command node -ErrorAction Stop).Source
    }
    $previewScript = Join-Path $previewRoot 'scripts/preview-client.cjs'
    $previewProcess = Start-Process -FilePath $previewNode -ArgumentList @(('"' + $previewScript + '"'), '--port=4541') -WorkingDirectory $previewRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $previewLogDir 'client-preview.stdout.log') -RedirectStandardError (Join-Path $previewLogDir 'client-preview.stderr.log')
    $previewReady = $false
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
      if (Test-PreviewReady) { $previewReady = $true; break }
      if ($previewProcess.HasExited) { break }
      Start-Sleep -Milliseconds 200
    }
    if (!$previewReady) {
      throw 'Preview could not start on port 4541. See outputs/log/client-preview.stderr.log. No existing process was stopped.'
    }
  }
  Write-Output $previewUrl
  if (!$NoOpen) { Start-Process $previewUrl }
} catch {
  $_.Exception.Message | Add-Content -LiteralPath (Join-Path $previewLogDir 'client-preview-open.log') -Encoding utf8
  throw
}
