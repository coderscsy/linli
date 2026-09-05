param(
    [Parameter(Mandatory = $true)][string]$GameRoot,
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$OriginalFile,
    [string]$ServiceUrl = "http://127.0.0.1:27149",
    [switch]$RefreshOriginal,
    [switch]$TestFixture
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "process-control.ps1")
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$source = Join-Path $GameRoot "$Version\resources\webplayer.dat"
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "webplayer.dat not found: $source" }
if (-not $TestFixture) {
    Stop-GameProcesses $GameRoot
    Start-Sleep -Milliseconds 250
}

if ($RefreshOriginal -or -not (Test-Path -LiteralPath $OriginalFile -PathType Leaf)) {
    New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($OriginalFile)) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $OriginalFile -Force
}

$buildRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\_build\webplayer-local"))
$extracted = Join-Path $buildRoot "extracted"
$patched = Join-Path $buildRoot "webplayer.patched.dat"
if (Test-Path -LiteralPath $buildRoot) { Remove-Item -LiteralPath $buildRoot -Recurse -Force }
New-Item -ItemType Directory -Path $extracted | Out-Null
[IO.Compression.ZipFile]::ExtractToDirectory($OriginalFile, $extracted)

$mainFiles = @(Get-ChildItem -LiteralPath (Join-Path $extracted "assets") -Filter "main-*.js" -File)
if ($mainFiles.Count -ne 1) { throw "expected one main-*.js, got $($mainFiles.Count)" }
$utf8 = New-Object System.Text.UTF8Encoding $false
$mainPath = $mainFiles[0].FullName
$text = [IO.File]::ReadAllText($mainPath, $utf8)
$patchMarker = '/*OliviaSoulPatch:webplayer-no-watermark-direct-http-progress-v13*/'
$watermarkShown = 'S(n)?(k(),we(l,{key:0,uid:S(n)},null,8,["uid"])):Re("",!0)'
$watermarkHidden = 'Re("",!0)'
$mountedFrom = 'ke(()=>{f==null||f(),f=qe(pe),y==null||y(),y=Je(me);for(const e of l.value)e&&R(e)})'
$playerCommandUrl = $ServiceUrl.TrimEnd("/") + "/toy/player-command"
$playerStateUrl = $ServiceUrl.TrimEnd("/") + "/toy/player-state"
$nativeControl = @'
async function OliviaSoulNativeControl(e){
  if(!e||!e.cmd)return;
  const session=window.__OliviaSoulActiveSessionId,song=window.__OliviaSoulActiveSongId;
  if(!session)return pe(e);
  if(e.cmd==="play"&&String(e.url||"").toLowerCase().includes("/assets/wallpaper_presence/")){
    window.__OliviaSoulRememberDefaultPlayback(e.url,e.offset,e.loop);return;
  }
  if(e.cmd==="pause"||e.cmd==="stop"){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),1500);
    try{
      const response=await fetch("__OLIVIA_PLAYER_STATE_URL__",{cache:"no-store",signal:controller.signal});
      if(!response.ok)throw new Error("Player state unavailable");
      const body=await response.json(),state=body&&body.data||body;
      if(!state||typeof state.playbackState!=="string")throw new Error("Invalid player state");
      if(window.__OliviaSoulActiveSessionId!==session||window.__OliviaSoulActiveSongId!==song)return;
      if(state.sessionId===session&&state.songId===song&&(state.playbackState==="stopped"||state.playbackState==="ended"))return pe(e);
      // The native manager may finish the previous official song after local
      // playback has started. Only the owning service session can finish it.
      return;
    }catch{
      // Keep native emergency stop usable if the local service has exited.
      if(window.__OliviaSoulActiveSessionId===session&&window.__OliviaSoulActiveSongId===song)return pe(e);
    }finally{clearTimeout(timer)}
    return;
  }
  if(e.cmd==="seek"||e.cmd==="resume"||e.cmd==="setLoop")return;
  return pe(e);
}
'@
$nativeControl = $nativeControl.Replace('__OLIVIA_PLAYER_STATE_URL__', $playerStateUrl)
$nativeControlFrom = 'function pe(e){'
$mountedTo = 'ke(()=>{f==null||f(),f=qe(OliviaSoulNativeControl),y==null||y(),y=Je(me);for(const e of l.value)e&&R(e);window.__OliviaSoulRememberDefaultPlayback=(e,t,c)=>{const m=String(e||"");if(!m.toLowerCase().includes("/assets/wallpaper_presence/"))return;const p=Number(t),g={url:m,offset:Number.isFinite(p)&&p>=0?p:0,loop:!!c};window.__OliviaSoulDefaultPlayback=g;try{sessionStorage.setItem("OliviaSoulDefaultPlayback",JSON.stringify(g))}catch{}},window.__OliviaSoulRestoreDefaultPlayback=()=>{const t=i.value;t&&t.pause();let e=window.__OliviaSoulDefaultPlayback;try{e=e||JSON.parse(sessionStorage.getItem("OliviaSoulDefaultPlayback")||"null")}catch{}e&&e.url?le(e.url,{loop:!!e.loop,offset:Number(e.offset)||0}):fe()};try{window.__OliviaSoulDefaultPlayback=JSON.parse(sessionStorage.getItem("OliviaSoulDefaultPlayback")||"null")}catch{}const t=i.value;t&&window.__OliviaSoulRememberDefaultPlayback(t.currentSrc||t.src,t.currentTime,t.loop),window.__OliviaSoulActivePlayerRevision=null,window.__OliviaSoulActiveSongId=null,window.__OliviaSoulActiveSessionId=null,window.__OliviaSoulPlayerCommandKey=null,window.__OliviaSoulPlayerPoll&&clearInterval(window.__OliviaSoulPlayerPoll),window.__OliviaSoulPlayerPoll=setInterval(async()=>{try{const e=await fetch("' + $playerCommandUrl + '",{cache:"no-store"}),t=await e.json(),c=t&&t.data||t;if(c&&c.command){const m=[c.revision,c.command.sessionId,c.command.cmd].join(":");if(window.__OliviaSoulPlayerCommandKey===null){window.__OliviaSoulPlayerCommandKey=m;const g=await fetch("' + $playerStateUrl + '",{cache:"no-store"}),b=await g.json(),S=b&&b.data||b;S&&S.playbackState==="playing"&&S.commandRevision===c.revision&&S.songId===c.command.songId&&S.sessionId===c.command.sessionId&&(pe({...c.command,cmd:"play",url:S.mediaUrl,songId:S.songId,name:S.name,sessionId:S.sessionId,offset:Number(S.currentTime)||0,__oliviaRevision:c.revision}),c.command.cmd!=="play"&&pe(c.command))}else if(m!==window.__OliviaSoulPlayerCommandKey){window.__OliviaSoulPlayerCommandKey=m,c.command.cmd==="play"?pe({...c.command,__oliviaRevision:c.revision}):c.command.sessionId===window.__OliviaSoulActiveSessionId&&c.command.songId===window.__OliviaSoulActiveSongId&&(window.__OliviaSoulActivePlayerRevision=c.revision,pe(c.command))}}}catch{}},200)})'
$unmountedFrom = 'Se(()=>{u!==null&&(clearTimeout(u),u=null),f==null||f(),f=null,y==null||y(),y=null});'
$unmountedTo = 'Se(()=>{u!==null&&(clearTimeout(u),u=null),f==null||f(),f=null,y==null||y(),y=null,window.__OliviaSoulPlayerPoll&&(clearInterval(window.__OliviaSoulPlayerPoll),window.__OliviaSoulPlayerPoll=null)});'
$timeUpdateFrom = 'function z(e){const t=e.target;if(t!==i.value)return;const c=t.duration||a.value;c!==a.value&&(a.value=c),Z({event:"timeupdate",currentTime:t.currentTime,duration:c})}'
$timeUpdateTo = 'function z(e){const t=e.target;if(t!==i.value)return;const c=Number.isFinite(t.duration)&&t.duration>0?t.duration:0;c&&c!==a.value&&(a.value=c);const p=String(t.currentSrc||t.src||"");if(window.__OliviaSoulActivePlayerRevision&&window.__OliviaSoulActiveSongId&&window.__OliviaSoulActiveSessionId)return fetch("' + $playerStateUrl + '",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({commandRevision:window.__OliviaSoulActivePlayerRevision,sessionId:window.__OliviaSoulActiveSessionId,songId:window.__OliviaSoulActiveSongId,mediaUrl:p,event:"timeupdate",currentTime:t.currentTime,duration:c})}).catch(()=>{});if(p.includes("/toy/midi/songs/"))return;window.__OliviaSoulRememberDefaultPlayback(p,t.currentTime,t.loop),Z({event:"timeupdate",currentTime:t.currentTime,duration:c||a.value})}'
$endedFrom = 'function q(e){var c;e.target===i.value&&(console.log("[PlaybackView] onEnded"),m?W():(c=v.value)!=null&&c.src&&(d=!0),Z({event:"ended"}))}'
$endedTo = 'function q(e){var c;if(e.target!==i.value)return;console.log("[PlaybackView] onEnded");const p=String(e.target.currentSrc||e.target.src||"");if(window.__OliviaSoulActivePlayerRevision&&window.__OliviaSoulActiveSongId&&window.__OliviaSoulActiveSessionId)return fetch("' + $playerStateUrl + '",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({commandRevision:window.__OliviaSoulActivePlayerRevision,sessionId:window.__OliviaSoulActiveSessionId,songId:window.__OliviaSoulActiveSongId,mediaUrl:p,event:"ended",currentTime:e.target.currentTime,duration:e.target.duration||a.value||0})}).catch(()=>{});if(p.includes("/toy/midi/songs/"))return;m?W():(c=v.value)!=null&&c.src&&(d=!0),Z({event:"ended"})}'
$playFrom = 'case"play":typeof e.url=="string"&&e.url&&le(e.url,{loop:e.loop,mute:e.mute,offset:e.offset});break;'
# Unload the previous native/CDN resource before le() chooses its loading path.
# With no active src, local playback reloads the current element instead of
# inheriting the previous source through the dual-video canplaythrough handoff.
$playTo = 'case"play":{if(typeof e.url=="string"&&e.url){if(e.sessionId){const t=i.value;t&&window.__OliviaSoulRememberDefaultPlayback(t.currentSrc||t.src,t.currentTime,t.loop),window.__OliviaSoulActivePlayerRevision=null,window.__OliviaSoulActiveSongId=null,window.__OliviaSoulActiveSessionId=null,t&&(t.pause(),t.removeAttribute("src"),t.load()),le(e.url,{loop:!1,mute:e.mute,offset:e.offset}),window.__OliviaSoulActivePlayerRevision=Number(e.__oliviaRevision)||null,window.__OliviaSoulActiveSongId=e.songId,window.__OliviaSoulActiveSessionId=e.sessionId}else window.__OliviaSoulRememberDefaultPlayback(e.url,e.offset,e.loop),window.__OliviaSoulActivePlayerRevision=null,window.__OliviaSoulActiveSongId=null,window.__OliviaSoulActiveSessionId=null,le(e.url,{loop:!!e.loop,mute:e.mute,offset:e.offset})}break}'
$preloadFrom = 'case"preload":typeof e.url=="string"&&e.url&&ae(e.url);break;'
$preloadTo = 'case"preload":typeof e.url=="string"&&e.url&&(!window.__OliviaSoulDefaultPlayback&&window.__OliviaSoulRememberDefaultPlayback(e.url,0,!1),ae(e.url));break;'
$stopFrom = 'case"pause":ue();break;case"stop":fe();break;'
$stopTo = 'case"pause":case"stop":if(e.sessionId&&(e.sessionId!==window.__OliviaSoulActiveSessionId||e.songId!==window.__OliviaSoulActiveSongId))break;window.__OliviaSoulActivePlayerRevision=null,window.__OliviaSoulActiveSongId=null,window.__OliviaSoulActiveSessionId=null,e.cmd==="stop"&&e.restoreDefault===!1?i.value&&i.value.pause():window.__OliviaSoulRestoreDefaultPlayback();break;'
if ($text.Contains($patchMarker)) { throw "original webplayer already contains current patch" }
$count = ([regex]::Matches($text, [regex]::Escape($watermarkShown))).Count
if ($count -ne 1) { throw "expected one webplayer UID watermark render, got $count" }
$mountedCount = ([regex]::Matches($text, [regex]::Escape($mountedFrom))).Count
if ($mountedCount -ne 1) { throw "expected one webplayer mounted hook, got $mountedCount" }
$unmountedCount = ([regex]::Matches($text, [regex]::Escape($unmountedFrom))).Count
if ($unmountedCount -ne 1) { throw "expected one webplayer unmounted hook, got $unmountedCount" }
$timeUpdateCount = ([regex]::Matches($text, [regex]::Escape($timeUpdateFrom))).Count
if ($timeUpdateCount -ne 1) { throw "expected one webplayer timeupdate handler, got $timeUpdateCount" }
$endedCount = ([regex]::Matches($text, [regex]::Escape($endedFrom))).Count
if ($endedCount -ne 1) { throw "expected one webplayer ended handler, got $endedCount" }
$playCount = ([regex]::Matches($text, [regex]::Escape($playFrom))).Count
if ($playCount -ne 1) { throw "expected one webplayer play command, got $playCount" }
$preloadCount = ([regex]::Matches($text, [regex]::Escape($preloadFrom))).Count
if ($preloadCount -ne 1) { throw "expected one webplayer preload command, got $preloadCount" }
$stopCount = ([regex]::Matches($text, [regex]::Escape($stopFrom))).Count
if ($stopCount -ne 1) { throw "expected one webplayer stop command, got $stopCount" }
$nativeControlCount = ([regex]::Matches($text, [regex]::Escape($nativeControlFrom))).Count
if ($nativeControlCount -ne 1) { throw "expected one webplayer native command handler, got $nativeControlCount" }
$text = $patchMarker + $text.Replace($watermarkShown, $watermarkHidden).Replace($mountedFrom, $mountedTo).Replace($unmountedFrom, $unmountedTo).Replace($timeUpdateFrom, $timeUpdateTo).Replace($endedFrom, $endedTo).Replace($playFrom, $playTo).Replace($preloadFrom, $preloadTo).Replace($stopFrom, $stopTo).Replace($nativeControlFrom, ($nativeControl + $nativeControlFrom))
[IO.File]::WriteAllText($mainPath, $text, $utf8)

