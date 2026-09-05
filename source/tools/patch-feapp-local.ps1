param(
    [Parameter(Mandatory = $true)][string]$GameRoot,
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$OriginalFile,
    [string]$ServiceUrl = "http://127.0.0.1:27149",
    [switch]$RefreshOriginal,
    [switch]$PatchNativeOfflineChecks
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "process-control.ps1")
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$relative = "$Version\resources\feapp.dat"
$source = Join-Path $GameRoot $relative
Stop-GameProcesses $GameRoot
Start-Sleep -Milliseconds 250
if ($RefreshOriginal) {
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "current feapp.dat not found: $source" }
    New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($OriginalFile)) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $OriginalFile -Force
} elseif (-not (Test-Path -LiteralPath $OriginalFile)) {
    New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($OriginalFile)) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $OriginalFile -Force
}
$buildRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\_build\feapp-local"))
$extracted = Join-Path $buildRoot "extracted"
$patched = Join-Path $buildRoot "feapp.patched.dat"

if (Test-Path -LiteralPath $buildRoot) {
    Remove-Item -LiteralPath $buildRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $extracted | Out-Null
[IO.Compression.ZipFile]::ExtractToDirectory($OriginalFile, $extracted)

$mainFiles = @(Get-ChildItem -LiteralPath (Join-Path $extracted "assets") -Filter "main-*.js" -File)
if ($mainFiles.Count -ne 1) { throw "expected one main-*.js, got $($mainFiles.Count)" }

$utf8 = New-Object System.Text.UTF8Encoding $false
$mainPath = $mainFiles[0].FullName
$text = [IO.File]::ReadAllText($mainPath, $utf8)
$patchMarker = '/*OliviaSoulPatch:mail-music-v32*/'
if ($text.Contains($patchMarker)) { throw "original feapp already contains current patch" }
$text = $patchMarker + $text
$playerCommandUrl = $ServiceUrl.TrimEnd("/") + "/toy/player-command"
$playerStateUrl = $ServiceUrl.TrimEnd("/") + "/toy/player-state"
$songEditorSourcePath = Join-Path $PSScriptRoot "..\local-service\public\song-editor.js"
if (-not (Test-Path -LiteralPath $songEditorSourcePath -PathType Leaf)) { $songEditorSourcePath = Join-Path $PSScriptRoot "song-editor.js" }
if (-not (Test-Path -LiteralPath $songEditorSourcePath -PathType Leaf)) { throw "shared song-editor.js companion is missing" }
$songEditorSource = [IO.File]::ReadAllText($songEditorSourcePath, $utf8)
$songEditorBase = $ServiceUrl.TrimEnd("/") + "/toy"
$songEditorBridge = @'
function OliviaSoulEditSong(song){
  if(!String(song&&song.videoUrl||"").includes("/toy/midi/songs/"))return;
  return window.OliviaSoulSongEditor.open({baseUrl:"__OLIVIA_SONG_EDITOR_BASE__",songId:window.OliviaSoulSongEditor.stableId(song)});
}
'@
$songEditorBridge = $songEditorBridge.Replace('__OLIVIA_SONG_EDITOR_BASE__', $songEditorBase)
$songTitleSync = @'
function OliviaSoulApplySongMetadata(metadata){window.OliviaSoulSongEditor.applyMetadata([...x.value,u.value,f.value],metadata)}
let OliviaSoulTitleBusy=false,OliviaSoulTitleEpoch=0;
window.addEventListener("oliviasoul-song-metadata",event=>{OliviaSoulTitleEpoch++;OliviaSoulApplySongMetadata(event.detail)});
setInterval(async()=>{
  if(OliviaSoulTitleBusy)return;
  const records=[u.value,f.value,...x.value].filter(item=>String(item&&item.videoUrl||"").includes("/toy/midi/songs/"));
  const ids=[...new Set(records.map(item=>window.OliviaSoulSongEditor.stableId(item)))],epoch=OliviaSoulTitleEpoch;
  OliviaSoulTitleBusy=true;
  try{for(let index=0;index<ids.length;index+=4)await Promise.all(ids.slice(index,index+4).map(async id=>{
    try{const response=await fetch("__OLIVIA_SONG_EDITOR_BASE__/media/songs/"+encodeURIComponent(id)+"/metadata",{cache:"no-store"}),body=await response.json();
      if(response.ok&&Number(body&&body.code)===0&&String(body.data&&body.data.id)===id&&epoch===OliviaSoulTitleEpoch)OliviaSoulApplySongMetadata(body.data);
    }catch{}
  }))}finally{OliviaSoulTitleBusy=false}
},5000);
'@
$songTitleSync = $songTitleSync.Replace('__OLIVIA_SONG_EDITOR_BASE__', $songEditorBase)
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

foreach ($endpoint in $endpoints) {
    $from = '"' + $endpoint + '"'
    $to = '"' + $ServiceUrl.TrimEnd("/") + "/toy" + $endpoint + '"'
    $count = ([regex]::Matches($text, [regex]::Escape($from))).Count
    if ($count -ne 1) { throw "expected one endpoint occurrence for $endpoint, got $count" }
    $text = $text.Replace($from, $to)
}

$directControlFrom = 'Ct=e=>We({action:"sendWebPlayerControlCmd",data:e})'
# A user can stop after the service accepted play but before its session response
# reaches FE. Capture that exact play Promise before the UI clears its globals.
# If the accepted response is lost, recover only while this pending play still
# owns the FE generation; never borrow the session of a replacement play.
$directControlTo = 'Ct=e=>{const t=window.__OliviaSoulSongId,s=e&&e.cmd==="pause"?{...e,cmd:"stop"}:e,o=String(window.__OliviaSoulSessionId||"");if(s.cmd==="timeupdate"&&window.__OliviaSoulApplyingProgress)return Promise.resolve();if(!t)return We({action:"sendWebPlayerControlCmd",data:s});let r=null,h=!1;const n=Number(window.__OliviaSoulSessionEpoch||0);if(s.cmd==="timeupdate")window.__OliviaSoulSeekingUntil=Date.now()+800,r={cmd:"seek",offset:s.position,songId:t,sessionId:o};else if(s.cmd==="play"&&s.song&&String(s.song.id)===String(t))window.__OliviaSoulCommandRevision=null,window.__OliviaSoulSessionId=null,r={cmd:"play",url:s.song.videoUrl,songId:String(s.song.id),name:s.song.name};else if(["stop","resume"].includes(s.cmd))r={cmd:s.cmd,songId:t,sessionId:o};else if(s.cmd==="setVolume")r={cmd:"setVolume",volume:s.data&&s.data.muted?0:Number(s.data&&s.data.mainVolume)||0,songId:t,sessionId:o};else if(s.cmd==="play"&&s.song&&String(s.song.id)!==String(t)){const i={cmd:"stop",songId:t,sessionId:o,restoreDefault:!1};return window.__OliviaSoulSongId=null,window.__OliviaSoulCommandRevision=null,window.__OliviaSoulSessionId=null,window.__OliviaSoulEndingSessionId=null,window.__OliviaSoulSessionEpoch=n+1,fetch("' + $playerCommandUrl + '",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(i)}).catch(()=>null).then(()=>We({action:"sendWebPlayerControlCmd",data:s}))}if(!r)return We({action:"sendWebPlayerControlCmd",data:s});const p=window.__OliviaSoulPendingPlay,g=()=>{const l=Number(window.__OliviaSoulSessionEpoch||0),a=String(window.__OliviaSoulSongId||"");return window.__OliviaSoulPendingPlay===p&&(l===n&&a===String(t)||l===n+1&&!a&&!window.__OliviaSoulSessionId)},u=l=>new Promise((a,d)=>{const f=setTimeout(()=>d(new Error("local player request timeout")),1500);Promise.resolve(l).then(v=>{clearTimeout(f),a(v)},v=>{clearTimeout(f),d(v)})}),c=s.cmd==="stop"&&!o&&p&&p.songId===String(t)&&p.epoch===n?u(p.promise).catch(async()=>{if(!g())throw new Error("local player session changed");const l=await u(fetch("' + $playerStateUrl + '",{cache:"no-store"}));if(!l.ok)throw new Error("local player state unavailable");const a=await u(l.json()),d=a&&a.data||a;if(!g()||Number(a&&a.code)!==0||String(d&&d.songId)!==String(t)||typeof(d&&d.sessionId)!=="string"||!d.sessionId.trim())throw new Error("local player session unavailable");return h=!0,{command:{sessionId:d.sessionId}}}).then(l=>{const a=String(l&&l.command&&l.command.sessionId||"");if(!a)throw new Error("local player session unavailable");return{...r,sessionId:a}}):null,b=l=>{if(h&&!g())return Promise.reject(new Error("local player session changed"));return fetch("' + $playerCommandUrl + '",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(l)})},i=(c?c.then(b):b(r)).then(l=>{if(!l.ok)throw new Error("local player command failed");return l.json()}).then(l=>{if(Number(l&&l.code)!==0)throw new Error(l&&l.message||"local player command failed");const a=l&&l.data||l;if(Number(window.__OliviaSoulSessionEpoch||0)===n&&String(window.__OliviaSoulSongId)===String(t))window.__OliviaSoulCommandRevision=a.revision,window.__OliviaSoulSessionId=a.command&&a.command.sessionId||window.__OliviaSoulSessionId;return a});return r.cmd==="play"&&(window.__OliviaSoulPendingPlay={songId:String(t),epoch:n,promise:i}),s.cmd==="stop"&&We({action:"sendWebPlayerControlCmd",data:{cmd:"stop"}}).catch(()=>{}),i}'
$directControlCount = ([regex]::Matches($text, [regex]::Escape($directControlFrom))).Count
if ($directControlCount -ne 1) { throw "expected one webplayer control bridge, got $directControlCount" }
$text = $text.Replace($directControlFrom, $directControlTo)

$songlistProgressFrom = 'source:"songlist",eventId:Ee},h.value="songlist"'
$songlistProgressTo = 'source:"songlist",eventId:Ee},d.value=0,h.value="songlist"'
$songlistProgressCount = ([regex]::Matches($text, [regex]::Escape($songlistProgressFrom))).Count
if ($songlistProgressCount -ne 1) { throw "expected one songlist playback initializer, got $songlistProgressCount" }
$text = $text.Replace($songlistProgressFrom, $songlistProgressTo)

$toggleLocalFrom = 'else if(m.value)w("stop_button"),Ct({cmd:"stop"}),m.value=!1,u.value=null,f.value=null,d.value=0;else if(h.value==="songlist"&&f.value){const{duration:B,...K}=f.value;Ct({cmd:"play",song:K}),m.value=!0}else u.value&&M(u.value)'
$toggleLocalTo = 'else if(m.value)w("stop_button"),Ct({cmd:"stop"}),m.value=!1,u.value=null,f.value=null,d.value=0,window.__OliviaSoulSongId=null,window.__OliviaSoulCommandRevision=null,window.__OliviaSoulSessionId=null,window.__OliviaSoulEndingSessionId=null,window.__OliviaSoulSessionEpoch=Number(window.__OliviaSoulSessionEpoch||0)+1;else if(h.value==="songlist"&&f.value){const{duration:B,...K}=f.value;Ct({cmd:"play",song:K}),m.value=!0}else u.value&&M(u.value)'
$toggleLocalCount = ([regex]::Matches($text, [regex]::Escape($toggleLocalFrom))).Count
if ($toggleLocalCount -ne 1) { throw "expected one songlist play toggle, got $toggleLocalCount" }
$text = $text.Replace($toggleLocalFrom, $toggleLocalTo)

$playerStateStoreFrom = 'Ge=()=>{m.value&&z(),G(),h.value="playlist",x.value=[],I.value=[]};return{isSongAvailable:a'
$playerStateStoreTo = 'Ge=()=>{m.value&&z(),G(),h.value="playlist",x.value=[],I.value=[]},OliviaSoulFinishLocalPlayback=async B=>{const K=Number(window.__OliviaSoulSessionEpoch||0),W=String(window.__OliviaSoulSongId||""),ue=String(B.sessionId||"");if(!W||String(B.songId)!==W||window.__OliviaSoulEndingSessionId===ue)return;window.__OliviaSoulEndingSessionId=ue;const re=h.value==="songlist";let ye=!1;try{const Ee=await fetch("' + $playerCommandUrl + '",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({cmd:"stop",songId:W,sessionId:ue,restoreDefault:re})}),ee=await Ee.json();ye=Ee.ok&&Number(ee&&ee.code)===0}catch{}if(Number(window.__OliviaSoulSessionEpoch||0)!==K||String(window.__OliviaSoulSongId||"")!==W){window.__OliviaSoulEndingSessionId===ue&&(window.__OliviaSoulEndingSessionId=null);return}if(!ye)return We({action:"sendWebPlayerControlCmd",data:{cmd:"stop"}}).catch(()=>{}),window.__OliviaSoulSongId=null,window.__OliviaSoulCommandRevision=null,window.__OliviaSoulSessionId=null,window.__OliviaSoulEndingSessionId=null,window.__OliviaSoulSessionEpoch=K+1,G();re&&We({action:"sendWebPlayerControlCmd",data:{cmd:"stop"}}).catch(()=>{}),window.__OliviaSoulSongId=null,window.__OliviaSoulCommandRevision=null,window.__OliviaSoulSessionId=null,window.__OliviaSoulEndingSessionId=null,window.__OliviaSoulSessionEpoch=K+1;if(re){G();return}window.__OliviaSoulApplyingProgress=!0,d.value=0;queueMicrotask(()=>{window.__OliviaSoulApplyingProgress=!1});const Le=u.value&&u.value.itemId;p.value===ot.Single&&u.value&&a(u.value)?M(u.value):U(),queueMicrotask(()=>{Number(window.__OliviaSoulSessionEpoch||0)===K+1&&!window.__OliviaSoulSongId&&!m.value&&u.value&&u.value.itemId===Le&&(We({action:"sendWebPlayerControlCmd",data:{cmd:"stop"}}).catch(()=>{}),G())})},OliviaSoulApplyPlayerState=B=>{if(String(B.songId)!==String(window.__OliviaSoulSongId)||String(B.sessionId)!==String(window.__OliviaSoulSessionId))return;const OliviaSoulDuration=Number(B.duration);if(Number.isFinite(OliviaSoulDuration)&&OliviaSoulDuration>0)for(const OliviaSoulItem of [u.value,f.value])OliviaSoulItem&&window.OliviaSoulSongEditor.stableId(OliviaSoulItem)===String(B.songId)&&(OliviaSoulItem.duration=OliviaSoulDuration,OliviaSoulItem.videoDuration=OliviaSoulDuration);if(B.playbackState==="ended"){if(window.__OliviaSoulEndingSessionId===String(B.sessionId||""))return;w("natural_end"),m.value=!1,OliviaSoulFinishLocalPlayback(B);return}d.value=Number(B.currentTime)||0,m.value=B.playbackState==="playing"},OliviaSoulEnsurePlayerPoll=()=>{window.__OliviaSoulProgressPoll||(window.__OliviaSoulProgressPoll=setInterval(async()=>{if(!window.__OliviaSoulSongId||!window.__OliviaSoulSessionId||window.__OliviaSoulProgressPending)return;window.__OliviaSoulProgressPending=!0;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),1500);try{const B=await fetch("' + $playerStateUrl + '",{cache:"no-store",signal:controller.signal}),K=await B.json(),W=K&&K.data||K;W&&W.songId===window.__OliviaSoulSongId&&W.commandRevision===window.__OliviaSoulCommandRevision&&W.sessionId===window.__OliviaSoulSessionId&&Date.now()>Number(window.__OliviaSoulSeekingUntil||0)&&(window.__OliviaSoulApplyingProgress=!0,OliviaSoulApplyPlayerState(W),queueMicrotask(()=>{window.__OliviaSoulApplyingProgress=!1}))}catch{}finally{clearTimeout(timer),window.__OliviaSoulProgressPending=!1}},250))},OliviaSoulSongIdFromItem=B=>{const K=String(B&&B.videoUrl||""),W=K.match(/\/toy\/midi\/songs\/([^\/?#]+)/);return W?decodeURIComponent(W[1]):String(B&&(B.songId||B.id||B.itemId)||"")},OliviaSoulBeginLocalPlayback=B=>{const K=OliviaSoulSongIdFromItem(B);return window.__OliviaSoulSessionEpoch=Number(window.__OliviaSoulSessionEpoch||0)+1,window.__OliviaSoulSongId=K,window.__OliviaSoulCommandRevision=null,window.__OliviaSoulSessionId=null,window.__OliviaSoulEndingSessionId=null,d.value=0,m.value=!0,OliviaSoulEnsurePlayerPoll(),K};return{isSongAvailable:a'
$playerStateStoreCount = ([regex]::Matches($text, [regex]::Escape($playerStateStoreFrom))).Count
if ($playerStateStoreCount -ne 1) { throw "expected one player store return, got $playerStateStoreCount" }
$text = $text.Replace($playerStateStoreFrom, $playerStateStoreTo)
$playerStateExportFrom = 'playSonglistItem:A,resetStore:Ge}})'
$playerStateExportTo = 'playSonglistItem:A,applyLocalPlayerState:OliviaSoulApplyPlayerState,beginLocalPlayback:OliviaSoulBeginLocalPlayback,applySongMetadata:OliviaSoulApplySongMetadata,resetStore:Ge}})'
$playerStateExportCount = ([regex]::Matches($text, [regex]::Escape($playerStateExportFrom))).Count
if ($playerStateExportCount -ne 1) { throw "expected one player store export, got $playerStateExportCount" }
$text = $text.Replace($playerStateExportFrom, $playerStateExportTo)
$songTitleSyncFrom = 'const te=j(()=>{if(h.value==="songlist"&&f.value)return f.value;'
if (([regex]::Matches($text,[regex]::Escape($songTitleSyncFrom))).Count -ne 1) { throw "expected one local title store anchor" }
$text = $text.Replace($songTitleSyncFrom, ($songTitleSync + $songTitleSyncFrom))
$songEditorRowFrom = 'n("p",Ox,v(X.song.originalAuthor)+" • "+v(o(G)),1)],2)'
$songEditorRowTo = 'n("p",Ox,v(X.song.originalAuthor)+" • "+v(o(G)),1),String(X.song.videoUrl||"").includes("/toy/midi/songs/")?n("button",{type:"button",style:{fontSize:"12px",textAlign:"left",color:"#4c8778",marginTop:"4px"},onClick:Oe(()=>OliviaSoulEditSong(X.song),["stop"]),onDblclick:Oe(()=>{},["stop"])},"名称 / 时段"):Y("",!0)],2)'
if (([regex]::Matches($text,[regex]::Escape($songEditorRowFrom))).Count -ne 1) { throw "expected one local song row editor anchor" }
$text = $text.Replace($songEditorRowFrom, $songEditorRowTo)

$playlistAvailabilityFrom = 'a=B=>{var W;if(t.value!==Se.LITE)return!0;const K=l(B);return K?((W=i.getDownloadEntry(K))==null?void 0:W.state)==="completed":!0}'
$playlistAvailabilityTo = 'a=B=>{var W;if(String(B&&B.videoUrl||"").includes("/toy/midi/songs/"))return!0;if(t.value!==Se.LITE)return!0;const K=l(B);return K?((W=i.getDownloadEntry(K))==null?void 0:W.state)==="completed":!0}'
$playlistAvailabilityCount = ([regex]::Matches($text, [regex]::Escape($playlistAvailabilityFrom))).Count
if ($playlistAvailabilityCount -ne 1) { throw "expected one playlist availability guard, got $playlistAvailabilityCount" }
$text = $text.Replace($playlistAvailabilityFrom, $playlistAvailabilityTo)

$playlistLocalPlayFrom = 'const ue="videoUrl"in B?B.videoUrl??"":"",re="songNameKey"in B?B.songNameKey:B.nameKey,ye="videoByTodView"in B?B.videoByTodView:void 0,Ee="coverUrl"in B?B.coverUrl??"":"iconUrl"in B?B.iconUrl??"":"";Ct({cmd:"play",song:{id:B.itemId'
$playlistLocalPlayTo = 'const ue="videoUrl"in B?B.videoUrl??"":"",re="songNameKey"in B?B.songNameKey:B.nameKey,ye="videoByTodView"in B?B.videoByTodView:void 0,Ee="coverUrl"in B?B.coverUrl??"":"iconUrl"in B?B.iconUrl??"":"",OliviaSoulLocalId=ue.includes("/toy/midi/songs/")?OliviaSoulBeginLocalPlayback({...B,videoUrl:ue}):B.itemId;Ct({cmd:"play",song:{id:OliviaSoulLocalId'
$playlistLocalPlayCount = ([regex]::Matches($text, [regex]::Escape($playlistLocalPlayFrom))).Count
if ($playlistLocalPlayCount -ne 1) { throw "expected one playlist local playback bridge, got $playlistLocalPlayCount" }
$text = $text.Replace($playlistLocalPlayFrom, $playlistLocalPlayTo)

$mailboxDisabled = 'N3=!1,Ss=!1,wa=({onComplete'
$mailboxEnabled = 'N3=!0,Ss=!1,wa=({onComplete'
$mailboxCount = ([regex]::Matches($text, [regex]::Escape($mailboxDisabled))).Count
if ($mailboxCount -ne 1) { throw "expected one disabled mailbox entry, got $mailboxCount" }
$text = $text.Replace($mailboxDisabled, $mailboxEnabled)

$offlineWidgetsDisabled = 'e.isOfflineMode&&(l.value.mailWidget!==!1&&(l.value.mailWidget=!1),l.value.musicWidget!==!1&&(l.value.musicWidget=!1))'
$offlineWidgetsEnabled = 'l.value.mailWidget=!0,l.value.musicWidget=!0'
$offlineWidgetsCount = ([regex]::Matches($text, [regex]::Escape($offlineWidgetsDisabled))).Count
if ($offlineWidgetsCount -ne 1) { throw "expected one offline widget lock, got $offlineWidgetsCount" }
$text = $text.Replace($offlineWidgetsDisabled, $offlineWidgetsEnabled)

$settingsInitFrom = 'l.value={...l.value,...p}};let c='
$settingsInitTo = 'c={...p},l.value={...l.value,...p,mailWidget:!0,musicWidget:!0}};let c='
$settingsInitCount = ([regex]::Matches($text, [regex]::Escape($settingsInitFrom))).Count
if ($settingsInitCount -ne 1) { throw "expected one settings initializer, got $settingsInitCount" }
$text = $text.Replace($settingsInitFrom, $settingsInitTo)

$offlineWidgetResyncFrom = 'if(await h(M,Cn,!1)){await A.load();return}'
$offlineWidgetResyncTo = 'if(await h(M,Cn,!1)){await Promise.resolve().then(()=>Fm({mailWidget:!0,musicWidget:!0})).catch(()=>null);await Promise.allSettled([Promise.resolve().then(()=>Z.toggleLetterEntry({new_status:!0})),Promise.resolve().then(()=>Z.toggleMusicEntry({new_status:!0}))]);await A.load();return}'
$offlineWidgetResyncCount = ([regex]::Matches($text, [regex]::Escape($offlineWidgetResyncFrom))).Count
if ($offlineWidgetResyncCount -ne 1) { throw "expected one offline widget resync start branch, got $offlineWidgetResyncCount" }
$text = $text.Replace($offlineWidgetResyncFrom, $offlineWidgetResyncTo)

$offlineRequestBlock = 'if(t.isOfflineMode)throw new Ol(e)'
$offlineRequestAllow = 'if(!1)throw new Ol(e)'
$offlineRequestCount = ([regex]::Matches($text, [regex]::Escape($offlineRequestBlock))).Count
if ($offlineRequestCount -ne 1) { throw "expected one offline request interceptor, got $offlineRequestCount" }
$text = $text.Replace($offlineRequestBlock, $offlineRequestAllow)

$hideWriteFrom = '"hide-write":o(p)||!o(N3)'
$hideWriteTo = '"hide-write":!1'
$hideWriteCount = ([regex]::Matches($text, [regex]::Escape($hideWriteFrom))).Count
if ($hideWriteCount -ne 1) { throw "expected one offline hide-write gate, got $hideWriteCount" }
$text = $text.Replace($hideWriteFrom, $hideWriteTo)

$mailFetchFrom = 'He(()=>{p.value||d.fetchMailList(!0)})'
$mailFetchTo = 'He(()=>{d.fetchMailList(!0)})'
$mailFetchCount = ([regex]::Matches($text, [regex]::Escape($mailFetchFrom))).Count
if ($mailFetchCount -ne 1) { throw "expected one offline mailbox fetch skip, got $mailFetchCount" }
$text = $text.Replace($mailFetchFrom, $mailFetchTo)

$offlinePollSkip = 's.isOfflineMode||(s.appMode===Se.PRO?Lt().proRestoreFromApi():s.appMode===Se.LITE&&(Lt().liteStartPoll(),uo().startPolling()))'
$offlinePollRun = 's.appMode===Se.PRO?Lt().proRestoreFromApi():s.appMode===Se.LITE&&(s.isOfflineMode?uo().startPolling():(Lt().liteStartPoll(),uo().startPolling()))'
$offlinePollCount = ([regex]::Matches($text, [regex]::Escape($offlinePollSkip))).Count
if ($offlinePollCount -ne 1) { throw "expected one offline letter polling skip, got $offlinePollCount" }
$text = $text.Replace($offlinePollSkip, $offlinePollRun)

$midiUidWatchFrom = 'X&&(t.value===Se.PRO?T():J())'
$midiUidWatchTo = 'X&&(t.value===Se.PRO?T():Ie().isOfflineMode||J())'
$midiUidWatchCount = ([regex]::Matches($text, [regex]::Escape($midiUidWatchFrom))).Count
if ($midiUidWatchCount -ne 1) { throw "expected one midi uid watcher, got $midiUidWatchCount" }
$text = $text.Replace($midiUidWatchFrom, $midiUidWatchTo)

$midiListFrom = 'C=async()=>{try{const X=await ds({pageSize:S});E.value=X.list.map(te=>({jobId:te.jobId'
$midiListTo = 'C=async()=>{try{const X=await ds({pageSize:S},{hideToast:!0});E.value=X.list.map(te=>({jobId:te.jobId'
$midiListCount = ([regex]::Matches($text, [regex]::Escape($midiListFrom))).Count
if ($midiListCount -ne 1) { throw "expected one midi listJobs fetch, got $midiListCount" }
$text = $text.Replace($midiListFrom, $midiListTo)

$myUploadOfflineHidden = 'o(w)?Y("",!0):(r(),F(on,{key:0,index:so,class:"h-fit"},{default:V(()=>[n("div",Y3,v(o(t)("studio_user_upload_tab")),1)]),_:1}))'
$myUploadOfflineShown = '(r(),F(on,{key:0,index:so,class:"h-fit"},{default:V(()=>[n("div",Y3,v(o(t)("studio_user_upload_tab")),1)]),_:1}))'
$myUploadOfflineCount = ([regex]::Matches($text, [regex]::Escape($myUploadOfflineHidden))).Count
if ($myUploadOfflineCount -ne 1) { throw "expected one offline My Upload hide, got $myUploadOfflineCount" }
$text = $text.Replace($myUploadOfflineHidden, $myUploadOfflineShown)

$myUploadListPriorityFrom = 'Ce=j(()=>w.value?oe.getSongsByStyle(R.value).filter(q=>f.isDownloaded(q.id)):Q.value?te.value:N.value)'
$myUploadListPriorityTo = 'Ce=j(()=>Q.value?te.value:w.value?oe.getSongsByStyle(R.value).filter(q=>f.isDownloaded(q.id)):N.value)'
$myUploadListPriorityCount = ([regex]::Matches($text, [regex]::Escape($myUploadListPriorityFrom))).Count
if ($myUploadListPriorityCount -ne 1) { throw "expected one offline My Upload list priority, got $myUploadListPriorityCount" }
$text = $text.Replace($myUploadListPriorityFrom, $myUploadListPriorityTo)

$myUploadNativeSongFrom = 'Le=q=>({id:q.id,name:q.name,nameKey:q.nameKey,coverUrl:q.iconUrl??"",source:"songlist",videoUrl:q.videoUrl,videoByTodView:q.videoByTodView,performanceType:q.performanceType})'
$myUploadNativeSongTo = 'Le=q=>({id:q.id,name:q.name,nameKey:q.nameKey,coverUrl:q.iconUrl??"",source:"songlist",videoUrl:q.videoUrl,videoByTodView:q.videoByTodView,performanceType:q.performanceType,eventId:q.eventId??q.id})'
$myUploadNativeSongCount = ([regex]::Matches($text, [regex]::Escape($myUploadNativeSongFrom))).Count
if ($myUploadNativeSongCount -ne 1) { throw "expected one My Upload native song mapper, got $myUploadNativeSongCount" }
$text = $text.Replace($myUploadNativeSongFrom, $myUploadNativeSongTo)

$myUploadNativeDownloadFrom = 'const Dt=async()=>{if(!ge){ge=!0;try{const q=te.value,me=q.filter(Be=>!f.downloadMap.has(Be.id));me.forEach(Be=>f.initSongStatus(Be.id,Be.styleType)),me.length>0&&await f.syncLocalStatus(me.map(Le)),q.filter(Be=>!f.isDownloaded(Be.id)&&!f.isDownloading(Be.id)).forEach(Be=>f.startDownload(Be))}finally{ge=!1}}}'
$myUploadLocalPlaybackTo = 'const Dt=async()=>{}'
$myUploadNativeDownloadCount = ([regex]::Matches($text, [regex]::Escape($myUploadNativeDownloadFrom))).Count
if ($myUploadNativeDownloadCount -ne 1) { throw "expected one My Upload native download flow, got $myUploadNativeDownloadCount" }
$text = $text.Replace($myUploadNativeDownloadFrom, $myUploadLocalPlaybackTo)

$myUploadPlayFrom = 'Mo=q=>{m.value=q.id,h.playSonglistItem(q)},Lo=()=>{h.isPlaying?h.stopCurrentSong("switch_library"):h.handleTogglePlay()},Ro=q=>{m.value=q.id;const{waveformData:me,...Be}=q;s(rt.Perform,Be),Mo(q)},Bo=q=>{f.startDownload(q)},Uo=()=>{Z.songBatchDownloadClick(),u.value=!0}'
$myUploadDirectPlayTo = 'OliviaSoulIsLocalUpload=q=>String(q&&q.videoUrl||"").includes("/toy/midi/songs/"),Mo=q=>{m.value=q.id,h.playSonglistItem(q)},Lo=()=>{h.handleTogglePlay()},Ro=q=>{m.value=q.id;const{waveformData:me,...Be}=q,at=OliviaSoulIsLocalUpload(q)?h.beginLocalPlayback(q):q.id,vt=String(at)===String(q.id)?q:{...q,id:at};s(rt.Perform,Be),Mo(vt)},Bo=q=>{Ro(q)},Uo=()=>{Z.songBatchDownloadClick(),u.value=!0}'
$myUploadPlayCount = ([regex]::Matches($text, [regex]::Escape($myUploadPlayFrom))).Count
if ($myUploadPlayCount -ne 1) { throw "expected one My Upload play/download handler, got $myUploadPlayCount" }
$text = $text.Replace($myUploadPlayFrom, $myUploadDirectPlayTo)

$myUploadDownloadStateFrom = '"download-progress":(nn=o(f).getDownloadEntry(at.id))==null?void 0:nn.progress,"download-state":(an=o(f).getDownloadEntry(at.id))==null?void 0:an.state'
$myUploadDownloadStateTo = '"download-progress":OliviaSoulIsLocalUpload(at)?100:(nn=o(f).getDownloadEntry(at.id))==null?void 0:nn.progress,"download-state":OliviaSoulIsLocalUpload(at)?"completed":(an=o(f).getDownloadEntry(at.id))==null?void 0:an.state'
$myUploadDownloadStateCount = ([regex]::Matches($text, [regex]::Escape($myUploadDownloadStateFrom))).Count
if ($myUploadDownloadStateCount -ne 1) { throw "expected one My Upload download state render, got $myUploadDownloadStateCount" }
$text = $text.Replace($myUploadDownloadStateFrom, $myUploadDownloadStateTo)

$myUploadSearchStateFrom = 'const{list:he,fetchList:xe,handleReset:$e,initInfiniteScroll:X}=Mt(dm,b({})),te=j(()=>he.value.map(s1))'
$myUploadSearchStateTo = 'const OliviaSoulUploadSearch=b(""),OliviaSoulUploadParams=j(()=>({query:OliviaSoulUploadSearch.value,pageSize:100})),{list:he,fetchList:xe,handleReset:$e,initInfiniteScroll:X}=Mt(dm,OliviaSoulUploadParams),te=j(()=>he.value.map(s1))'
$myUploadSearchStateCount = ([regex]::Matches($text, [regex]::Escape($myUploadSearchStateFrom))).Count
if ($myUploadSearchStateCount -ne 1) { throw "expected one My Upload query state, got $myUploadSearchStateCount" }
$text = $text.Replace($myUploadSearchStateFrom, $myUploadSearchStateTo)

$myUploadSearchHandlerFrom = 'dt=async()=>{Q.value&&($e(),await xe(),await zt(),X(eo(ct.value)))},Do=()=>{M(so)}'
$myUploadSearchHandlerTo = 'dt=async()=>{Q.value&&($e(),await xe(),await zt(),X(eo(ct.value)))};let OliviaSoulSearchTimer=null,OliviaSoulUploadRefresh=null,OliviaSoulUploadRevision=null,OliviaSoulUploadRefreshing=!1,OliviaSoulSearchComposing=!1;const OliviaSoulSilentRefresh=async()=>{if(Q.value&&!OliviaSoulUploadRefreshing){OliviaSoulUploadRefreshing=!0;try{const at=await dm({query:OliviaSoulUploadSearch.value,cursor:0,pageSize:Math.max(100,he.value.length)});if(OliviaSoulUploadRevision===at.revision)return;OliviaSoulUploadRevision=at.revision;const vt=new Map(he.value.map((wt,kt)=>[wt.id,kt])),pt=new Set;at.list.forEach(wt=>{pt.add(wt.id);const kt=vt.get(wt.id);kt===void 0?he.value.push(wt):Object.assign(he.value[kt],wt)});if(!at.hasMore)for(let wt=he.value.length-1;wt>=0;wt-=1)pt.has(he.value[wt].id)||he.value.splice(wt,1);await zt()}finally{OliviaSoulUploadRefreshing=!1}}},OliviaSoulSearch=at=>{OliviaSoulUploadSearch.value=at.target.value;if(OliviaSoulSearchComposing)return;OliviaSoulSearchTimer&&clearTimeout(OliviaSoulSearchTimer),OliviaSoulSearchTimer=setTimeout(()=>dt(),250)},OliviaSoulCompositionStart=()=>{OliviaSoulSearchComposing=!0},OliviaSoulCompositionEnd=at=>{OliviaSoulSearchComposing=!1,OliviaSoulSearch(at)},Do=()=>{M(so)}'
$myUploadSearchHandlerCount = ([regex]::Matches($text, [regex]::Escape($myUploadSearchHandlerFrom))).Count
if ($myUploadSearchHandlerCount -ne 1) { throw "expected one My Upload refresh handler, got $myUploadSearchHandlerCount" }
$text = $text.Replace($myUploadSearchHandlerFrom, $myUploadSearchHandlerTo)
$songUploadMetadata = @'
function OliviaSoulUploadMetadata(event){
  window.OliviaSoulSongEditor.applyMetadata([...he.value,...K.value],event.detail);
  h.applySongMetadata(event.detail);
}
'@
$songUploadMetadataFrom = 'Lt().setOnJobCompleted(()=>{dt()});'
if (([regex]::Matches($text,[regex]::Escape($songUploadMetadataFrom))).Count -ne 1) { throw "expected one upload completion anchor" }
$text = $text.Replace($songUploadMetadataFrom, ($songUploadMetadata + $songUploadMetadataFrom))

$myUploadSearchRenderFrom = 'k(Eo,{"column-config":o(x),class:"mr-4"},null,8,["column-config"]),o(l)?'
$myUploadSearchRenderTo = 'k(Eo,{"column-config":o(x),class:"mr-4"},null,8,["column-config"]),o(Q)?(r(),_("input",{key:"OliviaSoulSearch",value:o(OliviaSoulUploadSearch),type:"search",placeholder:"\u641c\u7d22\u6211\u7684\u4e0a\u4f20",class:"mx-3 mb-2 h-9 px-3 rounded-2 border border-grey-4 bg-grey-0 text-text-title text-body-m",onInput:OliviaSoulSearch,onCompositionstart:OliviaSoulCompositionStart,onCompositionend:OliviaSoulCompositionEnd},null,40,["value"])):Y("",!0),o(l)?'
$myUploadSearchRenderCount = ([regex]::Matches($text, [regex]::Escape($myUploadSearchRenderFrom))).Count
if ($myUploadSearchRenderCount -ne 1) { throw "expected one My Upload list header, got $myUploadSearchRenderCount" }
$text = $text.Replace($myUploadSearchRenderFrom, $myUploadSearchRenderTo)

$midiRemainingFrom = 'w=j(()=>Math.max(0,g.value-y.value))'
$midiRemainingTo = 'w=j(()=>g.value<=0?1:Math.max(0,g.value-y.value))'
$midiRemainingCount = ([regex]::Matches($text, [regex]::Escape($midiRemainingFrom))).Count
if ($midiRemainingCount -ne 1) { throw "expected one MIDI remaining quota expression, got $midiRemainingCount" }
$text = $text.Replace($midiRemainingFrom, $midiRemainingTo)

$myUploadRefreshFrom = 'He(async()=>{if(w.value){await W().finally(()=>{a.value=!1}),Po();return}await Ua(),await W().finally(()=>{a.value=!1}),Po()});'
$myUploadRefreshOfflineFrom = 'He(async()=>{if(w.value){a.value=!1;return}await Ua(),await W().finally(()=>{a.value=!1}),Po()});'
$myUploadRefreshTo = 'He(async()=>{window.addEventListener("oliviasoul-song-metadata",OliviaSoulUploadMetadata),OliviaSoulUploadRefresh=setInterval(()=>{Q.value&&OliviaSoulSilentRefresh()},5000);if(w.value){await W().finally(()=>{a.value=!1}),Po();return}await Ua(),await W().finally(()=>{a.value=!1}),Po()}),Ot(()=>{window.removeEventListener("oliviasoul-song-metadata",OliviaSoulUploadMetadata),OliviaSoulUploadRefresh&&(clearInterval(OliviaSoulUploadRefresh),OliviaSoulUploadRefresh=null),OliviaSoulSearchTimer&&(clearTimeout(OliviaSoulSearchTimer),OliviaSoulSearchTimer=null)});'
$myUploadRefreshCount = ([regex]::Matches($text, [regex]::Escape($myUploadRefreshFrom))).Count
$myUploadRefreshOfflineCount = ([regex]::Matches($text, [regex]::Escape($myUploadRefreshOfflineFrom))).Count
if (($myUploadRefreshCount + $myUploadRefreshOfflineCount) -ne 1) { throw "expected one My Upload mount flow, got online=$myUploadRefreshCount offline=$myUploadRefreshOfflineCount" }
if ($myUploadRefreshCount -eq 1) { $text = $text.Replace($myUploadRefreshFrom, $myUploadRefreshTo) }
else { $text = $text.Replace($myUploadRefreshOfflineFrom, $myUploadRefreshTo) }

$midiExtensionFrom = 'if(z.value=R,!O.name.toLowerCase().endsWith(".mid")){ze.error(s("midi_upload_format_limit_desc")),H==null||H(new Error("canceled"));return}const Q=5*1024*1024;if(O.size>Q)'
$midiExtensionTo = 'if(z.value=R,![".mid",".midi"].some(ee=>O.name.toLowerCase().endsWith(ee))){ze.error(s("midi_upload_format_limit_desc")),H==null||H(new Error("canceled"));return}const Q=64*1024*1024;if(O.size>Q)'
$midiExtensionCount = ([regex]::Matches($text, [regex]::Escape($midiExtensionFrom))).Count
if ($midiExtensionCount -ne 1) { throw "expected one MIDI extension and size check, got $midiExtensionCount" }
$text = $text.Replace($midiExtensionFrom, $midiExtensionTo)

$midiAcceptFrom = 'accept:".mid"'
$midiAcceptTo = 'accept:".mid,.midi"'
$midiAcceptCount = ([regex]::Matches($text, [regex]::Escape($midiAcceptFrom))).Count
$midiAcceptExistingCount = ([regex]::Matches($text, [regex]::Escape($midiAcceptTo))).Count
if ($midiAcceptCount -ne 2) { throw "expected two MIDI file accept filters, got $midiAcceptCount" }
$midiAcceptExpectedCount = $midiAcceptCount + $midiAcceptExistingCount
$text = $text.Replace($midiAcceptFrom, $midiAcceptTo)

$shareCodeDefaultFrom = 'a.value=i.defaultTab??"upload"'
$shareCodeDefaultTo = 'a.value="upload"'
$shareCodeDefaultCount = ([regex]::Matches($text, [regex]::Escape($shareCodeDefaultFrom))).Count
if ($shareCodeDefaultCount -ne 1) { throw "expected one share-code default tab selection, got $shareCodeDefaultCount" }
$text = $text.Replace($shareCodeDefaultFrom, $shareCodeDefaultTo)

$shareCodeTabShown = 'n("div",{class:ae(["midi-action-tab",{"is-active":o(a)==="share"}]),onClick:O[1]||(O[1]=$e=>P("share"))},v(o(s)("common_share_code_title")),3)'
$shareCodeTabHidden = 'Y("",!0)'
$shareCodeTabCount = ([regex]::Matches($text, [regex]::Escape($shareCodeTabShown))).Count
if ($shareCodeTabCount -ne 1) { throw "expected one share-code tab, got $shareCodeTabCount" }
$text = $text.Replace($shareCodeTabShown, $shareCodeTabHidden)

$offlineStylesFiltered = 'D.value=oe.musicStyles.filter(me=>oe.getSongsByStyle(me.type).some(Be=>f.isDownloaded(Be.id)))'
$offlineStylesShown = 'D.value=oe.musicStyles'
$offlineStylesCount = ([regex]::Matches($text, [regex]::Escape($offlineStylesFiltered))).Count
if ($offlineStylesCount -ne 1) { throw "expected one offline music style filter, got $offlineStylesCount" }
$text = $text.Replace($offlineStylesFiltered, $offlineStylesShown)

$interfaceWatermarkShown = 'o(T)?(r(),F(ye,{key:0,uid:o(T)},null,8,["uid"])):Y("",!0)'
$interfaceWatermarkHidden = 'Y("",!0)'
$interfaceWatermarkCount = ([regex]::Matches($text, [regex]::Escape($interfaceWatermarkShown))).Count
if ($interfaceWatermarkCount -ne 1) { throw "expected one interface uid watermark render, got $interfaceWatermarkCount" }
$text = $text.Replace($interfaceWatermarkShown, $interfaceWatermarkHidden)

$cornerUidShown = 'return(s,i)=>(r(),_("div",n0,[n("div",a0,[o(t)?(r(),_("span",l0,"UID: "+v(o(t)),1)):Y("",!0)])]))'
$cornerUidHidden = 'return(s,i)=>Y("",!0)'
$cornerUidCount = ([regex]::Matches($text, [regex]::Escape($cornerUidShown))).Count
if ($cornerUidCount -ne 1) { throw "expected one bottom-right uid render, got $cornerUidCount" }
$text = $text.Replace($cornerUidShown, $cornerUidHidden)

$songShareMenuShown = '$e=[{id:"share",icon:"share",label:i("common_share"),onClick:R},{id:"addPlaylist",icon:"addplaylist",label:i("common_add_to_playlist"),onClick:O,disabled:()=>z.value,tooltip:()=>z.value?i("common_add_to_playlist_desc"):""}]'
$songShareMenuHidden = '$e=[{id:"addPlaylist",icon:"addplaylist",label:i("common_add_to_playlist"),onClick:O,disabled:()=>z.value,tooltip:()=>z.value?i("common_add_to_playlist_desc"):""}]'
$songShareMenuCount = ([regex]::Matches($text, [regex]::Escape($songShareMenuShown))).Count
if ($songShareMenuCount -ne 1) { throw "expected one song share menu action, got $songShareMenuCount" }
$text = $text.Replace($songShareMenuShown, $songShareMenuHidden)

$collectionShareShown = 'n("div",ub,[k(x,{class:"text-title-m m-1 text-info",type:"share",onClick:w[2]||(w[2]=P=>g.$emit("share",g.song))})])'
$collectionShareHidden = 'n("div",ub,[])'
$collectionShareCount = ([regex]::Matches($text, [regex]::Escape($collectionShareShown))).Count
if ($collectionShareCount -ne 1) { throw "expected one collection song share action, got $collectionShareCount" }
$text = $text.Replace($collectionShareShown, $collectionShareHidden)

$aigcMetadataMarker = 'xmlns:TC260'
if (-not $text.Contains($aigcMetadataMarker)) { throw "expected TC260 AIGC metadata marker" }

$playlistHidden = 'o(w)?Y("",!0):(r(),_(se,{key:0},[o(a)?(r(),_("div",c4,'
$playlistShown = '(r(),_(se,{key:0},[o(a)?(r(),_("div",c4,'
$playlistCount = ([regex]::Matches($text, [regex]::Escape($playlistHidden))).Count
if ($playlistCount -ne 1) { throw "expected one offline playlist hide, got $playlistCount" }
$text = $text.Replace($playlistHidden, $playlistShown)

$hideActionsFrom = '"hide-actions":o(w)'
$hideActionsTo = '"hide-actions":!1'
$hideActionsCount = ([regex]::Matches($text, [regex]::Escape($hideActionsFrom))).Count
if ($hideActionsCount -ne 1) { throw "expected one offline song action hide, got $hideActionsCount" }
$text = $text.Replace($hideActionsFrom, $hideActionsTo)

$playerOfflineHide = 'o(t)?Y("",!0):'
$playerOfflineCount = ([regex]::Matches($text, [regex]::Escape($playerOfflineHide))).Count
if ($playerOfflineCount -ne 4) { throw "expected four offline player control hides, got $playerOfflineCount" }
$text = $text.Replace($playerOfflineHide, "")

$videoReplyFrom = 'content:e.replyText??"",type:Wn(e.replyType,e.letterStatus,e.auditStatus),replyType:e.replyType,videoUrl:e.replyVideoUrl||void 0'
$videoReplyTo = 'content:e.replyText??"",type:e.letterStatus===bt.FAILED?Wn(e.replyType,e.letterStatus,e.auditStatus):e.replyVideoUrl?"video":"text",replyType:e.replyType,videoUrl:e.replyVideoUrl||void 0'
$videoReplyCount = ([regex]::Matches($text, [regex]::Escape($videoReplyFrom))).Count
if ($videoReplyCount -ne 1) { throw "expected one reply video mapping, got $videoReplyCount" }
$text = $text.Replace($videoReplyFrom, $videoReplyTo)

$startupUser = 'const oe=await Dn({hideToast:!0,loading:!0}),{status:Ce,modelGatewayToken:Fe}=oe;oe.userInfo&&Ie().setUserProfile(oe.userInfo),P.value'
$offlineUser = 'const oe=await Dn({hideToast:!0,loading:!0}),{status:Ce,modelGatewayToken:Fe}=oe;oe.uid!==void 0&&l.setUid(oe.uid.toString()),oe.userInfo&&Ie().setUserProfile(oe.userInfo),P.value'
$startupUserCount = ([regex]::Matches($text, [regex]::Escape($startupUser))).Count
if ($startupUserCount -ne 1) { throw "expected one startup user mapping, got $startupUserCount" }
$text = $text.Replace($startupUser, $offlineUser)

$pollingLoop = 'for(const re of ue){const ye=t.value.findIndex'
$orderedPollingLoop = 'for(const re of [...ue].reverse()){const ye=t.value.findIndex'
$pollingLoopCount = ([regex]::Matches($text, [regex]::Escape($pollingLoop))).Count
if ($pollingLoopCount -ne 1) { throw "expected one mailbox polling loop, got $pollingLoopCount" }
$text = $text.Replace($pollingLoop, $orderedPollingLoop)

$pollingStateFrom = '(((B=re.received)==null?void 0:B.type)!==((K=Ee.received)==null?void 0:K.type)||re.isUnread!==Ee.isUnread)&&'
$pollingStateTo = '(((B=re.received)==null?void 0:B.type)!==((K=Ee.received)==null?void 0:K.type)||re.isUnread!==Ee.isUnread||re.letterStatus!==Ee.letterStatus)&&'
$pollingStateCount = ([regex]::Matches($text, [regex]::Escape($pollingStateFrom))).Count
if ($pollingStateCount -ne 1) { throw "expected one mailbox polling state condition, got $pollingStateCount" }
$text = $text.Replace($pollingStateFrom, $pollingStateTo)

$processingIconFrom = 'const m=s.mail.id===ro,u=!s.mail.received,p=s.mail.isUnread,d=(h=s.mail.received)==null?void 0:h.type;return'
$processingIconTo = 'const m=s.mail.id===ro,u=!s.mail.received||s.mail.letterStatus===bt.LLM_PROCESSING,p=s.mail.isUnread,d=(h=s.mail.received)==null?void 0:h.type;return'
$processingIconCount = ([regex]::Matches($text, [regex]::Escape($processingIconFrom))).Count
if ($processingIconCount -ne 1) { throw "expected one processing icon condition, got $processingIconCount" }
$text = $text.Replace($processingIconFrom, $processingIconTo)

$replyIcon = 'iconType:u?"send":d==="video"?"video":"book",iconClass:u?"text-[#EFEAE3]":"text-[#E7F1F4]",iconBgClass:u?"bg-[#6B645B]":d==="video"?"bg-[#3F5F6B]":"bg-[#4F6F5E]"'
$replyIconCount = ([regex]::Matches($text, [regex]::Escape($replyIcon))).Count
if ($replyIconCount -ne 1) { throw "expected one reply icon mapping, got $replyIconCount" }

$playlistUrl = $ServiceUrl.TrimEnd("/") + "/toy/addToPlaylist"
$addPlaylistFrom = 'async function An(e,t){return Te.post("' + $playlistUrl + '",{itemType:e.itemType,itemId:e.itemId},t).then(s=>{const i=s.data;return{...i,itemId:i.itemId,performanceId:i.performanceId??"",songId:i.songId??"",id:i.itemId}})}'
$addPlaylistTo = 'async function An(e,t){return Te.post("' + $playlistUrl + '",{itemType:e.itemType,itemId:e.itemId??e.id??e.songId??e.performanceId,name:e.name,nameKey:e.nameKey,iconUrl:e.iconUrl??e.coverUrl,songId:e.songId,performanceId:e.performanceId,duration:e.duration??e.videoDuration??e.audioDuration,videoDuration:e.videoDuration??e.duration,videoUrl:e.videoUrl??e.mediaUrl,videoByTodView:e.videoByTodView,performanceType:e.performanceType},t).then(s=>{const i=s&&s.data&&typeof s.data=="object"?s.data:s||{};const l=i.itemId??i.item_id??e.itemId??e.id??"";return{...i,itemId:l,performanceId:i.performanceId??i.performance_id??"",songId:i.songId??i.song_id??"",id:l,duration:i.duration??i.videoDuration??e.duration??0,videoDuration:i.videoDuration??i.duration??e.videoDuration??e.duration??0,videoUrl:i.videoUrl??i.video_url??e.videoUrl??e.mediaUrl??"",coverUrl:i.coverUrl??i.iconUrl??e.coverUrl??e.iconUrl??"",performanceType:i.performanceType??e.performanceType??"",videoByTodView:e.videoByTodView??i.videoByTodView}})}'
$addPlaylistCount = ([regex]::Matches($text, [regex]::Escape($addPlaylistFrom))).Count
if ($addPlaylistCount -ne 1) { throw "expected one addToPlaylist client wrapper, got $addPlaylistCount" }
$text = $text.Replace($addPlaylistFrom, $addPlaylistTo)

$addPlaylistCallFrom = 'Pa=async(q,me)=>{const Be=await An({itemType:me,itemId:q.id});re(Be),Z.musicPlaylistAdd('
$addPlaylistCallTo = 'Pa=async(q,me)=>{const Be=await An({itemType:me,itemId:q.id||q.songId||q.itemId,name:q.name,nameKey:q.nameKey,iconUrl:q.iconUrl||q.coverUrl,songId:q.songId,performanceId:q.performanceId,duration:q.duration??q.videoDuration??q.audioDuration,videoDuration:q.videoDuration??q.duration,videoUrl:q.videoUrl||q.mediaUrl,videoByTodView:q.videoByTodView,performanceType:q.performanceType});re(Be),Z.musicPlaylistAdd('
$addPlaylistCallCount = ([regex]::Matches($text, [regex]::Escape($addPlaylistCallFrom))).Count
if ($addPlaylistCallCount -ne 1) { throw "expected one StudioLite add-playlist call, got $addPlaylistCallCount" }
$text = $text.Replace($addPlaylistCallFrom, $addPlaylistCallTo)

$collectionAddFrom = 'const G=async C=>{const D=await An({itemType:pt.PERFORMANCE,itemId:C.performanceId});'
$collectionAddTo = 'const G=async C=>{const D=await An({itemType:pt.PERFORMANCE,itemId:C.performanceId||C.id,name:C.performanceName||C.name,nameKey:C.songNameKey||C.nameKey,iconUrl:C.iconUrl||C.coverUrl,performanceId:C.performanceId,songId:C.songId,duration:C.duration??C.videoDuration??C.audioDuration,videoDuration:C.videoDuration??C.duration,videoUrl:C.videoUrl||C.mediaUrl,videoByTodView:C.videoByTodView,performanceType:C.performanceType});'
$collectionAddCount = ([regex]::Matches($text, [regex]::Escape($collectionAddFrom))).Count
if ($collectionAddCount -ne 1) { throw "expected one Collection add-playlist call, got $collectionAddCount" }
$text = $text.Replace($collectionAddFrom, $collectionAddTo)

$offlinePlaylistSkip = 'He(async()=>{if(w.value){a.value=!1;return}await Ua(),await W().finally(()=>{a.value=!1}),Po()});'
$offlinePlaylistFetch = 'He(async()=>{if(w.value){await W().finally(()=>{a.value=!1}),Po();return}await Ua(),await W().finally(()=>{a.value=!1}),Po()});'
$offlinePlaylistCount = ([regex]::Matches($text, [regex]::Escape($offlinePlaylistSkip))).Count
if ($offlinePlaylistCount -ne 0 -or -not $text.Contains($myUploadRefreshTo)) {
    throw "offline My Upload mount flow was not upgraded to fetch the playlist"
}

$localeFiles = @(Get-ChildItem -LiteralPath (Join-Path $extracted "assets") -Filter "zh-cn-*.js" -File)
if ($localeFiles.Count -ne 1) { throw "expected one zh-cn locale, got $($localeFiles.Count)" }
$localePath = $localeFiles[0].FullName
$localeText = [IO.File]::ReadAllText($localePath, $utf8)
$localeReplacementBase64 = @(
    @('bj0i5byA5aeL5a6a5Yi25L2g55qE5ryU5aWP5ZCn772eIg==', 'bj0i5LiK5LygIC5taWQvLm1pZGnvvIzmiJblnKjmnKzlnLDmnI3liqHlr7zlhaXlt7LkuIvovb3mm7LlupPjgIIi'),
    @('Yz0i5LuF5pSv5oyBIC5taWQg5qC85byP5paH5Lu277yM5aSn5bCPPDFNQu+8jOaXtumVvzwxMCDliIbpkp/jgILku4XlkKvpkqLnkLTljZXkuIDkuZDlmajvvIzkuI3lvpflh7rnjrDkurrlo7DmiJblhbbku5bkuZDlmajjgIIi', 'Yz0i5pSv5oyBIC5taWQvLm1pZGnvvIzljZXmlofku7bmnIDlpKcgNjQgTWlC77yM5LiN6ZmQ5qyh5pWw44CC5Y+q5pyJIE1JREkg5pe277yM5pys5Zyw5pyN5Yqh5Lya5oyJ6Z+z56ym55Sf5oiQ5Y+v5pKt5pS+IE1QNOOAgiI='),
    @('cj0i55Sx6Z+z6aKR5paH5Lu255u05o6l6L2s5Ye655qEIC5taWQg5Y+v6IO95ryU5aWP5YeG56Gu5bqm6L6D5L2O77yb5aaC5pyJ6ZKi55C06LiP5p2/5bu26Z+z77yM6ZyA5Lul56uW57q/5qCH6K+G5L2T546w44CCIg==', 'cj0i5bey5LiL6L2955qE5YiG5Lqr56CB5puy55uu5Y+v5Zyo5pys5Zyw5pyN5Yqh5Lit5a+85YWl77yb55Sf5oiQ5paH5Lu25L+d5a2Y5ZyoIE1JREkg5pWw5o2u55uu5b2V77yM5pKt5pS+57yT5a2Y6Lef6ZqP5puy55uu5a2Y5YKo6Lev5b6E44CCIg=='),
    @('c3Q9IuWPr+S7pemAmui/h+S4iuS8oOaMh+WumuagvOW8j+eahOmfs+S5kOaWh+S7tuaIluS9v+eUqOWIhuS6q+egge+8jOW8gOWQr+S9oOeahOS4quaAp+WMluWIm+S9nOS9k+mqjOOAgiI=', 'c3Q9IuS4iuS8oCAubWlkLy5taWRpIOWNs+WPr+eUn+aIkOacrOWcsOa8lOWlj++8m+W3suS4i+i9veeahOWIhuS6q+eggeabsuebruWPr+mAmui/h+acrOWcsOabsuW6k+WvvOWFpeaBouWkjeOAgiI='),
    @('RnQ9IuS4uuS6huiOt+W+l+acgOS9s+aViOaenO+8jOivt+S4iuS8oOmSoueQtOeLrOWlj+eahOWNlei9qCBNSURJ77yM6YG/5YWN5YyF5ZCr5Lq65aOw5oiW5YW25LuW5LmQ5Zmo44CC6K+m6KeBIg==', 'RnQ9IuS4iuS8oCAubWlkIOaIliAubWlkaSDlkI7kvJrmjInpn7PnrKbnlJ/miJDmnKzlnLDmvJTlpY/op4bpopHvvJvnlJ/miJDmnJ/pl7Tlj6/ku6XlhbPpl63lvLnnqpfjgILor6bop4Ei'),
    @('R3Q9IuOAik1JREkg5a6a5Yi25ryU5aWP5LiK5Lyg5pS755Wl44CLIg==', 'R3Q9IuOAiuacrOWcsCBNSURJIOS9v+eUqOivtOaYjuOAiyI='),
    @('VHQ9IuKAoiDku4XmlK/mjIEgLm1pZCDmoLzlvI/nmoQgTUlESSDmlofku7bvvIzljIXlkKsgMeKAkzIg5p2h6L2o6YGT77yM5paH5Lu25aSn5bCPIDwgMU1C77yM5LmQ5puy5pe26ZW/IDwgMTAg5YiG6ZKf44CCIg==', 'VHQ9IuKAoiDmlK/mjIEgLm1pZC8ubWlkae+8jOWNleaWh+S7tuacgOWkpyA2NCBNaULvvIzkuI3pmZDmrKHmlbDvvJvlu7rorq7ljIXlkKvlrozmlbTnmoTpgJ/luqbjgIHpn7PnrKblkozouI/mnb/kuovku7bjgIIi'),
    @('VnQ9IuKAoiDkuI3lu7rorq7nm7TmjqXnlLHpn7PpopHovawgTUlESe+8jOWPr+iDveS8muW9seWTjea8lOWlj+WHhuehruaAp+OAguivt+ehruS/neS4iuS8oOeahOmfs+S5kOS4jeS+teeKr+esrOS4ieaWueeJiOadg+OAgiI=', 'VnQ9IuKAoiDlj6rmnIkgTUlESSDkuZ/lj6/ku6XkuIrkvKDvvIzmnKzlnLDmnI3liqHkvJroh6rliqjnlJ/miJDpkqLnkLTpn7PpopHlkozmvJTlpY/op4bpopHvvIzlrozmiJDlkI7ov5vlhaXigJzmiJHnmoTkuIrkvKDigJ3jgIIi'),
    @('V3Q9IuKAoiBNSURJIOS4reWPquiDveS9v+eUqOmSoueQtOWNleS4gOS5kOWZqO+8jOS4jeW+l+WMheWQq+S6uuWjsOaIluWFtuS7luS5kOWZqO+8m+Wmguaciei4j+adv+W7tumfs++8jOmcgOWcqCBNSURJIOS4reeUqOerlue6v+agh+azqOOAgiI=', 'V3Q9IuKAoiDnlJ/miJDmlofku7bkv53lrZjlnKjmnKzlnLDmnI3liqHmmL7npLrnmoQgTUlESSDmlbDmja7nm67lvZXvvJvmkq3mlL7nvJPlrZjkvJrot5/pmo/orr7nva7kuK3nmoTmm7Lnm67lrZjlgqjot6/lvoToh6rliqjliqDovb3jgIIi'),
    @('VW49IuaWh+S7tuWkp+Wwj+W/hemhu+Wwj+S6jjVNQiI=', 'VW49Ik1JREkg5paH5Lu25LiN6IO96LaF6L+HIDY0IE1pQiI='),
    @('Q249IuaWh+S7tuagvOW8j+W/hemhu+S4ui5taWQi', 'Q249Iuivt+mAieaLqSAubWlkIOaIliAubWlkaSDmlofku7Yi')
)
foreach ($replacementBase64 in $localeReplacementBase64) {
    $from = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($replacementBase64[0]))
    $to = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($replacementBase64[1]))
    $count = ([regex]::Matches($localeText, [regex]::Escape($from))).Count
    if ($count -ne 1) { throw "expected one locale text occurrence, got $count" }
    $localeText = $localeText.Replace($from, $to)
}
[IO.File]::WriteAllText($localePath, $localeText, $utf8)

