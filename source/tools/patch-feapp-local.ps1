param(
    [Parameter(Mandatory = $true)][string]$GameRoot,
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$OriginalFile,
    [string]$ServiceUrl = "http://127.0.0.1:27149"
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "process-control.ps1")
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$relative = "$Version\resources\feapp.dat"
$source = Join-Path $GameRoot $relative
Stop-GameProcesses $GameRoot
Start-Sleep -Milliseconds 250
if (-not (Test-Path -LiteralPath $OriginalFile)) {
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
$patchMarker = '/*OliviaSoulPatch:mail-music-v11*/'
if ($text.Contains($patchMarker)) { throw "original feapp already contains current patch" }
$text = $patchMarker + $text
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
    "/searchPlaylist"
)

foreach ($endpoint in $endpoints) {
    $from = '"' + $endpoint + '"'
    $to = '"' + $ServiceUrl.TrimEnd("/") + "/toy" + $endpoint + '"'
    $count = ([regex]::Matches($text, [regex]::Escape($from))).Count
    if ($count -ne 1) { throw "expected one endpoint occurrence for $endpoint, got $count" }
    $text = $text.Replace($from, $to)
}

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

$musicFeaturesDisabled = 'N3=!0,Ss=!1,wa=({onComplete'
$musicFeaturesEnabled = 'N3=!0,Ss=!0,wa=({onComplete'
$musicFeaturesCount = ([regex]::Matches($text, [regex]::Escape($musicFeaturesDisabled))).Count
if ($musicFeaturesCount -ne 1) { throw "expected one disabled music feature gate, got $musicFeaturesCount" }
$text = $text.Replace($musicFeaturesDisabled, $musicFeaturesEnabled)

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
if ($offlinePlaylistCount -ne 1) { throw "expected one offline playlist fetch skip, got $offlinePlaylistCount" }
$text = $text.Replace($offlinePlaylistSkip, $offlinePlaylistFetch)

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
if (-not $verifyText.Contains($offlineWidgetsEnabled)) { throw "patched archive still disables offline desktop widgets" }
if (-not $verifyText.Contains($musicFeaturesEnabled)) { throw "patched archive still has mailbox or music features disabled" }
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
if (-not $verifyText.Contains($offlinePlaylistFetch)) { throw "patched archive still skips offline playlist fetch" }
if ($verifyText.Contains($offlinePlaylistSkip)) { throw "patched archive still has the original offline playlist fetch skip" }

$latin1 = [Text.Encoding]::GetEncoding(28591)
function Find-ByteSequence([byte[]]$Haystack, [byte[]]$Needle) {
    return $latin1.GetString($Haystack).IndexOf($latin1.GetString($Needle))
}

