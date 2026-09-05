param([string]$OutputDirectory = (Join-Path $PSScriptRoot 'test-output'))
$ErrorActionPreference = 'Stop'
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$env:OLIVIA_STEAM_WAITER_TEST_ROOT = $OutputDirectory
$bin = Join-Path $OutputDirectory 'baseline-bin'
New-Item -ItemType Directory -Force -Path $bin | Out-Null
& $csc /nologo /target:exe ("/out:" + (Join-Path $bin 'FakeOlivia.exe')) (Join-Path $PSScriptRoot 'FakeOlivia.cs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $csc /nologo /target:exe ("/out:" + (Join-Path $bin 'FakeLauncher.exe')) (Join-Path $PSScriptRoot 'FakeLauncher.cs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $csc /nologo /target:exe ("/out:" + (Join-Path $bin 'EarlyExitBaseline.exe')) (Join-Path $PSScriptRoot 'EarlyExitBaseline.cs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& (Join-Path $bin 'EarlyExitBaseline.exe')
exit $LASTEXITCODE