$text = $patchMarker + "`n" + $songEditorSource + "`n" + $songEditorBridge + "`n" + $text.Substring($patchMarker.Length)
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
        try {
            $input.CopyTo($output)
        }
        finally {
            $output.Dispose()
            $input.Dispose()
        }
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
$verifyMain = @(Get-ChildItem -LiteralPath (Join-Path $verifyDir "assets") -Filter "main-*.js" -File)[0]
$verifyText = [IO.File]::ReadAllText($verifyMain.FullName, $utf8)
foreach ($endpoint in $endpoints) {
    $expected = $ServiceUrl.TrimEnd("/") + "/toy" + $endpoint
    if (-not $verifyText.Contains($expected)) { throw "patched archive missing $expected" }
}
if (-not $verifyText.StartsWith($patchMarker)) { throw "patched archive missing revision marker" }
if (-not $verifyText.Contains($songEditorSource) -or -not $verifyText.Contains($songEditorRowTo) -or -not $verifyText.Contains($songTitleSync)) { throw "patched archive missing shared song editor or title synchronization" }
if (-not $verifyText.Contains($offlineWidgetsEnabled)) { throw "patched archive still disables offline desktop widgets" }
if (-not $verifyText.Contains($settingsInitTo)) { throw "patched archive still accepts hidden desktop widget settings" }
if (-not $verifyText.Contains($offlineWidgetResyncTo)) { throw "patched archive missing post-start desktop widget resync" }
if ($verifyText.Contains($offlineWidgetResyncFrom)) { throw "patched archive retains pre-resync offline start branch" }
if (-not $verifyText.Contains($mailboxEnabled)) { throw "patched archive still hides the mailbox" }
if (-not $verifyText.Contains($myUploadOfflineShown)) { throw "patched archive still hides My Upload offline" }
if ($verifyText.Contains($myUploadOfflineHidden)) { throw "patched archive still has the original My Upload hide" }
if (-not $verifyText.Contains($myUploadListPriorityTo)) { throw "patched archive still lets offline catalog shadow My Upload" }
if ($verifyText.Contains($myUploadListPriorityFrom)) { throw "patched archive retains the original My Upload list priority" }
if (-not $verifyText.Contains($myUploadNativeSongTo)) { throw "patched archive drops My Upload eventId" }
if ($verifyText.Contains($myUploadNativeSongFrom)) { throw "patched archive still drops My Upload eventId" }
if (-not $verifyText.Contains($myUploadLocalPlaybackTo)) { throw "patched archive still initializes native downloads while listing My Upload" }
if ($verifyText.Contains($myUploadNativeDownloadFrom)) { throw "patched archive retains bulk My Upload download flow" }
if (-not $verifyText.Contains($myUploadDirectPlayTo)) { throw "patched archive does not play selected local media directly" }
if (-not $verifyText.Contains($myUploadDownloadStateTo)) { throw "patched archive still renders local HTTP media as a pending download" }
if ($verifyText.Contains($myUploadDownloadStateFrom)) { throw "patched archive retains the native download state for local HTTP media" }
if (-not $verifyText.Contains($directControlTo)) { throw "patched archive does not forward local playback controls" }
if (-not $verifyText.Contains($playlistAvailabilityTo)) { throw "patched archive still requires native downloads for local playlist media" }
if ($verifyText.Contains($playlistAvailabilityFrom)) { throw "patched archive retains the original playlist availability guard" }
if (-not $verifyText.Contains($playlistLocalPlayTo)) { throw "patched archive does not bind playlist items to local playback sessions" }
if ($verifyText.Contains('OliviaSoulPendingUpload')) { throw "patched archive still routes local media through native downloads" }
if (-not $verifyText.Contains($myUploadSearchStateTo)) { throw "patched archive missing My Upload search state" }
if (-not $verifyText.Contains($myUploadSearchHandlerTo)) { throw "patched archive missing My Upload search handler" }
if (-not $verifyText.Contains($myUploadSearchRenderTo)) { throw "patched archive missing My Upload search input" }
if (-not $verifyText.Contains($midiRemainingTo)) { throw "patched archive still treats unlimited MIDI as exhausted" }
if ($verifyText.Contains($midiRemainingFrom)) { throw "patched archive retains the original MIDI quota expression" }
if (-not $verifyText.Contains($myUploadRefreshTo)) { throw "patched archive does not refresh My Upload while active" }
if ($verifyText.Contains($myUploadRefreshFrom)) { throw "patched archive retains the original My Upload mount flow" }
if (-not $verifyText.Contains($midiExtensionTo)) { throw "patched archive missing MIDI extension or 64 MiB limit" }
if ($verifyText.Contains($midiExtensionFrom)) { throw "patched archive still has the original MIDI upload limit" }
if (([regex]::Matches($verifyText, [regex]::Escape($midiAcceptTo))).Count -ne $midiAcceptExpectedCount) { throw "patched archive missing MIDI accept filters" }
if (-not $verifyText.Contains($shareCodeDefaultTo)) { throw "patched archive still defaults to share-code mode" }
if ($verifyText.Contains($shareCodeTabShown)) { throw "patched archive still exposes the share-code tab" }
if ($verifyText.Contains($songShareMenuShown) -or $verifyText.Contains($collectionShareShown)) { throw "patched archive still exposes song sharing" }
if (-not $verifyText.Contains($offlineStylesShown)) { throw "patched archive still filters offline music styles" }
if ($verifyText.Contains($offlineStylesFiltered)) { throw "patched archive still has the original offline music style filter" }
if ($verifyText.Contains($interfaceWatermarkShown)) { throw "patched archive still renders the interface uid watermark" }
if ($verifyText.Contains($cornerUidShown)) { throw "patched archive still renders the bottom-right uid" }
if (-not $verifyText.Contains($aigcMetadataMarker)) { throw "patched archive lost TC260 AIGC metadata" }
if (-not $verifyText.Contains($playlistShown)) { throw "patched archive still hides the offline playlist" }
if (-not $verifyText.Contains($hideActionsTo)) { throw "patched archive still hides offline song actions" }
if (-not $verifyText.Contains($offlineRequestAllow)) { throw "patched archive still blocks offline HTTP requests" }
if (-not $verifyText.Contains($hideWriteTo)) { throw "patched archive still hides the write-letter entry" }
if (-not $verifyText.Contains($mailFetchTo)) { throw "patched archive still skips offline mailbox fetch" }
if (-not $verifyText.Contains($offlinePollRun)) { throw "patched archive still skips offline letter polling" }
if ($verifyText.Contains('s.appMode===Se.PRO?Lt().proRestoreFromApi():s.appMode===Se.LITE&&(Lt().liteStartPoll(),uo().startPolling())')) { throw "patched archive still starts midi poll while offline" }
if (-not $verifyText.Contains($midiUidWatchTo)) { throw "patched archive still starts midi poll from uid watcher while offline" }
if ($verifyText.Contains($midiUidWatchFrom)) { throw "patched archive still has the original midi uid watcher" }
if (-not $verifyText.Contains($midiListTo)) { throw "patched archive missing midi listJobs hideToast" }
if ($verifyText.Contains($midiListFrom)) { throw "patched archive still toasts midi listJobs errors" }
if (-not $verifyText.Contains($videoReplyTo)) { throw "patched archive missing exclusive video reply mapping" }
if (-not $verifyText.Contains($offlineUser)) { throw "patched archive missing offline uid synchronization" }
if (-not $verifyText.Contains($orderedPollingLoop)) { throw "patched archive missing mailbox polling order fix" }
if (-not $verifyText.Contains($pollingStateTo)) { throw "patched archive missing polling status comparison" }
if (-not $verifyText.Contains($processingIconTo)) { throw "patched archive missing processing envelope icon condition" }
if (-not $verifyText.Contains($replyIcon)) { throw "patched archive missing reply icon mapping" }
if ($verifyText.Contains($playerOfflineHide)) { throw "patched archive still hides offline player controls" }
if (-not $verifyText.Contains($addPlaylistTo)) { throw "patched archive missing add-playlist client unwrap fix" }
if (-not $verifyText.Contains($addPlaylistCallTo)) { throw "patched archive missing StudioLite add-playlist payload fix" }
if (-not $verifyText.Contains($collectionAddTo)) { throw "patched archive missing Collection add-playlist payload fix" }
if ($verifyText.Contains($offlinePlaylistSkip)) { throw "patched archive still has the original offline playlist fetch skip" }

