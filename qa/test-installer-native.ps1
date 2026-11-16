# Reproduce the MSI-only native UI checks against an explicit, verified build receipt.
# Default: compile and OpenPackage-only smoke checks. -RunMarker explicitly enables
# a random-family, single-marker install and immediate cleanup. Never use the real MSI.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$Receipt,
    [string]$Python = "$env:USERPROFILE\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe",
    [switch]$RunMarker
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$receiptPath = (Resolve-Path -LiteralPath $Receipt).Path
$build = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
foreach ($item in @(@($build.nativeDll,$build.nativeSha256),@($build.stateDll,$build.stateSha256))) {
    if ((Get-FileHash -LiteralPath $item[0] -Algorithm SHA256).Hash.ToLowerInvariant() -ne $item[1]) { throw 'Installer receipt hash mismatch.' }
}
$tag = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N')
$work = Join-Path $projectRoot ('outputs\working\installer-native-qa-' + $tag)
New-Item -ItemType Directory -Path $work | Out-Null
$log = Join-Path $projectRoot ('outputs\log\installer-native-qa-' + $tag + '.log')
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$nativeSource = Join-Path $PSScriptRoot 'installer\NativeEntrySmoke.cs'
$markerSource = Join-Path $PSScriptRoot 'installer\ProductionMarkerFixture.cs'
$builderSource = Join-Path $PSScriptRoot 'installer\build-production-marker-fixture.py'
& $compiler /nologo /target:exe /platform:x64 /optimize+ ('/out:'+(Join-Path $work 'NativeEntrySmoke.exe')) $nativeSource
if ($LASTEXITCODE -ne 0) { throw 'Native entry test compilation failed.' }
& $compiler /nologo /target:exe /platform:x64 /optimize+ ('/out:'+(Join-Path $work 'ProductionMarkerFixture.exe')) $markerSource
if ($LASTEXITCODE -ne 0) { throw 'Marker test compilation failed.' }
$output = & $Python $builderSource --receipt $receiptPath
if ($LASTEXITCODE -ne 0) { throw 'Isolated marker fixture build failed.' }
$fixture = ($output | Select-Object -Last 1) | ConvertFrom-Json
if ($fixture.upgradeCode -eq '{D7806B3D-6DD7-4DA6-B640-D96A07185A75}') { throw 'Real product family is forbidden.' }
$results = @()
foreach ($mode in @('silent','maintenance','welcome-close')) {
    & (Join-Path $work 'NativeEntrySmoke.exe') $build.nativeDll $fixture.msi $mode | Tee-Object -FilePath $log -Append
    $code = $LASTEXITCODE
    $results += [pscustomobject]@{mode=$mode;passed=($code -eq 0);exitCode=$code;installationSequence=$false}
    if ($code -ne 0) { throw ('Native entry test failed: ' + $mode) }
}
if ($RunMarker) {
    & (Join-Path $work 'ProductionMarkerFixture.exe') $fixture.msi $build.nativeSha256 | Tee-Object -FilePath $log -Append
    $code = $LASTEXITCODE
    $results += [pscustomobject]@{mode='single-marker-success-X';passed=($code -eq 0);exitCode=$code;installationSequence=$true}
    if ($code -ne 0) { throw ('Marker test failed. Inspect log; cleanup evidence must be confirmed: ' + $log) }
}
$report = [ordered]@{
    passed=$true; realProductInstalled=$false; actualAppLaunches=0
    nativeSha256=$build.nativeSha256; stateSha256=$build.stateSha256
    runMarker=[bool]$RunMarker; cases=$results; fixture=$fixture; log=$log
    artifacts=@{}
}
foreach ($path in @($nativeSource,$markerSource,$builderSource,(Join-Path $work 'NativeEntrySmoke.exe'),(Join-Path $work 'ProductionMarkerFixture.exe'),$fixture.msi)) {
    $report.artifacts[$path] = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}
$json = Join-Path $projectRoot ('outputs\log\installer-native-qa-' + $tag + '.json')
$report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $json -Encoding utf8
Write-Output $json
