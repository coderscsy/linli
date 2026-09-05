param(
    [Parameter(Mandatory = $true)][string]$GameRoot,
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$ServiceUrl = "http://127.0.0.1:27149"
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "process-control.ps1")
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$source = Join-Path $GameRoot "$Version\resources\webplayer.dat"
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "webplayer.dat not found: $source" }
Stop-GameProcesses $GameRoot
Start-Sleep -Milliseconds 250

$buildRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\_build\webplayer-upgrade-v8"))
$extracted = Join-Path $buildRoot "extracted"
$verifyDir = Join-Path $buildRoot "verify"
$patched = Join-Path $buildRoot "webplayer.patched.dat"
if (Test-Path -LiteralPath $buildRoot) { Remove-Item -LiteralPath $buildRoot -Recurse -Force }
New-Item -ItemType Directory -Path $extracted | Out-Null
[IO.Compression.ZipFile]::ExtractToDirectory($source, $extracted)

$mainFiles = @(Get-ChildItem -LiteralPath (Join-Path $extracted "assets") -Filter "main-*.js" -File)
if ($mainFiles.Count -ne 1) { throw "expected one main-*.js, got $($mainFiles.Count)" }
$utf8 = New-Object System.Text.UTF8Encoding $false
$mainPath = $mainFiles[0].FullName
$text = [IO.File]::ReadAllText($mainPath, $utf8)
$v6Marker = '/*OliviaSoulPatch:webplayer-no-watermark-direct-http-progress-v6*/'
$v7Marker = '/*OliviaSoulPatch:webplayer-no-watermark-direct-http-progress-v7*/'
$currentMarker = '/*OliviaSoulPatch:webplayer-no-watermark-direct-http-progress-v8*/'
if (-not ($text.StartsWith($v6Marker) -or $text.StartsWith($v7Marker))) { throw "webplayer is not an OliviaSoul v6/v7 patch" }
$sourceRevision = if ($text.StartsWith($v6Marker)) { "v6" } else { "v7" }
if ($sourceRevision -eq "v6") { $text = $v7Marker + $text.Substring($v6Marker.Length) }

