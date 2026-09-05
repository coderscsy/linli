param(
    [Parameter(Mandatory = $true)][string]$GameRoot,
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$OriginalFile,
    [switch]$RestoreStudioUi,
    [switch]$RestoreContainerPlugin
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "process-control.ps1")
$relative = "$Version\resources\feapp.dat"
$destination = Join-Path $GameRoot $relative
if (-not (Test-Path -LiteralPath $OriginalFile)) { throw "original feapp.dat not found" }
$studioUiPath = Join-Path $GameRoot "$Version\plugins\Studio\NutStudioUI.dll"
$studioBackup = Join-Path ([IO.Path]::GetDirectoryName($OriginalFile)) ("NutStudioUI-" + $Version + ".dll")
if ($RestoreStudioUi) {
    if (-not (Test-Path -LiteralPath $studioBackup -PathType Leaf)) { throw "registered NutStudioUI.dll backup missing" }
    if (-not (Test-Path -LiteralPath $studioUiPath -PathType Leaf)) { throw "registered NutStudioUI.dll target missing" }
}
$containerPluginPath = Join-Path $GameRoot "$Version\plugins\Container\NutContainerPlugin.dll"
$containerPluginBackup = Join-Path ([IO.Path]::GetDirectoryName($OriginalFile)) ("NutContainerPlugin-" + $Version + ".dll")
if ($RestoreContainerPlugin) {
    if (-not (Test-Path -LiteralPath $containerPluginBackup -PathType Leaf)) { throw "registered NutContainerPlugin.dll backup missing" }
    if (-not (Test-Path -LiteralPath $containerPluginPath -PathType Leaf)) { throw "registered NutContainerPlugin.dll target missing" }
}
Stop-GameProcesses $GameRoot
Start-Sleep -Milliseconds 250
Copy-Item -LiteralPath $OriginalFile -Destination $destination -Force
if ($RestoreStudioUi) {
    Copy-Item -LiteralPath $studioBackup -Destination $studioUiPath -Force
}
if ($RestoreContainerPlugin) {
    Copy-Item -LiteralPath $containerPluginBackup -Destination $containerPluginPath -Force
}
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $destination).Hash
Write-Output "restored=$destination"
Write-Output "sha256=$hash"
if (Test-Path -LiteralPath $studioUiPath) {
    Write-Output "studioUi=$studioUiPath"
    Write-Output "studioUiSha256=$((Get-FileHash -Algorithm SHA256 -LiteralPath $studioUiPath).Hash)"
}
if (Test-Path -LiteralPath $containerPluginPath) {
    Write-Output "containerPlugin=$containerPluginPath"
    Write-Output "containerPluginSha256=$((Get-FileHash -Algorithm SHA256 -LiteralPath $containerPluginPath).Hash)"
}