if ($PatchNativeOfflineChecks) {
    if ($Version -ne '0.0.9.627') { throw "native widget patch only supports verified client 0.0.9.627" }
    $latin1 = [Text.Encoding]::GetEncoding(28591)
    function Find-ByteSequence([byte[]]$Haystack, [byte[]]$Needle) {
        return $latin1.GetString($Haystack).IndexOf($latin1.GetString($Needle), [StringComparison]::Ordinal)
    }

$studioUiPath = Join-Path $GameRoot "$Version\plugins\Studio\NutStudioUI.dll"
if (-not (Test-Path -LiteralPath $studioUiPath)) { throw "NutStudioUI.dll not found: $studioUiPath" }
$studioBackup = Join-Path ([IO.Path]::GetDirectoryName($OriginalFile)) ("NutStudioUI-" + $Version + ".dll")
$offlineCallFrom = @(
    [byte[]](0xCB, 0xE8, 0xD2, 0x37, 0x08, 0x00, 0xEB, 0x1E, 0xFF, 0x15, 0xB2, 0xEC, 0x08, 0x00, 0x48, 0x8D, 0x8F, 0xA8),
    [byte[]](0xCB, 0xE8, 0x72, 0x34, 0x08, 0x00, 0xEB, 0x1E, 0xFF, 0x15, 0x52, 0xE9, 0x08, 0x00, 0x48, 0x8D, 0x8F, 0xA8),
    [byte[]](0xCB, 0xE8, 0xB2, 0x1F, 0x08, 0x00, 0xEB, 0x2B, 0xFF, 0x15, 0x92, 0xD4, 0x08, 0x00, 0x84, 0xC0, 0x75, 0x14),
    [byte[]](0xCB, 0xE8, 0xFF, 0x1D, 0x08, 0x00, 0xEB, 0x1C, 0xFF, 0x15, 0xDF, 0xD2, 0x08, 0x00, 0x48, 0x8D, 0x4F, 0x38)
)
$offlineCallPatch = [byte[]](0x33, 0xC0, 0x90, 0x90, 0x90, 0x90)

$containerPluginPath = Join-Path $GameRoot "$Version\plugins\Container\NutContainerPlugin.dll"
if (-not (Test-Path -LiteralPath $containerPluginPath)) { throw "NutContainerPlugin.dll not found: $containerPluginPath" }
$containerPluginBackup = Join-Path ([IO.Path]::GetDirectoryName($OriginalFile)) ("NutContainerPlugin-" + $Version + ".dll")
$containerPluginCallFrom = [byte[]](0x48, 0x8B, 0xDA, 0x48, 0x8B, 0xF9, 0xFF, 0x15, 0x61, 0xA4, 0x04, 0x00, 0x84, 0xC0, 0x0F, 0x85)

function New-WidgetPatchPlan($Target, $Backup, $Patterns, [int]$PatchOffset) {
    $live = [IO.File]::ReadAllBytes($Target)
    $hasBackup = Test-Path -LiteralPath $Backup -PathType Leaf
    $original = if ($hasBackup) { [IO.File]::ReadAllBytes($Backup) } else { $live }
    $expected = [byte[]]$original.Clone()
    foreach ($needle in $Patterns) {
        $offset = Find-ByteSequence $original $needle
        $hay = $latin1.GetString($original)
        if ($offset -lt 0 -or $hay.IndexOf($latin1.GetString($needle), $offset + 1, [StringComparison]::Ordinal) -ge 0) {
            throw "native widget signature missing or ambiguous: $Target"
        }
        [Array]::Copy($offlineCallPatch, 0, $expected, $offset + $PatchOffset, $offlineCallPatch.Length)
    }
    $liveText = $latin1.GetString($live)
    if ($liveText -cne $latin1.GetString($original) -and $liveText -cne $latin1.GetString($expected)) {
        throw "native widget target differs from verified original and patch: $Target"
    }
    return @{ Target=$Target; Backup=$Backup; Before=$live; Original=$original; Expected=$expected; HasBackup=$hasBackup }
}
# Validate both files before backing up or changing either one.
$widgetPlans = @(
    (New-WidgetPatchPlan $studioUiPath $studioBackup $offlineCallFrom 8),
    (New-WidgetPatchPlan $containerPluginPath $containerPluginBackup @(,$containerPluginCallFrom) 6)
)
foreach ($plan in $widgetPlans) {
    if (-not $plan.HasBackup) {
        $backupStream = [IO.File]::Open($plan.Backup, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $backupStream.Write($plan.Original, 0, $plan.Original.Length); $backupStream.Flush($true) }
        finally { $backupStream.Dispose() }
    }
}
$written = New-Object System.Collections.Generic.List[object]
try {
    foreach ($plan in $widgetPlans) {
        if ($latin1.GetString([IO.File]::ReadAllBytes($plan.Target)) -cne $latin1.GetString($plan.Before)) {
            throw "native widget target changed during patch: $($plan.Target)"
        }
        if ($latin1.GetString($plan.Before) -ceq $latin1.GetString($plan.Expected)) { continue }
        $written.Add($plan)
        [IO.File]::WriteAllBytes($plan.Target, $plan.Expected)
        if ($latin1.GetString([IO.File]::ReadAllBytes($plan.Target)) -cne $latin1.GetString($plan.Expected)) {
            throw "native widget patch verification failed: $($plan.Target)"
        }
    }
} catch {
    foreach ($plan in $written) { [IO.File]::WriteAllBytes($plan.Target, $plan.Before) }
    throw
}

}

$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash
Write-Output "patched=$source"
Write-Output "sha256=$hash"
if ($PatchNativeOfflineChecks) {
    $studioHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $studioUiPath).Hash
    $pluginHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $containerPluginPath).Hash
    Write-Output "nativeOfflineChecks=true"
    Write-Output "studioUi=$studioUiPath"
    Write-Output "studioUiSha256=$studioHash"
    Write-Output "containerPlugin=$containerPluginPath"
    Write-Output "containerPluginSha256=$pluginHash"
} else {
    Write-Output "nativeOfflineChecks=false"
}