$archiveStream = [IO.File]::Open($patched, [IO.FileMode]::Create)
$archive = New-Object -TypeName IO.Compression.ZipArchive -ArgumentList @(
    $archiveStream,
    [IO.Compression.ZipArchiveMode]::Create,
    $false
)
try {
    foreach ($file in Get-ChildItem -LiteralPath $extracted -File -Recurse) {
        $entryName = $file.FullName.Substring($extracted.Length + 1).Replace("\", "/")
        $entry = $archive.CreateEntry($entryName, [IO.Compression.CompressionLevel]::Optimal)
        $input = [IO.File]::OpenRead($file.FullName)
        $output = $entry.Open()
        try { $input.CopyTo($output) }
        finally { $output.Dispose(); $input.Dispose() }
    }
}
finally {
    $archive.Dispose()
    $archiveStream.Dispose()
}
Copy-Item -LiteralPath $patched -Destination $source -Force

$verifyDir = Join-Path $buildRoot "verify"
New-Item -ItemType Directory -Path $verifyDir | Out-Null
[IO.Compression.ZipFile]::ExtractToDirectory($source, $verifyDir)
$verifyMain = @(Get-ChildItem -LiteralPath (Join-Path $verifyDir "assets") -Filter "main-*.js" -File)
if ($verifyMain.Count -ne 1) { throw "patched archive does not contain exactly one main-*.js" }
$verifyText = [IO.File]::ReadAllText($verifyMain[0].FullName, $utf8)
if (-not $verifyText.StartsWith($patchMarker)) { throw "patched webplayer archive is missing revision marker" }
if ($verifyText.Contains($watermarkShown)) { throw "patched webplayer still renders the UID watermark" }
if (-not $verifyText.Contains($mountedTo)) { throw "patched webplayer does not poll the local playback command" }
if ($verifyText.Contains($mountedFrom)) { throw "patched webplayer retains the original mounted hook" }
if (-not $verifyText.Contains($unmountedTo)) { throw "patched webplayer does not dispose the local playback poll" }
if (-not $verifyText.Contains($timeUpdateTo)) { throw "patched webplayer does not publish playback progress" }
if (-not $verifyText.Contains($endedTo)) { throw "patched webplayer does not publish playback completion" }
if (-not $verifyText.Contains($playTo)) { throw "patched webplayer does not stop the previous local media before switching" }
if (-not $verifyText.Contains($preloadTo)) { throw "patched webplayer does not remember preloaded default wallpaper media" }
if (-not $verifyText.Contains($stopTo)) { throw "patched webplayer does not restore the remembered default wallpaper" }
if (-not $verifyText.Contains($nativeControl)) { throw "patched webplayer does not isolate native and local playback sessions" }

Write-Output "patched=$source"
Write-Output "sha256=$((Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash)"