$pollFrom = 'window.__OliviaSoulPlayerCommandKey="",window.__OliviaSoulPlayerPoll&&clearInterval(window.__OliviaSoulPlayerPoll),window.__OliviaSoulPlayerPoll=setInterval(async()=>{try{const e=await fetch("http://127.0.0.1:27149/toy/player-command",{cache:"no-store"}),t=await e.json(),c=t&&t.data||t;if(c&&c.command){const m=[c.revision,c.command.sessionId,c.command.cmd].join(":");m!==window.__OliviaSoulPlayerCommandKey&&(window.__OliviaSoulPlayerCommandKey=m,window.__OliviaSoulActivePlayerRevision=c.revision,window.__OliviaSoulActiveSongId=c.command.songId,window.__OliviaSoulActiveSessionId=c.command.sessionId,pe(c.command))}}catch{}},200)'
$commandUrl = $ServiceUrl.TrimEnd("/") + "/toy/player-command"
$pollTo = 'window.__OliviaSoulPlayerCommandKey=null,window.__OliviaSoulPlayerPoll&&clearInterval(window.__OliviaSoulPlayerPoll),window.__OliviaSoulPlayerPoll=setInterval(async()=>{try{const e=await fetch("' + $commandUrl + '",{cache:"no-store"}),t=await e.json(),c=t&&t.data||t;if(c&&c.command){const m=[c.revision,c.command.sessionId,c.command.cmd].join(":");if(window.__OliviaSoulPlayerCommandKey===null){window.__OliviaSoulPlayerCommandKey=m,c.command.cmd==="play"&&(window.__OliviaSoulActivePlayerRevision=c.revision,window.__OliviaSoulActiveSongId=c.command.songId,window.__OliviaSoulActiveSessionId=c.command.sessionId,pe(c.command))}else m!==window.__OliviaSoulPlayerCommandKey&&(window.__OliviaSoulPlayerCommandKey=m,window.__OliviaSoulActivePlayerRevision=c.revision,window.__OliviaSoulActiveSongId=c.command.songId,window.__OliviaSoulActiveSessionId=c.command.sessionId,pe(c.command))}}catch{}},200)'
$pollCount = ([regex]::Matches($text, [regex]::Escape($pollFrom))).Count
if ($sourceRevision -eq "v6") {
    if ($pollCount -ne 1) { throw "expected one v6 player command poll, got $pollCount" }
    $text = $text.Replace($pollFrom, $pollTo)
} elseif (-not $text.Contains($pollTo)) {
    throw "v7 webplayer is missing the stale-command guard"
}
$endedFrom = 'function q(e){var c;e.target===i.value&&(console.log("[PlaybackView] onEnded"),m?W():(c=v.value)!=null&&c.src&&(d=!0),window.__OliviaSoulActivePlayerRevision&&window.__OliviaSoulActiveSongId&&window.__OliviaSoulActiveSessionId&&fetch("' + $ServiceUrl.TrimEnd("/") + '/toy/player-state",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({commandRevision:window.__OliviaSoulActivePlayerRevision,sessionId:window.__OliviaSoulActiveSessionId,songId:window.__OliviaSoulActiveSongId,mediaUrl:e.target.currentSrc||e.target.src,event:"ended",currentTime:e.target.currentTime,duration:e.target.duration||a.value||0})}).catch(()=>{}),Z({event:"ended"}))}'
$endedTo = $endedFrom.Replace(',Z({event:"ended"}))}', ',window.__OliviaSoulActiveSessionId||Z({event:"ended"}))}')
$playFrom = 'case"play":typeof e.url=="string"&&e.url&&(e.sessionId&&i.value&&i.value.pause(),le(e.url,{loop:e.loop,mute:e.mute,offset:e.offset}));break;'
$playTo = 'case"play":{if(typeof e.url=="string"&&e.url){if(e.sessionId){const t=i.value&&(i.value.currentSrc||i.value.src);t&&!t.includes("/toy/midi/songs/")&&(window.__OliviaSoulDefaultPlaybackUrl=t),i.value&&i.value.pause()}else window.__OliviaSoulDefaultPlaybackUrl=e.url,window.__OliviaSoulActivePlayerRevision=null,window.__OliviaSoulActiveSongId=null,window.__OliviaSoulActiveSessionId=null;le(e.url,{loop:e.loop,mute:e.mute,offset:e.offset})}break}'
$stopFrom = 'case"stop":fe();break;'
$stopTo = 'case"stop":window.__OliviaSoulActivePlayerRevision=null,window.__OliviaSoulActiveSongId=null,window.__OliviaSoulActiveSessionId=null,window.__OliviaSoulDefaultPlaybackUrl?le(window.__OliviaSoulDefaultPlaybackUrl,{loop:!0}):fe();break;'
foreach ($replacement in @(@($endedFrom, $endedTo), @($playFrom, $playTo), @($stopFrom, $stopTo))) {
    $count = ([regex]::Matches($text, [regex]::Escape($replacement[0]))).Count
    if ($count -ne 1) { throw "expected one v7 playback fragment, got $count" }
    $text = $text.Replace($replacement[0], $replacement[1])
}
$text = $currentMarker + $text.Substring($v7Marker.Length)
$text = [regex]::Replace($text, 'http://127\.0\.0\.1:\d+/toy/player-state', $ServiceUrl.TrimEnd("/") + "/toy/player-state")
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
if (-not $verifyText.StartsWith($currentMarker)) { throw "upgraded webplayer missing v8 marker" }
if (-not $verifyText.Contains($pollTo) -or $verifyText.Contains($pollFrom)) {
    throw "upgraded webplayer still replays the stale startup command"
}
if (-not $verifyText.Contains($playTo) -or -not $verifyText.Contains($stopTo) -or -not $verifyText.Contains($endedTo)) {
    throw "upgraded webplayer does not preserve default wallpaper and local playlist completion"
}

$backup = "$source.oliviasoul-$sourceRevision.bak"
if (-not (Test-Path -LiteralPath $backup)) { Copy-Item -LiteralPath $source -Destination $backup }
Copy-Item -LiteralPath $patched -Destination $source -Force
Write-Output "upgraded=$source"
Write-Output "backup=$backup"
Write-Output "sha256=$((Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash)"
