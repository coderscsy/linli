param(
    [Parameter(Mandatory = $true)][string]$GameRoot,
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$ServiceUrl = "http://127.0.0.1:27149"
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "process-control.ps1")
. (Join-Path $PSScriptRoot "patch-feapp-locale-local.ps1")
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$source = Join-Path $GameRoot "$Version\resources\feapp.dat"
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "feapp.dat not found: $source" }
Stop-GameProcesses $GameRoot
Start-Sleep -Milliseconds 250

$buildRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\_build\feapp-upgrade-v14-v16"))
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
$legacyMarker = '/*OliviaSoulPatch:mail-music-v14*/'
$currentMarker = '/*OliviaSoulPatch:mail-music-v16*/'
if ($text.StartsWith($legacyMarker)) {
    $text = $currentMarker + $text.Substring($legacyMarker.Length)
} elseif (-not $text.StartsWith($currentMarker)) {
    throw "client is not an OliviaSoul v14 or v16 patch"
}

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

$nativeDownloadFrom = 'const Dt=async()=>{if(!ge){ge=!0;try{const q=te.value,me=q.filter(Be=>!f.downloadMap.has(Be.id));me.forEach(Be=>f.initSongStatus(Be.id,Be.styleType)),me.length>0&&await f.syncLocalStatus(me.map(Le)),q.filter(Be=>!f.isDownloaded(Be.id)&&!f.isDownloading(Be.id)).forEach(Be=>f.startDownload(Be))}finally{ge=!1}}}'
$nativeDownloadTo = 'const Dt=async()=>{if(!ge){ge=!0;try{const q=te.value;q.forEach(Be=>{f.initSongStatus(Be.id,Be.styleType),f.downloadMap.set(Be.id,{...f.getDownloadEntry(Be.id),progress:100,state:"completed"})})}finally{ge=!1}}}'
$settingsInitFrom = 'l.value={...l.value,...p}};let c='
$settingsInitCurrent = 'l.value={...l.value,...p,mailWidget:!0,musicWidget:!0}};let c='
$settingsInitTo = 'c={...p},l.value={...l.value,...p,mailWidget:!0,musicWidget:!0}};let c='
$remainingFrom = 'w=j(()=>Math.max(0,g.value-y.value))'
$remainingTo = 'w=j(()=>g.value<=0?1:Math.max(0,g.value-y.value))'
$searchStateFrom = 'const{list:he,fetchList:xe,handleReset:$e,initInfiniteScroll:X}=Mt(dm,b({})),te=j(()=>he.value.map(s1))'
$searchStateTo = 'const OliviaSoulUploadSearch=b(""),OliviaSoulUploadParams=j(()=>({query:OliviaSoulUploadSearch.value,pageSize:100})),{list:he,fetchList:xe,handleReset:$e,initInfiniteScroll:X}=Mt(dm,OliviaSoulUploadParams),te=j(()=>he.value.map(s1))'
$searchHandlerFrom = 'dt=async()=>{Q.value&&($e(),await xe(),await zt(),X(eo(ct.value)))},Do=()=>{M(so)}'
$searchHandlerBroken = 'dt=async()=>{Q.value&&($e(),await xe(),await zt(),X(eo(ct.value)))};let OliviaSoulSearchTimer=null;const OliviaSoulSearch=at=>{OliviaSoulUploadSearch.value=at.target.value,OliviaSoulSearchTimer&&clearTimeout(OliviaSoulSearchTimer),OliviaSoulSearchTimer=setTimeout(()=>dt(),250)},Do=()=>{M(so)}'
$searchHandlerCurrent = 'dt=async()=>{Q.value&&($e(),await xe(),await zt(),X(eo(ct.value)))};let OliviaSoulSearchTimer=null,OliviaSoulUploadRefresh=null;const OliviaSoulSearch=at=>{OliviaSoulUploadSearch.value=at.target.value,OliviaSoulSearchTimer&&clearTimeout(OliviaSoulSearchTimer),OliviaSoulSearchTimer=setTimeout(()=>dt(),250)},Do=()=>{M(so)}'
$searchHandlerLegacy = 'dt=async()=>{Q.value&&($e(),await xe(),await zt(),X(eo(ct.value)))};let OliviaSoulSearchTimer=null,OliviaSoulUploadRefresh=null;const OliviaSoulSilentRefresh=async()=>{if(Q.value){const at=await dm({query:OliviaSoulUploadSearch.value,cursor:0,pageSize:Math.max(100,he.value.length)});he.value.splice(0,he.value.length,...at.list),await zt()}},OliviaSoulSearch=at=>{OliviaSoulUploadSearch.value=at.target.value,OliviaSoulSearchTimer&&clearTimeout(OliviaSoulSearchTimer),OliviaSoulSearchTimer=setTimeout(()=>dt(),250)},Do=()=>{M(so)}'
$searchHandlerTo = 'dt=async()=>{Q.value&&($e(),await xe(),await zt(),X(eo(ct.value)))};let OliviaSoulSearchTimer=null,OliviaSoulUploadRefresh=null,OliviaSoulUploadRevision=null,OliviaSoulUploadRefreshing=!1,OliviaSoulSearchComposing=!1;const OliviaSoulSilentRefresh=async()=>{if(Q.value&&!OliviaSoulUploadRefreshing){OliviaSoulUploadRefreshing=!0;try{const at=await dm({query:OliviaSoulUploadSearch.value,cursor:0,pageSize:Math.max(100,he.value.length)});if(OliviaSoulUploadRevision===at.revision)return;OliviaSoulUploadRevision=at.revision;const vt=new Map(he.value.map((wt,kt)=>[wt.id,kt])),pt=new Set;at.list.forEach(wt=>{pt.add(wt.id);const kt=vt.get(wt.id);kt===void 0?he.value.push(wt):Object.assign(he.value[kt],wt)});if(!at.hasMore)for(let wt=he.value.length-1;wt>=0;wt-=1)pt.has(he.value[wt].id)||he.value.splice(wt,1);await zt()}finally{OliviaSoulUploadRefreshing=!1}}},OliviaSoulSearch=at=>{OliviaSoulUploadSearch.value=at.target.value;if(OliviaSoulSearchComposing)return;OliviaSoulSearchTimer&&clearTimeout(OliviaSoulSearchTimer),OliviaSoulSearchTimer=setTimeout(()=>dt(),250)},OliviaSoulCompositionStart=()=>{OliviaSoulSearchComposing=!0},OliviaSoulCompositionEnd=at=>{OliviaSoulSearchComposing=!1,OliviaSoulSearch(at)},Do=()=>{M(so)}'
$searchRenderFrom = 'k(Eo,{"column-config":o(x),class:"mr-4"},null,8,["column-config"]),o(l)?'
$searchRenderLegacy = 'k(Eo,{"column-config":o(x),class:"mr-4"},null,8,["column-config"]),o(Q)?(r(),_("input",{key:"OliviaSoulSearch",value:o(OliviaSoulUploadSearch),type:"search",placeholder:"\u641c\u7d22\u6211\u7684\u4e0a\u4f20",class:"mx-3 mb-2 h-9 px-3 rounded-2 border border-grey-4 bg-grey-0 text-text-title text-body-m",onInput:OliviaSoulSearch},null,40,["value"])):Y("",!0),o(l)?'
$searchRenderTo = 'k(Eo,{"column-config":o(x),class:"mr-4"},null,8,["column-config"]),o(Q)?(r(),_("input",{key:"OliviaSoulSearch",value:o(OliviaSoulUploadSearch),type:"search",placeholder:"\u641c\u7d22\u6211\u7684\u4e0a\u4f20",class:"mx-3 mb-2 h-9 px-3 rounded-2 border border-grey-4 bg-grey-0 text-text-title text-body-m",onInput:OliviaSoulSearch,onCompositionstart:OliviaSoulCompositionStart,onCompositionend:OliviaSoulCompositionEnd},null,40,["value"])):Y("",!0),o(l)?'
$refreshFrom = 'He(async()=>{if(w.value){await W().finally(()=>{a.value=!1}),Po();return}await Ua(),await W().finally(()=>{a.value=!1}),Po()});'
$refreshBroken = 'let OliviaSoulUploadRefresh=null;He(async()=>{OliviaSoulUploadRefresh=setInterval(()=>{Q.value&&dt()},5000);if(w.value){await W().finally(()=>{a.value=!1}),Po();return}await Ua(),await W().finally(()=>{a.value=!1}),Po()}),Ot(()=>{OliviaSoulUploadRefresh&&(clearInterval(OliviaSoulUploadRefresh),OliviaSoulUploadRefresh=null),OliviaSoulSearchTimer&&(clearTimeout(OliviaSoulSearchTimer),OliviaSoulSearchTimer=null)});'
$refreshCurrent = 'He(async()=>{OliviaSoulUploadRefresh=setInterval(()=>{Q.value&&dt()},5000);if(w.value){await W().finally(()=>{a.value=!1}),Po();return}await Ua(),await W().finally(()=>{a.value=!1}),Po()}),Ot(()=>{OliviaSoulUploadRefresh&&(clearInterval(OliviaSoulUploadRefresh),OliviaSoulUploadRefresh=null),OliviaSoulSearchTimer&&(clearTimeout(OliviaSoulSearchTimer),OliviaSoulSearchTimer=null)});'
$refreshTo = 'He(async()=>{OliviaSoulUploadRefresh=setInterval(()=>{Q.value&&OliviaSoulSilentRefresh()},5000);if(w.value){await W().finally(()=>{a.value=!1}),Po();return}await Ua(),await W().finally(()=>{a.value=!1}),Po()}),Ot(()=>{OliviaSoulUploadRefresh&&(clearInterval(OliviaSoulUploadRefresh),OliviaSoulUploadRefresh=null),OliviaSoulSearchTimer&&(clearTimeout(OliviaSoulSearchTimer),OliviaSoulSearchTimer=null)});'

