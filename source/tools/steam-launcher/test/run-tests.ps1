param([string]$OutputDirectory = (Join-Path $PSScriptRoot 'test-output'))
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$env:OLIVIA_STEAM_WAITER_TEST_ROOT = $OutputDirectory
$bin = Join-Path $OutputDirectory 'test-bin'
New-Item -ItemType Directory -Force -Path $bin | Out-Null
$fakeOlivia = Join-Path $bin 'FakeOlivia.exe'
$fakeLauncher = Join-Path $bin 'FakeLauncher.exe'
$testExe = Join-Path $bin 'SteamWaiterTests.exe'
& $csc /nologo /target:exe ("/out:" + $fakeOlivia) (Join-Path $PSScriptRoot 'FakeOlivia.cs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $csc /nologo /target:exe ("/out:" + $fakeLauncher) (Join-Path $PSScriptRoot 'FakeLauncher.cs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& (Join-Path $root 'build.ps1') -OutputDirectory $bin
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $csc /nologo /target:exe /r:System.Windows.Forms.dll /r:System.Management.dll /main:SteamWaiterTests ("/out:" + $testExe) (Join-Path $root 'OliviaSteamWaiter.cs') (Join-Path $PSScriptRoot 'SteamWaiterTests.cs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& (Join-Path $bin 'SteamWaiterTests.exe')
exit $LASTEXITCODE
