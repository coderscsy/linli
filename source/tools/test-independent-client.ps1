param(
    [Parameter(Mandatory = $true)][string]$DestinationRoot
)

$ErrorActionPreference = "Stop"

function Get-Sha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "") }
    finally {
        $sha.Dispose()
        $stream.Dispose()
    }
}

if (-not (Test-Path -LiteralPath $DestinationRoot -PathType Container)) {
    throw "independent destination does not exist"
}
$destination = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $DestinationRoot).Path).TrimEnd('\')
$gameRoot = Join-Path $destination "game"
$recovery = Join-Path $destination "recovery"
$statePath = Join-Path $recovery "install-state.json"
$manifestPath = Join-Path $recovery "copy-hashes.json"
if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { throw "install state is missing" }
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "copy manifest is missing" }

$state = [IO.File]::ReadAllText($statePath) | ConvertFrom-Json
$parsedEntries = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
$entries = @()
foreach ($parsedEntry in $parsedEntries) { $entries += $parsedEntry }
$mismatches = New-Object System.Collections.Generic.List[string]
$gamePrefix = [IO.Path]::GetFullPath($gameRoot).TrimEnd('\') + '\'

foreach ($entry in $entries) {
    $relative = [string]$entry.path
    if ([string]::IsNullOrWhiteSpace($relative) -or $relative.Contains("..") -or [IO.Path]::IsPathRooted($relative)) {
        $mismatches.Add($relative)
        continue
    }
    $target = [IO.Path]::GetFullPath((Join-Path $gameRoot $relative.Replace('/', '\')))
    if (-not $target.StartsWith($gamePrefix, [StringComparison]::OrdinalIgnoreCase) -or
        -not (Test-Path -LiteralPath $target -PathType Leaf)) {
        $mismatches.Add($relative)
        continue
    }
    $file = Get-Item -LiteralPath $target
    if ([long]$file.Length -ne [long]$entry.length -or
        -not (Get-Sha256 $target).Equals([string]$entry.sha256, [StringComparison]::OrdinalIgnoreCase)) {
        $mismatches.Add($relative)
    }
}

[ordered]@{
    valid = $mismatches.Count -eq 0
    mismatches = @($mismatches.ToArray())
    version = [string]$state.version
    catalogRoot = [string]$state.catalogRoot
} | ConvertTo-Json -Compress
