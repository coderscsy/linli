param(
    [Parameter(Mandatory = $true)][string]$GameRoot,
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$OriginalFile,
    [switch]$TestFixture
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "process-control.ps1")
$destination = Join-Path $GameRoot "$Version\resources\webplayer.dat"
if (-not (Test-Path -LiteralPath $OriginalFile -PathType Leaf)) { throw "original webplayer.dat not found" }
if (-not $TestFixture) {
    Stop-GameProcesses $GameRoot
    Start-Sleep -Milliseconds 250
}
Copy-Item -LiteralPath $OriginalFile -Destination $destination -Force
Write-Output "restored=$destination"
Write-Output "sha256=$((Get-FileHash -Algorithm SHA256 -LiteralPath $destination).Hash)"
