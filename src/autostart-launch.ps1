$ErrorActionPreference = 'Stop'
$appRoot = Split-Path -Parent $PSScriptRoot
$node = Join-Path $appRoot 'runtime\node\node.exe'
$entry = Join-Path $PSScriptRoot 'desktop.mjs'
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw '本软件的 Node.js 运行环境不存在。' }
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw '本软件启动文件不存在。' }
Start-Process -FilePath $node -ArgumentList ('"' + $entry + '"') -WorkingDirectory $appRoot -WindowStyle Hidden
