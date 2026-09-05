param(
    [Parameter(Mandatory = $true)][string]$GameRoot,
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$ServiceUrl = "http://127.0.0.1:27149"
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "process-control.ps1")
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$source = Join-Path $GameRoot "$Version\resources\feapp.dat"
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "feapp.dat not found: $source" }
Stop-GameProcesses $GameRoot
Start-Sleep -Milliseconds 250

$buildRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\_build\feapp-upgrade-v24"))
$extracted = Join-Path $buildRoot "extracted"
$verifyDir = Join-Path $buildRoot "verify"
$patched = Join-Path $buildRoot "feapp.patched.dat"
if (Test-Path -LiteralPath $buildRoot) { Remove-Item -LiteralPath $buildRoot -Recurse -Force }
New-Item -ItemType Directory -Path $extracted | Out-Null
[IO.Compression.ZipFile]::ExtractToDirectory($source, $extracted)

$mainFiles = @(Get-ChildItem -LiteralPath (Join-Path $extracted "assets") -Filter "main-*.js" -File)
if ($mainFiles.Count -ne 1) { throw "expected one main-*.js, got $($mainFiles.Count)" }
$utf8 = New-Object System.Text.UTF8Encoding $false
$mainPath = $mainFiles[0].FullName
$text = [IO.File]::ReadAllText($mainPath, $utf8)
$v22Marker = '/*OliviaSoulPatch:mail-music-v22*/'
$v23Marker = '/*OliviaSoulPatch:mail-music-v23*/'
$currentMarker = '/*OliviaSoulPatch:mail-music-v24*/'
if (-not ($text.StartsWith($v22Marker) -or $text.StartsWith($v23Marker))) { throw "client is not an OliviaSoul v22/v23 patch" }
$sourceRevision = if ($text.StartsWith($v22Marker)) { "v22" } else { "v23" }
if ($sourceRevision -eq "v22") { $text = $v23Marker + $text.Substring($v22Marker.Length) }

$playlistAvailabilityFrom = 'a=B=>{var W;if(t.value!==Se.LITE)return!0;const K=l(B);return K?((W=i.getDownloadEntry(K))==null?void 0:W.state)==="completed":!0}'
$playlistAvailabilityTo = 'a=B=>{var W;if(String(B&&B.videoUrl||"").includes("/toy/midi/songs/"))return!0;if(t.value!==Se.LITE)return!0;const K=l(B);return K?((W=i.getDownloadEntry(K))==null?void 0:W.state)==="completed":!0}'
$availabilityCount = ([regex]::Matches($text, [regex]::Escape($playlistAvailabilityFrom))).Count
if ($sourceRevision -eq "v22") {
    if ($availabilityCount -ne 1) { throw "expected one playlist availability guard, got $availabilityCount" }
    $text = $text.Replace($playlistAvailabilityFrom, $playlistAvailabilityTo)
} elseif (-not $text.Contains($playlistAvailabilityTo)) {
    throw "v23 client is missing the local playlist availability guard"
}

$endedFrom = 'OliviaSoulApplyPlayerState=B=>{if(String(B.songId)!==String(window.__OliviaSoulSongId))return;if(B.playbackState==="ended"){w("natural_end"),Ct({cmd:"stop"}),G(),window.__OliviaSoulSongId=null,window.__OliviaSoulCommandRevision=null;return}'
$endedTo = 'OliviaSoulApplyPlayerState=B=>{if(String(B.songId)!==String(window.__OliviaSoulSongId))return;if(B.playbackState==="ended"){w("natural_end"),m.value=!1,window.__OliviaSoulSongId=null,window.__OliviaSoulCommandRevision=null;if(h.value==="songlist"){Ct({cmd:"stop"}),G();return}p.value===ot.Single&&u.value&&a(u.value)?M(u.value):U();return}'
$endedCount = ([regex]::Matches($text, [regex]::Escape($endedFrom))).Count
if ($endedCount -ne 1) { throw "expected one v23 local completion handler, got $endedCount" }
$text = $text.Replace($endedFrom, $endedTo)
$text = $currentMarker + $text.Substring($v23Marker.Length)

$endpoints = @(
    "/signIn", "/getUserInfo", "/letter/send", "/letter/list", "/letter/detail",
    "/letter/unread_count", "/letter/share", "/letter/resend", "/addToPlaylist",
    "/delFromPlaylist", "/searchPlaylist", "/genObjectUploadUrl", "/midi/generate",
    "/midi/getGenerateResult", "/midi/cancelGenerate", "/midi/deleteJob",
    "/midi/listJobs", "/midi/batchGetResult", "/midi/importShareCode",
    "/deleteUserSong", "/searchUserSongs"
)
foreach ($endpoint in $endpoints) {
    $pattern = '"http://127\.0\.0\.1:\d+/toy' + [regex]::Escape($endpoint) + '"'
    $count = ([regex]::Matches($text, $pattern)).Count
    if ($count -ne 1) { throw "expected one local endpoint occurrence for $endpoint, got $count" }
    $replacement = '"' + $ServiceUrl.TrimEnd("/") + "/toy" + $endpoint + '"'
    $text = [regex]::Replace($text, $pattern, $replacement)
}
[IO.File]::WriteAllText($mainPath, $text, $utf8)

$archiveStream = [IO.File]::Open($patched, [IO.FileMode]::Create)
$archive = New-Object -TypeName IO.Compression.ZipArchive -ArgumentList @($archiveStream, [IO.Compression.ZipArchiveMode]::Create, $false)
try {
    foreach ($file in Get-ChildItem -LiteralPath $extracted -File -Recurse) {
        $entryName = $file.FullName.Substring($extracted.Length + 1).Replace("\", "/")
        $entry = $archive.CreateEntry($entryName, [IO.Compression.CompressionLevel]::Optimal)
        $input = [IO.File]::OpenRead($file.FullName)
        $output = $entry.Open()
        try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose() }
    }
} finally { $archive.Dispose(); $archiveStream.Dispose() }

New-Item -ItemType Directory -Path $verifyDir | Out-Null
[IO.Compression.ZipFile]::ExtractToDirectory($patched, $verifyDir)
$verifyMain = @(Get-ChildItem -LiteralPath (Join-Path $verifyDir "assets") -Filter "main-*.js" -File)[0]
$verifyText = [IO.File]::ReadAllText($verifyMain.FullName, $utf8)
if (-not $verifyText.StartsWith($currentMarker)) { throw "upgraded archive missing v24 marker" }
if (-not $verifyText.Contains($playlistAvailabilityTo) -or $verifyText.Contains($playlistAvailabilityFrom)) {
    throw "upgraded archive still blocks local playlist media behind native downloads"
}
if (-not $verifyText.Contains($endedTo) -or $verifyText.Contains($endedFrom)) {
    throw "upgraded archive still stops instead of advancing a local playlist"
}

$backup = "$source.oliviasoul-$sourceRevision.bak"
if (-not (Test-Path -LiteralPath $backup)) { Copy-Item -LiteralPath $source -Destination $backup }
Copy-Item -LiteralPath $patched -Destination $source -Force
Write-Output "upgraded=$source"
Write-Output "backup=$backup"
Write-Output "sha256=$((Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash)"
