param(
    [Parameter(Mandatory = $true)][string]$GameRoot,
    [Parameter(Mandatory = $true)][string]$CleanFeapp,
    [Parameter(Mandatory = $true)][string]$CatalogRoot,
    [Parameter(Mandatory = $true)][string]$DestinationRoot,
    [switch]$WhatIfManifestOnly,
    [switch]$TestFixture
)

$ErrorActionPreference = "Stop"
$Version = "0.0.9.627"
$FeappRelativePath = "$Version/resources/feapp.dat"
$KnownCleanFeappSha256 = "C88F1DD4CB7C95E4902D74DD0C247962FFD65559E3907497B416078D3A6698B5"
$KnownMountedFeappSha256 = "CE3BAFFE655289919242F2162987EB759ADDDC846661E59ECAC3A1F774134429"
$Utf8NoBom = New-Object Text.UTF8Encoding $false
$IndependentDirectoryError = [Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String("55uu5qCH5b+F6aG75piv5LiO5ri45oiP5rqQ55uu5b2V5YiG56a755qE54us56uL55uu5b2V"))

function Resolve-ExistingPath([string]$Path, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Path)) { throw "$Label does not exist: $Path" }
    return [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Path).Path).TrimEnd('\')
}

function Get-FullTargetPath([string]$Path) {
    return [IO.Path]::GetFullPath($Path).TrimEnd('\')
}

function Test-PathWithin([string]$Candidate, [string]$Container) {
    $candidateFull = Get-FullTargetPath $Candidate
    $containerFull = Get-FullTargetPath $Container
    return $candidateFull.Equals($containerFull, [StringComparison]::OrdinalIgnoreCase) -or
        $candidateFull.StartsWith($containerFull + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Write-Utf8Json([string]$Path, $Value) {
    $parent = [IO.Path]::GetDirectoryName($Path)
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent | Out-Null
    }
    [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 8), $Utf8NoBom)
}

function Get-Sha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "") }
    finally {
        $sha.Dispose()
        $stream.Dispose()
    }
}

function Get-ManifestHash($Entries) {
    $canonical = (($Entries | ForEach-Object {
        '{0}|{1}|{2}' -f $_.path, $_.length, $_.sha256
    }) -join "`n") + "`n"
    $bytes = $Utf8NoBom.GetBytes($canonical)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "") }
    finally { $sha.Dispose() }
}

$game = Resolve-ExistingPath $GameRoot "game root"
$clean = Resolve-ExistingPath $CleanFeapp "clean front end"
$catalog = Resolve-ExistingPath $CatalogRoot "catalog root"
$destination = Get-FullTargetPath $DestinationRoot

if ((Test-PathWithin $destination $game) -or (Test-PathWithin $game $destination)) {
    throw $IndependentDirectoryError
}
$mountedFeapp = Join-Path $game "$Version\resources\feapp.dat"
if (-not (Test-Path -LiteralPath $mountedFeapp)) {
    throw "game root is not the supported $Version client"
}
$cleanFeappSha256 = Get-Sha256 $clean
$mountedFeappSha256 = Get-Sha256 $mountedFeapp
if (-not $TestFixture -and
    (-not $cleanFeappSha256.Equals($KnownCleanFeappSha256, [StringComparison]::OrdinalIgnoreCase) -or
     -not $mountedFeappSha256.Equals($KnownMountedFeappSha256, [StringComparison]::OrdinalIgnoreCase))) {
    throw "front end hash mismatch for the supported client"
}

