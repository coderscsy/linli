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

$buildRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\_build\feapp-upgrade-v16-v17"))
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
$legacyMarkers = @(
    '/*OliviaSoulPatch:mail-music-v20*/',
    '/*OliviaSoulPatch:mail-music-v19*/',
    '/*OliviaSoulPatch:mail-music-v18*/',
    '/*OliviaSoulPatch:mail-music-v17*/',
    '/*OliviaSoulPatch:mail-music-v16*/',
    '/*OliviaSoulPatch:mail-music-v15*/',
    '/*OliviaSoulPatch:mail-music-v14*/'
)
$currentMarker = '/*OliviaSoulPatch:mail-music-v21*/'
$legacyMarker = @($legacyMarkers | Where-Object { $text.StartsWith($_) } | Select-Object -First 1)
if ($legacyMarker.Count -ne 1) { throw "client is not an OliviaSoul v14-v20 patch" }
$text = $currentMarker + $text.Substring($legacyMarker[0].Length)

$downloadOriginal = 'const Dt=async()=>{if(!ge){ge=!0;try{const q=te.value,me=q.filter(Be=>!f.downloadMap.has(Be.id));me.forEach(Be=>f.initSongStatus(Be.id,Be.styleType)),me.length>0&&await f.syncLocalStatus(me.map(Le)),q.filter(Be=>!f.isDownloaded(Be.id)&&!f.isDownloading(Be.id)).forEach(Be=>f.startDownload(Be))}finally{ge=!1}}}'
$downloadFake = 'const Dt=async()=>{if(!ge){ge=!0;try{const q=te.value;q.forEach(Be=>{f.initSongStatus(Be.id,Be.styleType),f.downloadMap.set(Be.id,{...f.getDownloadEntry(Be.id),progress:100,state:"completed"})})}finally{ge=!1}}}'
$downloadOnDemand = 'const Dt=async()=>{if(!ge){ge=!0;try{te.value.forEach(q=>f.initSongStatus(q.id,q.styleType))}finally{ge=!1}}}'
$downloadLocal = 'const Dt=async()=>{}'
$originalDownloadCount = ([regex]::Matches($text, [regex]::Escape($downloadOriginal))).Count
$fakeDownloadCount = ([regex]::Matches($text, [regex]::Escape($downloadFake))).Count
$onDemandDownloadCount = ([regex]::Matches($text, [regex]::Escape($downloadOnDemand))).Count
if (($originalDownloadCount + $fakeDownloadCount + $onDemandDownloadCount) -ne 1) { throw "expected one legacy My Upload download flow" }
if ($originalDownloadCount -eq 1) { $text = $text.Replace($downloadOriginal, $downloadLocal) }
elseif ($fakeDownloadCount -eq 1) { $text = $text.Replace($downloadFake, $downloadLocal) }
else { $text = $text.Replace($downloadOnDemand, $downloadLocal) }

$playLegacy = 'Mo=q=>{m.value=q.id,h.playSonglistItem(q)},Lo=()=>{h.isPlaying?h.stopCurrentSong("switch_library"):h.handleTogglePlay()},Ro=q=>{m.value=q.id;const{waveformData:me,...Be}=q;s(rt.Perform,Be),Mo(q)},Bo=q=>{f.startDownload(q)},Uo=()=>{Z.songBatchDownloadClick(),u.value=!0}'
$playV19 = 'Mo=q=>{m.value=q.id,h.playSonglistItem(q)},Lo=()=>{h.isPlaying?h.stopCurrentSong("switch_library"):h.handleTogglePlay()},Ro=q=>{m.value=q.id;const{waveformData:me,...Be}=q;s(rt.Perform,Be),Mo(q)},OliviaSoulPendingUpload=b(null),Bo=async q=>{OliviaSoulPendingUpload.value=q,f.initSongStatus(q.id,q.styleType),await f.syncLocalStatus([Le(q)]);if(!OliviaSoulPendingUpload.value||OliviaSoulPendingUpload.value.id!==q.id)return;f.isDownloaded(q.id)?(OliviaSoulPendingUpload.value=null,Ro(q)):f.isDownloading(q.id)||f.startDownload(q)},Uo=()=>{Z.songBatchDownloadClick(),u.value=!0}'
$playDirect = 'Mo=q=>{m.value=q.id,h.playSonglistItem(q)},Lo=()=>{h.isPlaying?h.stopCurrentSong("switch_library"):h.handleTogglePlay()},Ro=q=>{m.value=q.id;const{waveformData:me,...Be}=q;s(rt.Perform,Be),Mo(q)},Bo=q=>{Ro(q)},Uo=()=>{Z.songBatchDownloadClick(),u.value=!0}'
$playLegacyCount = ([regex]::Matches($text, [regex]::Escape($playLegacy))).Count
$playV19Count = ([regex]::Matches($text, [regex]::Escape($playV19))).Count
if (($playLegacyCount + $playV19Count) -ne 1) { throw "expected one legacy My Upload play handler" }
if ($playLegacyCount -eq 1) { $text = $text.Replace($playLegacy, $playDirect) }
else { $text = $text.Replace($playV19, $playDirect) }