$nutBasePath = Join-Path $GameRoot "$Version\NutBase.dll"
$nutBackup = Join-Path ([IO.Path]::GetDirectoryName($OriginalFile)) ("NutBase-" + $Version + ".dll")
if ((Test-Path -LiteralPath $nutBackup) -and (Test-Path -LiteralPath $nutBasePath)) {
    Copy-Item -LiteralPath $nutBackup -Destination $nutBasePath -Force
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
if (-not (Test-Path -LiteralPath $studioBackup)) {
    $liveStudio = [IO.File]::ReadAllBytes($studioUiPath)
    foreach ($needle in $offlineCallFrom) {
        if ((Find-ByteSequence $liveStudio $needle) -lt 0) { throw "live NutStudioUI.dll is not the original 627 mailbox/music offline check; refusing to back up a patched binary" }
    }
    Copy-Item -LiteralPath $studioUiPath -Destination $studioBackup -Force
}
$studioBytes = [IO.File]::ReadAllBytes($studioBackup)
foreach ($needle in $offlineCallFrom) {
    $studioOffset = Find-ByteSequence $studioBytes $needle
    if ($studioOffset -lt 0) { throw "original NutStudioUI.dll missing 627 mailbox/music offline check" }
    for ($i = 0; $i -lt $offlineCallPatch.Length; $i++) {
        $studioBytes[$studioOffset + 8 + $i] = $offlineCallPatch[$i]
    }
}
[IO.File]::WriteAllBytes($studioUiPath, $studioBytes)
$verifyStudio = [IO.File]::ReadAllBytes($studioUiPath)
foreach ($needle in $offlineCallFrom) {
    if ((Find-ByteSequence $verifyStudio $needle) -ge 0) { throw "NutStudioUI.dll offline check patch did not persist" }
}

$containerPluginPath = Join-Path $GameRoot "$Version\plugins\Container\NutContainerPlugin.dll"
if (-not (Test-Path -LiteralPath $containerPluginPath)) { throw "NutContainerPlugin.dll not found: $containerPluginPath" }
$containerPluginBackup = Join-Path ([IO.Path]::GetDirectoryName($OriginalFile)) ("NutContainerPlugin-" + $Version + ".dll")
$containerPluginCallFrom = [byte[]](0x48, 0x8B, 0xDA, 0x48, 0x8B, 0xF9, 0xFF, 0x15, 0x61, 0xA4, 0x04, 0x00, 0x84, 0xC0, 0x0F, 0x85)
if (-not (Test-Path -LiteralPath $containerPluginBackup)) {
    $livePlugin = [IO.File]::ReadAllBytes($containerPluginPath)
    if ((Find-ByteSequence $livePlugin $containerPluginCallFrom) -lt 0) { throw "live NutContainerPlugin.dll is not the original 627 lite-bar offline check; refusing to back up a patched binary" }
    Copy-Item -LiteralPath $containerPluginPath -Destination $containerPluginBackup -Force
}
$pluginBytes = [IO.File]::ReadAllBytes($containerPluginBackup)
$pluginOffset = Find-ByteSequence $pluginBytes $containerPluginCallFrom
if ($pluginOffset -lt 0) { throw "original NutContainerPlugin.dll missing 627 lite-bar offline check" }
for ($i = 0; $i -lt $offlineCallPatch.Length; $i++) {
    $pluginBytes[$pluginOffset + 6 + $i] = $offlineCallPatch[$i]
}
[IO.File]::WriteAllBytes($containerPluginPath, $pluginBytes)
$verifyPlugin = [IO.File]::ReadAllBytes($containerPluginPath)
if ((Find-ByteSequence $verifyPlugin $containerPluginCallFrom) -ge 0) { throw "NutContainerPlugin.dll offline check patch did not persist" }

$userSettingsPath = Join-Path $env:APPDATA "miHoYo\Olivia-steam\store\usersettings.dat"
$widgetLockFrom = $latin1.GetBytes(([char]10).ToString() + "mailWidget" + [char]6 + [char]5 + "false" + [char]11 + "musicWidget" + [char]6 + [char]5 + "false")
$widgetLockTo = $latin1.GetBytes(([char]10).ToString() + "mailWidget" + [char]6 + [char]4 + "true" + [char]11 + "musicWidget" + [char]6 + [char]4 + "true")
if (Test-Path -LiteralPath $userSettingsPath) {
    $settingsBytes = [IO.File]::ReadAllBytes($userSettingsPath)
    $widgetOffset = Find-ByteSequence $settingsBytes $widgetLockFrom
    if ($widgetOffset -ge 0) {
        $settingsBackup = Join-Path ([IO.Path]::GetDirectoryName($OriginalFile)) ("usersettings-" + $Version + ".dat")
        if (-not (Test-Path -LiteralPath $settingsBackup)) {
            Copy-Item -LiteralPath $userSettingsPath -Destination $settingsBackup -Force
        }
        $patchedSettings = New-Object byte[] $settingsBytes.Length
        [Array]::Copy($settingsBytes, 0, $patchedSettings, 0, $widgetOffset)
        [Array]::Copy($widgetLockTo, 0, $patchedSettings, $widgetOffset, $widgetLockTo.Length)
        $restStart = $widgetOffset + $widgetLockFrom.Length
        [Array]::Copy($settingsBytes, $restStart, $patchedSettings, $widgetOffset + $widgetLockTo.Length, $settingsBytes.Length - $restStart)
        $newSize = [BitConverter]::ToInt32($patchedSettings, 0) - ($widgetLockFrom.Length - $widgetLockTo.Length)
        [Array]::Copy([BitConverter]::GetBytes($newSize), 0, $patchedSettings, 0, 4)
        [IO.File]::WriteAllBytes($userSettingsPath, $patchedSettings)
        if ((Find-ByteSequence ([IO.File]::ReadAllBytes($userSettingsPath)) $widgetLockTo) -lt 0) {
            throw "usersettings.dat mailWidget/musicWidget patch did not persist"
        }
        Write-Output "usersettings=$userSettingsPath"
    }
}

$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash
$studioHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $studioUiPath).Hash
$pluginHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $containerPluginPath).Hash
Write-Output "patched=$source"
Write-Output "sha256=$hash"
Write-Output "studioUi=$studioUiPath"
Write-Output "studioUiSha256=$studioHash"
Write-Output "containerPlugin=$containerPluginPath"
Write-Output "containerPluginSha256=$pluginHash"
