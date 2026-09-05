param(
    [ValidateSet('preview', 'install', 'restore')][string]$Mode = 'preview',
    [string]$SteamUserId,
    [string]$SteamPath,
    [string]$AppId = '4532590',
    [string]$InstallDirectory,
    [string]$NodePath,
    [string]$HelperPath,
    [string]$ManifestPath,
    [string]$ExpectedHash
)
$ErrorActionPreference = 'Stop'

# Installed beside the helper in <install>/UserData/tools/steam-launcher.
if (-not $InstallDirectory) {
    $InstallDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
}
if (-not $NodePath) { $NodePath = Join-Path $InstallDirectory 'runtime/node.exe' }
if (-not $HelperPath) { $HelperPath = Join-Path $PSScriptRoot 'OliviaSteamWaiter.exe' }
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw 'NODE_NOT_FOUND: specify -NodePath or -InstallDirectory.' }
if (-not $SteamPath) {
    $SteamPath = (Get-ItemProperty -LiteralPath 'HKCU:\Software\Valve\Steam' -Name SteamPath -ErrorAction Stop).SteamPath
}
if (-not $SteamUserId) {
    $active = Get-ItemProperty -LiteralPath 'HKCU:\Software\Valve\Steam\ActiveProcess' -Name ActiveUser -ErrorAction SilentlyContinue
    if ($active -and $active.ActiveUser -gt 0) { $SteamUserId = [string]$active.ActiveUser }
    else { throw 'STEAM_ACCOUNT_REQUIRED: specify the current account with -SteamUserId. No account will be guessed.' }
}
if ($SteamUserId -notmatch '^[1-9][0-9]{0,9}$') { throw 'INVALID_STEAM_ACCOUNT' }
if ($AppId -notmatch '^[1-9][0-9]{0,9}$') { throw 'INVALID_APP_ID' }
$configPath = Join-Path $SteamPath "userdata/$SteamUserId/config/localconfig.vdf"
$backupDirectory = Join-Path $InstallDirectory 'UserData/Backups/steam-launcher'
$toolArgs = @(
    (Join-Path $PSScriptRoot 'steam-launch-options.mjs'),
    '--mode', $Mode, '--configPath', $configPath, '--appId', $AppId,
    '--helperPath', $HelperPath, '--backupDirectory', $backupDirectory
)
if ($ManifestPath) { $toolArgs += @('--manifestPath', $ManifestPath) }
if ($ExpectedHash) { $toolArgs += @('--expectedHash', $ExpectedHash) }
if ($Mode -eq 'restore' -and -not $ManifestPath) { throw 'RESTORE_MANIFEST_REQUIRED' }
& $NodePath @toolArgs
if ($LASTEXITCODE -ne 0) { throw 'STEAM_LAUNCH_CONFIGURATION_FAILED: see the error code above.' }
