param(
    [Parameter(Mandatory = $true)][string]$GameRoot,
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$OriginalFile,
    [string]$ServiceUrl = "http://127.0.0.1:27149"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$relative = "$Version\resources\feapp.dat"
$source = Join-Path $GameRoot $relative
$gamePrefix = [IO.Path]::GetFullPath($GameRoot).TrimEnd("\") + "\"
Get-CimInstance Win32_Process |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($gamePrefix, [StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
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
$patchMarker = '/*OliviaSoulPatch:mail-cache-v3*/'
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
    "/letter/resend"
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
if (-not $verifyText.Contains($mailboxEnabled)) { throw "patched archive still has mailbox entry disabled" }
if (-not $verifyText.Contains($videoReplyTo)) { throw "patched archive missing exclusive video reply mapping" }
if (-not $verifyText.Contains($offlineUser)) { throw "patched archive missing offline uid synchronization" }
if (-not $verifyText.Contains($orderedPollingLoop)) { throw "patched archive missing mailbox polling order fix" }
if (-not $verifyText.Contains($pollingStateTo)) { throw "patched archive missing polling status comparison" }
if (-not $verifyText.Contains($processingIconTo)) { throw "patched archive missing processing envelope icon condition" }
if (-not $verifyText.Contains($replyIcon)) { throw "patched archive missing reply icon mapping" }

$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash
Write-Output "patched=$source"
Write-Output "sha256=$hash"
