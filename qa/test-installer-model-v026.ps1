# Public portable variant: original validation logic retained; repository-relative outputs.
param([string]$Compiler, [string]$OutDir)
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
if (!$Compiler) { $Compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe' }
if (!$OutDir) { $OutDir = Join-Path $workspace 'outputs/working/release-v0.1.26-installer-model' }
$workingRoot = [IO.Path]::GetFullPath((Join-Path $workspace 'outputs/working')).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
$OutDir = [IO.Path]::GetFullPath($OutDir)
if (!$OutDir.StartsWith($workingRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Model test output must stay under outputs/working' }
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$engine = Join-Path $workspace 'packaging/installer/EngineProgress.cs'
$tests = Join-Path $PSScriptRoot 'installer/EngineProgressTests.cs'
$exe = Join-Path $OutDir 'EngineProgressTests.exe'
$logRoot = Join-Path $workspace 'outputs/log'
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$log = Join-Path $logRoot 'release-v0.1.26-installer-model.log'
[IO.File]::WriteAllText($log, ('Production installer message-model tests ' + [DateTime]::UtcNow.ToString('o') + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
$compile = @(& $Compiler /nologo /target:exe /optimize+ "/out:$exe" $engine $tests 2>&1)
$compileCode = $LASTEXITCODE
$compile | Add-Content -LiteralPath $log -Encoding utf8
if ($compileCode -ne 0) { throw "Installer model test compile failed: $compileCode (see $log)" }
$result = @(& $exe 2>&1)
$resultCode = $LASTEXITCODE
$result | Add-Content -LiteralPath $log -Encoding utf8
$passed = @($result | Where-Object { $_ -match '^PASS ' }).Count
$failed = @($result | Where-Object { $_ -match '^FAIL ' }).Count
$report = [ordered]@{
  passed=($resultCode -eq 0 -and $failed -eq 0 -and $passed -gt 20); version='0.1.26'; checks=$passed+$failed; passedChecks=$passed; failedChecks=$failed
  engineSource=$engine; engineSha256=(Get-FileHash -LiteralPath $engine -Algorithm SHA256).Hash.ToLowerInvariant()
  testSource=$tests; testSha256=(Get-FileHash -LiteralPath $tests -Algorithm SHA256).Hash.ToLowerInvariant()
  harness=$exe; harnessSha256=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant(); log=$log
  scope='production pure MSI message reducer, actual action-status protocol, reboot receipt and admission policy'; actualMsiExecution=$false; installed=$false
}
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $logRoot 'release-v0.1.26-installer-model.json') -Encoding utf8
if (!$report.passed) { throw "Installer model tests failed: $failed (see $log)" }
$report | ConvertTo-Json -Compress
