param(
    [Parameter(Mandatory = $true)][string]$FeappPath
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (-not (Test-Path -LiteralPath $FeappPath)) {
    [ordered]@{ clientFound = $false; mounted = $false; port = $null } | ConvertTo-Json -Compress
    exit 0
}

$stream = [IO.File]::OpenRead($FeappPath)
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

$endpoints = @(
    "/signIn",
    "/getUserInfo",
    "/letter/send",
    "/letter/list",
    "/letter/detail",
    "/letter/unread_count",
    "/letter/share",
    "/letter/resend",
    "/addToPlaylist",
    "/delFromPlaylist",
    "/searchPlaylist",
    "/genObjectUploadUrl",
    "/midi/generate",
    "/midi/getGenerateResult",
    "/midi/cancelGenerate",
    "/midi/deleteJob",
    "/midi/listJobs",
    "/midi/batchGetResult",
    "/midi/importShareCode",
    "/deleteUserSong",
    "/searchUserSongs"
)
$ports = New-Object System.Collections.Generic.List[int]
$complete = $true
foreach ($endpoint in $endpoints) {
    $pattern = 'http://127\.0\.0\.1:(\d+)/toy' + [regex]::Escape($endpoint)
    $matches = @([regex]::Matches($text, $pattern))
    if ($matches.Count -ne 1) {
        $complete = $false
        continue
    }
    $ports.Add([int]$matches[0].Groups[1].Value)
}
$uniquePorts = @($ports | Select-Object -Unique)
$currentMarker = '/*OliviaSoulPatch:mail-music-v31*/'
$knownMarkers = @(
    $currentMarker,
    '/*OliviaSoulPatch:mail-music-v30*/',
    '/*OliviaSoulPatch:mail-music-v29*/',
    '/*OliviaSoulPatch:mail-music-v28*/',
    '/*OliviaSoulPatch:mail-music-v27*/',
    '/*OliviaSoulPatch:mail-music-v26*/',
    '/*OliviaSoulPatch:mail-music-v25*/',
    '/*OliviaSoulPatch:mail-music-v24*/',
    '/*OliviaSoulPatch:mail-music-v23*/',
    '/*OliviaSoulPatch:mail-music-v22*/',
    '/*OliviaSoulPatch:mail-music-v20*/',
    '/*OliviaSoulPatch:mail-music-v19*/',
    '/*OliviaSoulPatch:mail-music-v18*/',
    '/*OliviaSoulPatch:mail-music-v17*/',
    '/*OliviaSoulPatch:mail-music-v16*/',
    '/*OliviaSoulPatch:mail-music-v15*/',
    '/*OliviaSoulPatch:mail-music-v14*/'
)
$activeMarker = @($knownMarkers | Where-Object { $text.StartsWith($_) } | Select-Object -First 1)
$managed = $complete -and $uniquePorts.Count -eq 1 -and $activeMarker.Count -eq 1
$mounted = $managed -and $activeMarker[0] -eq $currentMarker
$updateAvailable = $managed -and -not $mounted
$port = $null
if ($managed) { $port = $uniquePorts[0] }
$revision = $null
if ($managed) { $revision = [regex]::Match($activeMarker[0], 'v\d+').Value }
[ordered]@{ clientFound = $true; mounted = $mounted; managed = $managed; updateAvailable = $updateAvailable; revision = $revision; port = $port } | ConvertTo-Json -Compress