$completionLegacy = 'Do=()=>{M(so)};Lt().setOnJobCompleted'
$completionV19 = 'Do=()=>{M(so)};_e(()=>OliviaSoulPendingUpload.value?f.getDownloadEntry(OliviaSoulPendingUpload.value.id).state:null,q=>{if(q==="completed"&&OliviaSoulPendingUpload.value){const me=OliviaSoulPendingUpload.value;OliviaSoulPendingUpload.value=null,Ro(me)}else(q==="failed"||q==="cancelled")&&(OliviaSoulPendingUpload.value=null)});Lt().setOnJobCompleted'
$completionLegacyCount = ([regex]::Matches($text, [regex]::Escape($completionLegacy))).Count
$completionV19Count = ([regex]::Matches($text, [regex]::Escape($completionV19))).Count
if (($completionLegacyCount + $completionV19Count) -ne 1) { throw "expected one My Upload completion hook" }
if ($completionV19Count -eq 1) { $text = $text.Replace($completionV19, $completionLegacy) }

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

$featureEnabled = 'N3=!0,Ss=!0,wa=({onComplete'
$featureDisabled = 'N3=!0,Ss=!1,wa=({onComplete'
$enabledCount = ([regex]::Matches($text, [regex]::Escape($featureEnabled))).Count
$disabledCount = ([regex]::Matches($text, [regex]::Escape($featureDisabled))).Count
if ($enabledCount -eq 1 -and $disabledCount -eq 0) {
    $text = $text.Replace($featureEnabled, $featureDisabled)
} elseif ($enabledCount -ne 0 -or $disabledCount -ne 1) {
    throw "expected one custom performance feature gate, got enabled=$enabledCount disabled=$disabledCount"
}

$cardShown = 'o(Ss)?(r(),F(Be,'
$cardHidden = '!o(w)&&o(Ss)?(r(),F(Be,'
$shownCount = ([regex]::Matches($text, [regex]::Escape($cardShown))).Count
$hiddenCount = ([regex]::Matches($text, [regex]::Escape($cardHidden))).Count
if ($hiddenCount -eq 0 -and $shownCount -eq 1) {
    $text = $text.Replace($cardShown, $cardHidden)
} elseif ($hiddenCount -ne 1) {
    throw "expected one custom performance card, got shown=$shownCount hidden=$hiddenCount"
}

$searchStateBase = 'const{list:he,fetchList:xe,handleReset:$e,initInfiniteScroll:X}=Mt(dm,b({})),te=j(()=>he.value.map(s1))'
$searchStateCurrent = 'const OliviaSoulUploadSearch=b(""),OliviaSoulUploadParams=j(()=>({query:OliviaSoulUploadSearch.value,pageSize:100})),{list:he,fetchList:xe,handleReset:$e,initInfiniteScroll:X}=Mt(dm,OliviaSoulUploadParams),te=j(()=>he.value.map(s1))'
$baseStateCount = ([regex]::Matches($text, [regex]::Escape($searchStateBase))).Count
$currentStateCount = ([regex]::Matches($text, [regex]::Escape($searchStateCurrent))).Count
if ($baseStateCount -eq 1 -and $currentStateCount -eq 0) {
    $text = $text.Replace($searchStateBase, $searchStateCurrent)
} elseif ($baseStateCount -ne 0 -or $currentStateCount -ne 1) {
    throw "expected one My Upload search state, got base=$baseStateCount current=$currentStateCount"
}