if ($text.Contains($settingsInitCurrent)) { $text = $text.Replace($settingsInitCurrent, $settingsInitTo) }
if ($text.Contains($searchHandlerBroken)) { $text = $text.Replace($searchHandlerBroken, $searchHandlerTo) }
if ($text.Contains($searchHandlerCurrent)) { $text = $text.Replace($searchHandlerCurrent, $searchHandlerTo) }
if ($text.Contains($searchHandlerLegacy)) { $text = $text.Replace($searchHandlerLegacy, $searchHandlerTo) }
if ($text.Contains($searchRenderLegacy)) { $text = $text.Replace($searchRenderLegacy, $searchRenderTo) }
if ($text.Contains($refreshBroken)) { $text = $text.Replace($refreshBroken, $refreshTo) }
if ($text.Contains($refreshCurrent)) { $text = $text.Replace($refreshCurrent, $refreshTo) }

$pairIndex = 0
foreach ($pair in @(
    @($nativeDownloadFrom, $nativeDownloadTo),
    @($settingsInitFrom, $settingsInitTo),
    @($remainingFrom, $remainingTo),
    @($searchStateFrom, $searchStateTo),
    @($searchHandlerFrom, $searchHandlerTo),
    @($searchRenderFrom, $searchRenderTo),
    @($refreshFrom, $refreshTo)
)) {
    $count = ([regex]::Matches($text, [regex]::Escape($pair[0]))).Count
    $upgradedCount = ([regex]::Matches($text, [regex]::Escape($pair[1]))).Count
    if ($count -eq 1 -and $upgradedCount -eq 0) {
        $text = $text.Replace($pair[0], $pair[1])
    } elseif ($count -ne 0 -or $upgradedCount -ne 1) {
        throw "expected one v14 upgrade occurrence at index $pairIndex, got old=$count new=$upgradedCount"
    }
    $pairIndex += 1
}

[IO.File]::WriteAllText($mainPath, $text, $utf8)
Set-OliviaSoulLocalMidiLocale -ExtractedRoot $extracted -Utf8 $utf8

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
foreach ($expected in @($currentMarker, $nativeDownloadTo, $settingsInitTo, $remainingTo, $searchStateTo, $searchHandlerTo, $searchRenderTo, $refreshTo)) {
    if (-not $verifyText.Contains($expected)) { throw "upgraded archive verification failed" }
}
Copy-Item -LiteralPath $patched -Destination $source -Force
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash
Write-Output "upgraded=$source"
Write-Output "sha256=$hash"
