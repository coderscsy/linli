param(
    [Parameter(Mandatory = $true)][string]$WebplayerPath
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression
if (-not (Test-Path -LiteralPath $WebplayerPath -PathType Leaf)) {
    [ordered]@{ clientFound = $false; mounted = $false } | ConvertTo-Json -Compress
    exit 0
}

$stream = [IO.File]::OpenRead($WebplayerPath)
$archive = New-Object -TypeName IO.Compression.ZipArchive -ArgumentList @(
    $stream,
    [IO.Compression.ZipArchiveMode]::Read,
    $false
)
try {
    $entries = @($archive.Entries | Where-Object { $_.FullName -match '^assets/main-[^/]+\.js$' })
    if ($entries.Count -ne 1) { throw "expected one main-*.js, got $($entries.Count)" }
    $reader = New-Object IO.StreamReader($entries[0].Open(), (New-Object System.Text.UTF8Encoding $false))
    try { $text = $reader.ReadToEnd() }
    finally { $reader.Dispose() }
}
finally {
    $archive.Dispose()
    $stream.Dispose()
}

$patchMarker = '/*OliviaSoulPatch:webplayer-no-watermark-direct-http-progress-v13*/'
$legacyPatchMarkers = @(
    '/*OliviaSoulPatch:webplayer-no-watermark-direct-http-progress-v12*/',
    '/*OliviaSoulPatch:webplayer-no-watermark-direct-http-progress-v11*/',
    '/*OliviaSoulPatch:webplayer-no-watermark-direct-http-progress-v10*/',
    '/*OliviaSoulPatch:webplayer-no-watermark-direct-http-progress-v9*/',
    '/*OliviaSoulPatch:webplayer-no-watermark-direct-http-progress-v8*/',
    '/*OliviaSoulPatch:webplayer-no-watermark-direct-http-progress-v7*/',
    '/*OliviaSoulPatch:webplayer-no-watermark-direct-http-progress-v6*/'
)
$watermarkShown = 'S(n)?(k(),we(l,{key:0,uid:S(n)},null,8,["uid"])):Re("",!0)'
$activeMarker = @(@($patchMarker) + $legacyPatchMarkers | Where-Object { $text.StartsWith($_) } | Select-Object -First 1)
$managed = $activeMarker.Count -eq 1 -and
    -not $text.Contains($watermarkShown) -and
    $text.Contains('/toy/player-command') -and
    $text.Contains('/toy/player-state') -and
    $text.Contains('__OliviaSoulPlayerPoll')
$mounted = $managed -and $text.StartsWith($patchMarker)
$revision = if ($managed) { [regex]::Match($activeMarker[0], 'v\d+').Value } else { $null }
[ordered]@{ clientFound = $true; mounted = $mounted; managed = $managed; updateAvailable = ($managed -and -not $mounted); revision = $revision } | ConvertTo-Json -Compress