$searchHandlerBase = 'dt=async()=>{Q.value&&($e(),await xe(),await zt(),X(eo(ct.value)))},Do=()=>{M(so)}'
$searchHandlerLegacy = 'dt=async()=>{Q.value&&($e(),await xe(),await zt(),X(eo(ct.value)))};let OliviaSoulSearchTimer=null,OliviaSoulUploadRefresh=null;const OliviaSoulSilentRefresh=async()=>{if(Q.value){const at=await dm({query:OliviaSoulUploadSearch.value,cursor:0,pageSize:Math.max(100,he.value.length)});he.value.splice(0,he.value.length,...at.list),await zt()}},OliviaSoulSearch=at=>{OliviaSoulUploadSearch.value=at.target.value,OliviaSoulSearchTimer&&clearTimeout(OliviaSoulSearchTimer),OliviaSoulSearchTimer=setTimeout(()=>dt(),250)},Do=()=>{M(so)}'
$searchHandlerCurrent = 'dt=async()=>{Q.value&&($e(),await xe(),await zt(),X(eo(ct.value)))};let OliviaSoulSearchTimer=null,OliviaSoulUploadRefresh=null,OliviaSoulUploadRevision=null,OliviaSoulUploadRefreshing=!1,OliviaSoulSearchComposing=!1;const OliviaSoulSilentRefresh=async()=>{if(Q.value&&!OliviaSoulUploadRefreshing){OliviaSoulUploadRefreshing=!0;try{const at=await dm({query:OliviaSoulUploadSearch.value,cursor:0,pageSize:Math.max(100,he.value.length)});if(OliviaSoulUploadRevision===at.revision)return;OliviaSoulUploadRevision=at.revision;const vt=new Map(he.value.map((wt,kt)=>[wt.id,kt])),pt=new Set;at.list.forEach(wt=>{pt.add(wt.id);const kt=vt.get(wt.id);kt===void 0?he.value.push(wt):Object.assign(he.value[kt],wt)});if(!at.hasMore)for(let wt=he.value.length-1;wt>=0;wt-=1)pt.has(he.value[wt].id)||he.value.splice(wt,1);await zt()}finally{OliviaSoulUploadRefreshing=!1}}},OliviaSoulSearch=at=>{OliviaSoulUploadSearch.value=at.target.value;if(OliviaSoulSearchComposing)return;OliviaSoulSearchTimer&&clearTimeout(OliviaSoulSearchTimer),OliviaSoulSearchTimer=setTimeout(()=>dt(),250)},OliviaSoulCompositionStart=()=>{OliviaSoulSearchComposing=!0},OliviaSoulCompositionEnd=at=>{OliviaSoulSearchComposing=!1,OliviaSoulSearch(at)},Do=()=>{M(so)}'
$searchRenderBase = 'k(Eo,{"column-config":o(x),class:"mr-4"},null,8,["column-config"]),o(l)?'
$searchRenderLegacy = 'k(Eo,{"column-config":o(x),class:"mr-4"},null,8,["column-config"]),o(Q)?(r(),_("input",{key:"OliviaSoulSearch",value:o(OliviaSoulUploadSearch),type:"search",placeholder:"\u641c\u7d22\u6211\u7684\u4e0a\u4f20",class:"mx-3 mb-2 h-9 px-3 rounded-2 border border-grey-4 bg-grey-0 text-text-title text-body-m",onInput:OliviaSoulSearch},null,40,["value"])):Y("",!0),o(l)?'
$searchRenderCurrent = 'k(Eo,{"column-config":o(x),class:"mr-4"},null,8,["column-config"]),o(Q)?(r(),_("input",{key:"OliviaSoulSearch",value:o(OliviaSoulUploadSearch),type:"search",placeholder:"\u641c\u7d22\u6211\u7684\u4e0a\u4f20",class:"mx-3 mb-2 h-9 px-3 rounded-2 border border-grey-4 bg-grey-0 text-text-title text-body-m",onInput:OliviaSoulSearch,onCompositionstart:OliviaSoulCompositionStart,onCompositionend:OliviaSoulCompositionEnd},null,40,["value"])):Y("",!0),o(l)?'
$baseSearchCount = ([regex]::Matches($text, [regex]::Escape($searchHandlerBase))).Count
$legacySearchCount = ([regex]::Matches($text, [regex]::Escape($searchHandlerLegacy))).Count
$currentSearchCount = ([regex]::Matches($text, [regex]::Escape($searchHandlerCurrent))).Count
if ($baseSearchCount -eq 1 -and $legacySearchCount -eq 0 -and $currentSearchCount -eq 0) {
    $text = $text.Replace($searchHandlerBase, $searchHandlerCurrent)
} elseif ($baseSearchCount -eq 0 -and $legacySearchCount -eq 1 -and $currentSearchCount -eq 0) {
    $text = $text.Replace($searchHandlerLegacy, $searchHandlerCurrent)
} elseif ($baseSearchCount -ne 0 -or $legacySearchCount -ne 0 -or $currentSearchCount -ne 1) {
    throw "expected one My Upload revision refresh, got base=$baseSearchCount legacy=$legacySearchCount current=$currentSearchCount"
}
$baseRenderCount = ([regex]::Matches($text, [regex]::Escape($searchRenderBase))).Count
$legacyRenderCount = ([regex]::Matches($text, [regex]::Escape($searchRenderLegacy))).Count
$currentRenderCount = ([regex]::Matches($text, [regex]::Escape($searchRenderCurrent))).Count
if ($baseRenderCount -eq 1 -and $legacyRenderCount -eq 0 -and $currentRenderCount -eq 0) {
    $text = $text.Replace($searchRenderBase, $searchRenderCurrent)
} elseif ($baseRenderCount -eq 0 -and $legacyRenderCount -eq 1 -and $currentRenderCount -eq 0) {
    $text = $text.Replace($searchRenderLegacy, $searchRenderCurrent)
} elseif ($baseRenderCount -ne 0 -or $legacyRenderCount -ne 0 -or $currentRenderCount -ne 1) {
    throw "expected one My Upload composition-safe search, got base=$baseRenderCount legacy=$legacyRenderCount current=$currentRenderCount"
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
if (-not $verifyText.StartsWith($currentMarker)) { throw "upgraded archive missing v21 marker" }
if (-not $verifyText.Contains($featureDisabled) -or $verifyText.Contains($featureEnabled)) {
    throw "upgraded archive still enables keyboard-only custom performance"
}
if (-not $verifyText.Contains($cardHidden)) { throw "upgraded archive still shows the custom performance card" }
if (-not $verifyText.Contains($searchHandlerCurrent) -or $verifyText.Contains($searchHandlerLegacy)) {
    throw "upgraded archive still replaces the complete My Upload list"
}
if (-not $verifyText.Contains($searchRenderCurrent)) {
    throw "upgraded archive is missing composition-safe My Upload search"
}
if (-not $verifyText.Contains($downloadLocal) -or $verifyText.Contains($downloadFake) -or $verifyText.Contains($downloadOnDemand)) {
    throw "upgraded archive still initializes My Upload downloads"
}
if (-not $verifyText.Contains($playDirect) -or -not $verifyText.Contains($completionLegacy) -or $verifyText.Contains('OliviaSoulPendingUpload')) {
    throw "upgraded archive is missing direct My Upload playback"
}

$backup = "$source.oliviasoul-v21.bak"
if (-not (Test-Path -LiteralPath $backup)) { Copy-Item -LiteralPath $source -Destination $backup }
Copy-Item -LiteralPath $patched -Destination $source -Force
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash
Write-Output "upgraded=$source"
Write-Output "backup=$backup"
Write-Output "sha256=$hash"
