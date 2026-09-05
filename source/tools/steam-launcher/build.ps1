param([Parameter(Mandatory = $true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$frameworkRoot = Join-Path $env:SystemRoot 'Microsoft.NET'
$candidates = @(
    (Join-Path $frameworkRoot 'Framework64\v4.0.30319\csc.exe'),
    (Join-Path $frameworkRoot 'Framework\v4.0.30319\csc.exe')
)
$csc = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $csc) { throw 'The .NET Framework 4 csc.exe compiler was not found.' }
$source = Join-Path $PSScriptRoot 'OliviaSteamWaiter.cs'
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
& $csc /nologo /target:winexe /platform:anycpu /r:System.Windows.Forms.dll /r:System.Management.dll ("/out:" + (Join-Path $OutputDirectory 'OliviaSteamWaiter.exe')) $source
exit $LASTEXITCODE