$sourceEntries = @()
foreach ($file in Get-ChildItem -LiteralPath $game -File -Recurse | Sort-Object FullName) {
    $relative = $file.FullName.Substring($game.Length + 1).Replace('\', '/')
    $sourcePath = if ($relative.Equals($FeappRelativePath, [StringComparison]::OrdinalIgnoreCase)) {
        $clean
    } else {
        $file.FullName
    }
    $sourceFile = Get-Item -LiteralPath $sourcePath
    $sourceEntries += [ordered]@{
        path = $relative
        length = [long]$sourceFile.Length
        sha256 = Get-Sha256 $sourcePath
    }
}
$sourceManifestHash = Get-ManifestHash $sourceEntries

if ($WhatIfManifestOnly) {
    [ordered]@{
        version = $Version
        filesVerified = $sourceEntries.Count
        sourceManifestSha256 = $sourceManifestHash
        cleanFeappSha256 = $cleanFeappSha256
        sourceFeappSha256 = $mountedFeappSha256
        destinationRoot = $destination
        catalogRoot = $catalog
        manifestOnly = $true
    } | ConvertTo-Json -Compress
    exit 0
}

if (Test-Path -LiteralPath $destination) {
    $existing = @(Get-ChildItem -Force -LiteralPath $destination)
    if ($existing.Count -gt 0) {
        $statePath = Join-Path $destination "recovery\install-state.json"
        if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
            throw "independent destination is not empty and has no install state: $destination"
        }
        $existingState = [IO.File]::ReadAllText($statePath) | ConvertFrom-Json
        $sameInputs = ([string]$existingState.version).Equals($Version, [StringComparison]::Ordinal) -and
            ([string]$existingState.gameRoot).Equals($game, [StringComparison]::OrdinalIgnoreCase) -and
            ([string]$existingState.cleanFeapp).Equals($clean, [StringComparison]::OrdinalIgnoreCase) -and
            ([string]$existingState.catalogRoot).Equals($catalog, [StringComparison]::OrdinalIgnoreCase) -and
            ([string]$existingState.sourceManifestSha256).Equals($sourceManifestHash, [StringComparison]::OrdinalIgnoreCase)
        if (-not $sameInputs) { throw "independent destination input mismatch" }
        $verifier = Join-Path $PSScriptRoot "test-independent-client.ps1"
        $verification = ((& $verifier -DestinationRoot $destination) | Out-String).Trim() | ConvertFrom-Json
        if (-not $verification.valid) { throw "independent destination verification mismatch" }
        [ordered]@{
            version = $Version
            gameRoot = $game
            cleanFeapp = $clean
            catalogRoot = $catalog
            destinationRoot = $destination
            filesVerified = [int]$existingState.filesVerified
            sourceManifestSha256 = [string]$existingState.sourceManifestSha256
            copyManifestSha256 = [string]$existingState.copyManifestSha256
            resumed = $true
        } | ConvertTo-Json -Compress
        exit 0
    }
} else {
    New-Item -ItemType Directory -Path $destination | Out-Null
}

$gameDestination = Join-Path $destination "game"
$recovery = Join-Path $destination "recovery"
New-Item -ItemType Directory -Path $gameDestination | Out-Null
New-Item -ItemType Directory -Path $recovery | Out-Null

foreach ($entry in $sourceEntries) {
    $relativeWindows = $entry.path.Replace('/', '\')
    $sourcePath = if ($entry.path.Equals($FeappRelativePath, [StringComparison]::OrdinalIgnoreCase)) {
        $clean
    } else {
        Join-Path $game $relativeWindows
    }
    $targetPath = Join-Path $gameDestination $relativeWindows
    $targetParent = [IO.Path]::GetDirectoryName($targetPath)
    if (-not (Test-Path -LiteralPath $targetParent)) {
        New-Item -ItemType Directory -Path $targetParent | Out-Null
    }
    Copy-Item -LiteralPath $sourcePath -Destination $targetPath
}

Copy-Item -LiteralPath $clean -Destination (Join-Path $recovery "feapp-original.dat")

$copyEntries = @()
foreach ($entry in $sourceEntries) {
    $targetPath = Join-Path $gameDestination $entry.path.Replace('/', '\')
    $targetFile = Get-Item -LiteralPath $targetPath
    $copyEntries += [ordered]@{
        path = $entry.path
        length = [long]$targetFile.Length
        sha256 = Get-Sha256 $targetPath
    }
}
$copyManifestHash = Get-ManifestHash $copyEntries
if (-not $sourceManifestHash.Equals($copyManifestHash, [StringComparison]::OrdinalIgnoreCase)) {
    throw "independent client manifest hash mismatch"
}

Write-Utf8Json (Join-Path $recovery "source-hashes.json") $sourceEntries
Write-Utf8Json (Join-Path $recovery "copy-hashes.json") $copyEntries
$state = [ordered]@{
    version = $Version
    gameRoot = $game
    cleanFeapp = $clean
    catalogRoot = $catalog
    destinationRoot = $destination
    filesVerified = $copyEntries.Count
    sourceManifestSha256 = $sourceManifestHash
    copyManifestSha256 = $copyManifestHash
    cleanFeappSha256 = $cleanFeappSha256
    sourceFeappSha256 = $mountedFeappSha256
}
Write-Utf8Json (Join-Path $recovery "install-state.json") $state
$state | ConvertTo-Json -Compress
