[CmdletBinding()]
param(
    [string]$OutputDirectory = "",
    [string]$WorkDirectory = "",
    [string]$DotNet = "",
    [string]$Iscc = "",
    [switch]$ResolvePathsOnly,
    [switch]$ChecksumOnly
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$project = Split-Path $PSScriptRoot -Parent
$repository = Split-Path $project -Parent
$utf8NoBom = New-Object Text.UTF8Encoding $false
. (Join-Path $PSScriptRoot "package-safety.ps1")

$version = "2008.2.7"
$packagePath = Join-Path $project "package.json"
$packageText = [IO.File]::ReadAllText($packagePath, $utf8NoBom)
$package = $packageText | ConvertFrom-Json
if ([string]$package.version -ne $version) { throw "package.json 版本必须固定为林离生日 $version" }

$lockPath = Join-Path $project "package-lock.json"
$lockText = [IO.File]::ReadAllText($lockPath, $utf8NoBom)
$lockVersionCount = ([regex]::Matches($lockText, [regex]::Escape('"version": "' + $version + '"'))).Count
if ($lockVersionCount -ne 2) { throw "package-lock.json 必须有两处固定生日版本 $version" }

$nativeProjectPath = Join-Path $project "native-host\OliviaSoul.csproj"
$nativeProjectText = [IO.File]::ReadAllText($nativeProjectPath, $utf8NoBom)
foreach ($token in @(
    "<Version>$version</Version>",
    "<AssemblyVersion>$version.0</AssemblyVersion>",
    "<FileVersion>$version.0</FileVersion>"
)) {
    if (-not $nativeProjectText.Contains($token)) { throw "原生程序版本必须固定为林离生日 $version" }
}
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) { $OutputDirectory = Join-Path $repository "build" }
$buildTools = Join-Path $project "dist-native\build-tools"
$downloadCache = Join-Path $buildTools "downloads"
$env:DOTNET_CLI_HOME = Join-Path $buildTools "dotnet-home"
$env:NUGET_PACKAGES = Join-Path $buildTools "nuget-packages"

if ($ResolvePathsOnly) {
    [pscustomobject]@{
        buildTools = [IO.Path]::GetFullPath($buildTools)
        downloadCache = [IO.Path]::GetFullPath($downloadCache)
        dotnetCliHome = [IO.Path]::GetFullPath($env:DOTNET_CLI_HOME)
        nugetPackages = [IO.Path]::GetFullPath($env:NUGET_PACKAGES)
        outputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
    } | ConvertTo-Json -Compress
    exit 0
}

Write-Output "Olivia Soul version: $version (fixed)"
if ([string]::IsNullOrWhiteSpace($WorkDirectory)) {
    $WorkDirectory = Join-Path $project ("dist-native\package-work\" + [Guid]::NewGuid().ToString("N"))
}
$stage = Join-Path $WorkDirectory "stage"
$nodeVersion = "22.22.0"
$nodeArchiveName = "node-v$nodeVersion-win-x64.zip"
$nodeArchive = Join-Path $downloadCache $nodeArchiveName
$nodeUrl = "https://nodejs.org/dist/v$nodeVersion/$nodeArchiveName"
$nodeChecksums = Join-Path $downloadCache "node-v$nodeVersion-SHASUMS256.txt"
$nodeArchiveSha256 = "c97fa376d2becdc8863fcd3ca2dd9a83a9f3468ee7ccf7a6d076ec66a645c77a"
$nodeExeSha256 = "bae898add4643fcf890a83ad8ae56e20dce7e781cab161a53991ceba70c99ffb"
$webViewBootstrapper = Join-Path $downloadCache "MicrosoftEdgeWebview2Setup.exe"
$webViewUrl = "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
$whisperVersion = "v1.9.2"
$whisperArchiveName = "whisper-bin-x64.zip"
$whisperArchive = Join-Path $downloadCache "$whisperVersion-$whisperArchiveName"
$whisperUrl = "https://github.com/ggml-org/whisper.cpp/releases/download/$whisperVersion/$whisperArchiveName"
$whisperSha256 = "49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a"
$whisperTalkLlamaExeSha256 = "31dbb055479cde7d05919dcabfdb7aa792f0fbb46c848e50f44aa8688c47801e"
$whisperModel = Join-Path $downloadCache "ggml-small.bin"
$whisperModelUrls = @(
    "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin"
)
$whisperModelSha256 = "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b"
$ffmpegRelease = "autobuild-2026-08-25-13-06"
$ffmpegArchiveName = "ffmpeg-n9.0.1-6-g9d4ca21220-win64-lgpl-9.0.zip"
$ffmpegArchive = Join-Path $downloadCache $ffmpegArchiveName
$ffmpegUrl = "https://github.com/BtbN/FFmpeg-Builds/releases/download/$ffmpegRelease/$ffmpegArchiveName"
$ffmpegSha256 = "2a78472df18a88405bfd2cbbce729ff0179bae4b0a13afc43f26d409eb822496"
$ffmpegExeSha256 = "b25445154b6f77e46f321b0de49a3d9fe4a462a5fdb7765c1ff4a9ce9950f44e"
$ffprobeExeSha256 = "beec24941e9d77db32e6ce6b21731575e18c92dff4d7c04988e0d115021a8259"

function Ensure-Directory([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { New-Item -ItemType Directory -Path $Path | Out-Null }
}

function Copy-PublicFile([string]$Source, [string]$Destination) {
    $parent = Split-Path $Destination -Parent
    Ensure-Directory $parent
    for ($attempt = 1; $attempt -le 5; $attempt++) {
        try {
            Copy-Item -LiteralPath $Source -Destination $Destination -Force
            return
        }
        catch {
            if ($attempt -eq 5) { throw }
            Start-Sleep -Milliseconds 500
        }
    }
}

function Get-Sha256Hash([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = $sha256.ComputeHash($stream)
        return ([BitConverter]::ToString($bytes)).Replace("-", "")
    }
    finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
}

function Download-PinnedFile([string]$Url, [string]$Path) {
    $urls = @($Url, "https://ghfast.top/$Url", "https://gh-proxy.com/$Url")
    foreach ($candidate in $urls) {
        try {
            Invoke-WebRequest -UseBasicParsing -Uri $candidate -OutFile $Path
            return
        } catch {
            Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
        }
    }
    throw "固定依赖下载失败：$Url"
}

function Write-ReleaseChecksums([string]$Directory) {
    $artifacts = @(
        (Join-Path $Directory "OliviaSoul-$version-Setup.exe"),
        (Join-Path $Directory "OliviaSoul-$version-Portable.zip")
    )
    $lines = foreach ($artifact in $artifacts) {
        if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) {
            throw "缺少发布文件：$artifact"
        }
        $hash = Get-Sha256Hash $artifact
        "$hash  $([IO.Path]::GetFileName($artifact))"
    }
    [IO.File]::WriteAllText(
        (Join-Path $Directory "SHA256SUMS.txt"),
        (($lines -join "`n") + "`n"),
        $utf8NoBom
    )
}

if ($ChecksumOnly) {
    Write-ReleaseChecksums $OutputDirectory
    exit 0
}

# Fail before touching output or building. Existing output is never deleted.
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$WorkDirectory = [IO.Path]::GetFullPath($WorkDirectory)
$stage = Join-Path $WorkDirectory "stage"
Assert-EmptyPackageDirectory -Path $OutputDirectory -ProtectedRoots @($project, $repository)
Assert-EmptyPackageDirectory -Path $WorkDirectory -ProtectedRoots @($project, $repository)
if ($WorkDirectory.TrimEnd('\') -eq $OutputDirectory.TrimEnd('\') -or
    $WorkDirectory.StartsWith($OutputDirectory.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or
    $OutputDirectory.StartsWith($WorkDirectory.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "Package output and work directories must be separate, non-overlapping directories"
}

$forbiddenPackageValues = @(
    $env:USERPROFILE,
    $env:APPDATA,
    $env:LOCALAPPDATA,
    $repository,
    $project,
    $PSScriptRoot,
    $WorkDirectory,
    $OutputDirectory,
    $buildTools,
    $downloadCache
) | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }
if (-not [string]::IsNullOrWhiteSpace($env:OLIVIA_SOUL_PRIVATE_ROOTS)) {
    $forbiddenPackageValues += @($env:OLIVIA_SOUL_PRIVATE_ROOTS -split [IO.Path]::PathSeparator) |
        Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }
}
$forbiddenPackageValues = @($forbiddenPackageValues | Select-Object -Unique)
$trustedStageFiles = @{
    "runtime/node.exe" = $nodeExeSha256
    "runtime/whisper/whisper-talk-llama.exe" = $whisperTalkLlamaExeSha256
    "runtime/whisper/ggml-small.bin" = $whisperModelSha256
    "runtime/ffmpeg/bin/ffmpeg.exe" = $ffmpegExeSha256
    "runtime/ffmpeg/bin/ffprobe.exe" = $ffprobeExeSha256
}

function Copy-ZipEntry([string]$Archive, [string]$EntryName, [string]$Destination) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        $entry = $zip.GetEntry($EntryName)
        if (-not $entry) { $entry = $zip.GetEntry($EntryName.Replace('/', '\')) }
        if (-not $entry) { throw "Required archive entry is missing: $EntryName" }
        Ensure-Directory (Split-Path $Destination -Parent)
        $inputStream = $entry.Open()
        try {
            $outputStream = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew)
            try { $inputStream.CopyTo($outputStream) }
            finally { $outputStream.Dispose() }
        }
        finally { $inputStream.Dispose() }
    }
    finally { $zip.Dispose() }
}

function Copy-ReviewGuides([string]$Source, [string]$Stage, [string]$Output = "") {
    foreach ($name in @("使用说明.txt", "发布说明.md", "反馈指南.md")) {
        Copy-PublicFile (Join-Path $Source $name) (Join-Path $Stage $name)
        if (-not [string]::IsNullOrWhiteSpace($Output)) {
            Copy-PublicFile (Join-Path $Source $name) (Join-Path $Output $name)
        }
    }
}

function Copy-WebViewNotices([string]$ProjectFile, [string]$NugetRoot, [string]$Stage) {
    [xml]$definition = [IO.File]::ReadAllText($ProjectFile)
    $references = @($definition.Project.ItemGroup.PackageReference | Where-Object { $_.Include -eq "Microsoft.Web.WebView2" })
    if ($references.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$references[0].Version)) {
        throw "Cannot resolve the WebView2 SDK version for license staging"
    }
    $sdk = Join-Path $NugetRoot ("microsoft.web.webview2\" + [string]$references[0].Version)
    foreach ($name in @("LICENSE.txt", "NOTICE.txt")) {
        Copy-PublicFile (Join-Path $sdk $name) (Join-Path $Stage "licenses\WebView2\$name")
    }
}

function Copy-SteamLauncherPayload([string]$Source, [string]$Compiled, [string]$Destination) {
    foreach ($name in @("README.md", "configure.ps1", "steam-launch-options.mjs")) {
        Copy-PublicFile (Join-Path $Source $name) (Join-Path $Destination $name)
    }
    Copy-PublicFile (Join-Path $Compiled "OliviaSteamWaiter.exe") (Join-Path $Destination "OliviaSteamWaiter.exe")
}
Ensure-Directory $WorkDirectory
Ensure-Directory $downloadCache
Ensure-Directory $env:DOTNET_CLI_HOME
Ensure-Directory $env:NUGET_PACKAGES

if ([string]::IsNullOrWhiteSpace($DotNet)) {
    $localDotNet = Join-Path $buildTools "dotnet\dotnet.exe"
    if (Test-Path -LiteralPath $localDotNet) { $DotNet = $localDotNet }
    else { $DotNet = (Get-Command dotnet.exe -ErrorAction Stop).Source }
}

$builtHost = Join-Path $project "native-host\bin\Release\net462\OliviaSoul.exe"
$runningHost = Get-Process OliviaSoul -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $builtHost }
if ($runningHost) {
    if (Test-Path -LiteralPath $builtHost) {
        throw "Source build host is running; close it yourself before packaging: $builtHost"
    }
}

$nativeOutput = Join-Path $WorkDirectory "native-output"
$nativeIntermediate = (Join-Path $WorkDirectory "native-obj") + [IO.Path]::DirectorySeparatorChar
& $DotNet build (Join-Path $project "native-host\OliviaSoul.csproj") -c Release -o $nativeOutput "-p:IntermediateOutputPath=$nativeIntermediate" -p:DebugType=None -p:DebugSymbols=false
if ($LASTEXITCODE -ne 0) { throw "原生宿主编译失败" }

if (-not (Test-Path -LiteralPath $nodeArchive)) {
    Invoke-WebRequest -UseBasicParsing -Uri $nodeUrl -OutFile $nodeArchive
}
if (-not (Test-Path -LiteralPath $nodeChecksums)) {
    Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$nodeVersion/SHASUMS256.txt" -OutFile $nodeChecksums
}
$checksumLine = Get-Content -LiteralPath $nodeChecksums | Where-Object { $_ -match [regex]::Escape($nodeArchiveName) + '$' } | Select-Object -First 1
if (-not $checksumLine) { throw "未找到 Node.js 官方校验值" }
$expectedHash = ($checksumLine -split '\s+')[0].ToLowerInvariant()
if ($expectedHash -ne $nodeArchiveSha256) { throw "Node.js 官方校验清单与固定版本不一致" }
$actualHash = (Get-Sha256Hash $nodeArchive).ToLowerInvariant()
if ($actualHash -ne $nodeArchiveSha256) { throw "Node.js 下载包 SHA-256 校验失败" }

if (-not (Test-Path -LiteralPath $webViewBootstrapper)) {
    Invoke-WebRequest -UseBasicParsing -Uri $webViewUrl -OutFile $webViewBootstrapper
}
if (-not (Test-Path -LiteralPath $whisperArchive)) {
    Download-PinnedFile $whisperUrl $whisperArchive
}
if ((Get-Sha256Hash $whisperArchive).ToLowerInvariant() -ne $whisperSha256) {
    throw "whisper.cpp 下载包 SHA-256 校验失败"
}
if (-not (Test-Path -LiteralPath $whisperModel)) {
    $installedModel = Join-Path $env:APPDATA "OliviaSoul\models\whisper\ggml-small.bin"
    if ((Test-Path -LiteralPath $installedModel) -and
        (Get-Sha256Hash $installedModel).ToLowerInvariant() -eq $whisperModelSha256) {
        Copy-Item -LiteralPath $installedModel -Destination $whisperModel
    }
    else {
        foreach ($url in $whisperModelUrls) {
            try {
                Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $whisperModel
                break
            }
            catch {
                Remove-Item -LiteralPath $whisperModel -Force -ErrorAction SilentlyContinue
            }
        }
    }
}
if (-not (Test-Path -LiteralPath $whisperModel) -or
    (Get-Sha256Hash $whisperModel).ToLowerInvariant() -ne $whisperModelSha256) {
    throw "Whisper 模型 SHA-256 校验失败"
}
if (-not (Test-Path -LiteralPath $ffmpegArchive)) {
    Download-PinnedFile $ffmpegUrl $ffmpegArchive
}
$ffmpegActualHash = (Get-Sha256Hash $ffmpegArchive).ToLowerInvariant()
if ($ffmpegActualHash -ne $ffmpegSha256) { throw "FFmpeg 下载包 SHA-256 校验失败" }

Ensure-Directory $stage
Copy-WebViewNotices -ProjectFile $nativeProjectPath -NugetRoot $env:NUGET_PACKAGES -Stage $stage

Get-ChildItem -LiteralPath $nativeOutput -File | Where-Object {
    $_.Extension -in @(".exe", ".dll", ".config")
} | Copy-Item -Destination $stage -Force
Copy-Item -LiteralPath (Join-Path $nativeOutput "runtimes") -Destination (Join-Path $stage "runtimes") -Recurse -Force
Copy-PublicFile (Join-Path $PSScriptRoot "app.ico") (Join-Path $stage "app.ico")
Copy-PublicFile (Join-Path $PSScriptRoot "app.ico") (Join-Path $stage "app-v9.ico")
Copy-PublicFile $webViewBootstrapper (Join-Path $stage "redist\MicrosoftEdgeWebview2Setup.exe")

$nodePrefix = "node-v$nodeVersion-win-x64"
Copy-ZipEntry -Archive $nodeArchive -EntryName "$nodePrefix/node.exe" -Destination (Join-Path $stage "runtime\node.exe")
Copy-ZipEntry -Archive $nodeArchive -EntryName "$nodePrefix/LICENSE" -Destination (Join-Path $stage "runtime\NODE-LICENSE.txt")
if ((Get-Sha256Hash (Join-Path $stage "runtime\node.exe")).ToLowerInvariant() -ne $nodeExeSha256) {
    throw "Node.js 运行时 SHA-256 校验失败"
}

$whisperExtract = Join-Path $WorkDirectory "extract-whisper"
Expand-Archive -LiteralPath $whisperArchive -DestinationPath $whisperExtract -Force
$whisperCli = Get-ChildItem -LiteralPath $whisperExtract -Filter "whisper-cli.exe" -File -Recurse | Select-Object -First 1
if (-not $whisperCli) { throw "whisper.cpp 下载包结构不正确" }
$whisperRuntime = Split-Path $whisperCli.FullName -Parent
Ensure-Directory (Join-Path $stage "runtime\whisper")
Copy-Item -Path (Join-Path $whisperRuntime "*") -Destination (Join-Path $stage "runtime\whisper") -Recurse -Force
Copy-PublicFile (Join-Path $project "packaging\WHISPER-CPP-LICENSE.txt") (Join-Path $stage "runtime\whisper\LICENSE.txt")
Copy-PublicFile $whisperModel (Join-Path $stage "runtime\whisper\ggml-small.bin")
$whisperTalkLlama = Join-Path $stage "runtime\whisper\whisper-talk-llama.exe"
if (-not (Test-Path -LiteralPath $whisperTalkLlama -PathType Leaf) -or
    (Get-Sha256Hash $whisperTalkLlama).ToLowerInvariant() -ne $whisperTalkLlamaExeSha256) {
    throw "whisper.cpp 运行时 SHA-256 校验失败"
}

$ffmpegExtract = Join-Path $WorkDirectory "extract-ffmpeg"
Expand-Archive -LiteralPath $ffmpegArchive -DestinationPath $ffmpegExtract -Force
$ffmpegRoot = Get-ChildItem -LiteralPath $ffmpegExtract -Directory | Select-Object -First 1
if (-not $ffmpegRoot) { throw "FFmpeg 下载包结构不正确" }
Copy-PublicFile (Join-Path $ffmpegRoot.FullName "bin\ffmpeg.exe") (Join-Path $stage "runtime\ffmpeg\bin\ffmpeg.exe")
Copy-PublicFile (Join-Path $ffmpegRoot.FullName "bin\ffprobe.exe") (Join-Path $stage "runtime\ffmpeg\bin\ffprobe.exe")
Copy-PublicFile (Join-Path $ffmpegRoot.FullName "LICENSE.txt") (Join-Path $stage "runtime\ffmpeg\LICENSE.txt")

foreach ($name in @(
    "server.js", "transcription.js", "remote-memory.js", "soul-bundle.js", "model-config.js",
    "data-migration.js", "storage-paths.js", "storage-migration.js"
)) {
    Copy-PublicFile (Join-Path $project $name) (Join-Path $stage "app\$name")
}
Copy-PublicFile (Join-Path $project "package.json") (Join-Path $stage "app\package.json")
$nodeModules = Join-Path $project "node_modules"
if (Test-Path -LiteralPath $nodeModules) {
    Copy-Item -LiteralPath $nodeModules -Destination (Join-Path $stage "app\node_modules") -Recurse -Force
}
Copy-Item -LiteralPath (Join-Path $project "public") -Destination (Join-Path $stage "app\public") -Recurse -Force
Ensure-Directory (Join-Path $stage "app\midi")
foreach ($name in @(
    "store.js", "routes.js", "song-metadata.js", "song-preview-source.js", "song-name-corrections.js",
    "playback-clock.js", "library-importer.js", "library-watch.js", "media-probe.js", "duration-repair.js",
    "process-runner.js", "catalog-manifest.js", "catalog-relink.js"
)) {
    Copy-Item -LiteralPath (Join-Path (Join-Path $project "midi") $name) -Destination (Join-Path $stage "app\midi") -Force
}
foreach ($name in @(
    "controller.js",
    "node-host.js",
    "workspace-template.js",
    "client-backups.js",
    "client-execution.js",
    "client-patch-registry.js",
    "uninstall-restore.js",
    "startup-task.ps1"
)) {
    Copy-PublicFile (Join-Path $project "desktop\$name") (Join-Path $stage "app\desktop\$name")
}

# Official finished MP4 files are validated with the packaged FFmpeg tools.
# The release intentionally excludes Godot, FluidSynth, SoundFont and MIDI rendering bootstrap files.

$scriptTarget = Join-Path $stage "resources\workspace-template\.cursor\skills\fit-letters\scripts"
foreach ($name in @("deepseek-reply.ps1", "harness-live.ps1", "harness-4step.ps1", "history-retrieval.ps1", "refresh-live-memory.ps1", "memory-lib.ps1", "ds-call.ps1", "model-call.ps1", "score-temp.ps1", "sqlite-memory-load.cjs")) {
    Copy-PublicFile (Join-Path $repository ".cursor\skills\fit-letters\scripts\$name") (Join-Path $scriptTarget $name)
}
Copy-PublicFile (Join-Path $repository "林离人设.md") (Join-Path $stage "resources\workspace-template\林离人设.md")
foreach ($name in @("VERSION", "00-栏目.md", "01-预检.md", "01-初始化账本.md", "02-历史检索.md", "02-账本校正.md", "03-中段生成.md", "04-尾端检查.md", "05-反馈重写.md", "开信.md", "写法.md")) {
    Copy-PublicFile (Join-Path $repository "harness\$name") (Join-Path $stage "resources\workspace-template\harness\$name")
}
foreach ($name in @("patch-feapp-local.ps1", "patch-feapp-locale-local.ps1", "upgrade-feapp-v14-v16.ps1", "upgrade-feapp-v16-v17.ps1", "upgrade-feapp-v22-v23.ps1", "restore-feapp-original.ps1", "get-feapp-status.ps1", "patch-webplayer-local.ps1", "upgrade-webplayer-v6-v7.ps1", "restore-webplayer-original.ps1", "get-webplayer-status.ps1", "process-control.ps1")) {
    Copy-PublicFile (Join-Path $repository "tools\$name") (Join-Path $stage "resources\workspace-template\tools\$name")
}
Copy-PublicFile (Join-Path $project "public\song-editor.js") (Join-Path $stage "resources\workspace-template\tools\song-editor.js")

Assert-EmptyPackageDirectory -Path $OutputDirectory -ProtectedRoots @($project, $repository)
$steamSource = Join-Path $repository "tools\steam-launcher"
$steamOutput = Join-Path $WorkDirectory "steam-waiter-output"
# Compile only; never configure Steam or execute either application during packaging.
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $steamSource "build.ps1") -OutputDirectory $steamOutput
if ($LASTEXITCODE -ne 0) { throw "Steam waiter compilation failed" }
Copy-SteamLauncherPayload -Source $steamSource -Compiled $steamOutput -Destination (Join-Path $stage "resources\workspace-template\tools\steam-launcher")
Copy-ReviewGuides -Source $PSScriptRoot -Stage $stage

# Freeze the complete audited stage. Portable and Setup are both produced only from this snapshot.
$frozenStage = Join-Path $WorkDirectory "frozen-stage"
$frozenReceipt = New-AuditedPackageSnapshot `
    -SourceStage $stage `
    -SnapshotStage $frozenStage `
    -ForbiddenValues $forbiddenPackageValues `
    -TrustedFiles $trustedStageFiles
$frozenStageFingerprint = $frozenReceipt.Fingerprint
$portableCandidate = Join-Path $WorkDirectory "OliviaSoul-$version-Portable.candidate.zip"
$auditedArtifactDirectory = Join-Path $WorkDirectory "audited-artifacts"
$auditedPortable = Join-Path $auditedArtifactDirectory "OliviaSoul-$version-Portable.zip"
$portableReceipt = Publish-AuditedPackageArchive `
    -Stage $frozenStage `
    -CandidateArchive $portableCandidate `
    -DestinationArchive $auditedPortable `
    -ForbiddenValues $forbiddenPackageValues `
    -TrustedFiles $trustedStageFiles `
    -ExpectedStageFingerprint $frozenStageFingerprint

if ([string]::IsNullOrWhiteSpace($Iscc)) {
    $candidates = @(@(
        $env:ISCC_PATH,
        (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6\ISCC.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe")
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and (Test-Path -LiteralPath $_) })
    if ($candidates.Count -lt 1) { throw "缺少 Inno Setup 6。安装后重新运行 npm run build:win。" }
    $Iscc = $candidates[0]
}

$installerSource = Join-Path $PSScriptRoot "OliviaSoul.iss"
$installerSourceHash = Assert-PublicPackageFile -Path $installerSource -RelativePath "packaging/OliviaSoul.iss" -ForbiddenValues $forbiddenPackageValues
$installerSnapshot = Join-Path $WorkDirectory "installer-source\OliviaSoul.iss"
Copy-VerifiedPackageFile -Source $installerSource -Destination $installerSnapshot -ExpectedSha256 $installerSourceHash
$installerOutputDirectory = Join-Path $WorkDirectory "installer-output"
Ensure-Directory $installerOutputDirectory
$env:OLIVIA_SOUL_VERSION = $version
$env:OLIVIA_SOUL_STAGE = $frozenStage
$env:OLIVIA_SOUL_OUTPUT = $installerOutputDirectory
$installerCompileScript = Join-Path $WorkDirectory "installer-source\OliviaSoul.compile.iss"
$installerCompileReceipt = New-AuditedInstallerCompileScript `
    -TemplateScript $installerSnapshot `
    -OutputScript $installerCompileScript `
    -Stage $frozenStage `
    -ForbiddenValues $forbiddenPackageValues `
    -TrustedFiles $trustedStageFiles `
    -ExpectedStageFingerprint $frozenStageFingerprint
Assert-AuditedInstallerSource `
    -InstallerScript $installerCompileScript `
    -Stage $frozenStage `
    -ForbiddenValues $forbiddenPackageValues `
    -TrustedFiles $trustedStageFiles `
    -ExpectedStageFingerprint $frozenStageFingerprint `
    -RequireEnvironmentBinding `
    -RequireExplicitSources
Invoke-AuditedInstallerCompiler `
    -InstallerScript $installerCompileScript `
    -Stage $frozenStage `
    -ForbiddenValues $forbiddenPackageValues `
    -TrustedFiles $trustedStageFiles `
    -ExpectedStageFingerprint $frozenStageFingerprint `
    -RequireEnvironmentBinding `
    -RequireExplicitSources `
    -Compiler {
        param($auditedInstallerScript)
        & $Iscc $auditedInstallerScript
        if ($LASTEXITCODE -ne 0) { throw "Inno Setup 打包失败" }
    }
Assert-AuditedInstallerSource `
    -InstallerScript $installerCompileScript `
    -Stage $frozenStage `
    -ForbiddenValues $forbiddenPackageValues `
    -TrustedFiles $trustedStageFiles `
    -ExpectedStageFingerprint $frozenStageFingerprint `
    -RequireEnvironmentBinding `
    -RequireExplicitSources
$setupCandidate = Join-Path $installerOutputDirectory "OliviaSoul-$version-Setup.exe"
$setupHash = Assert-PublicPackageFile -Path $setupCandidate -RelativePath "OliviaSoul-$version-Setup.exe" -ForbiddenValues $forbiddenPackageValues

$releaseCandidateDirectory = Join-Path $WorkDirectory "release-candidate"
Ensure-Directory $releaseCandidateDirectory
Copy-VerifiedPackageFile -Source $auditedPortable -Destination (Join-Path $releaseCandidateDirectory "OliviaSoul-$version-Portable.zip") -ExpectedSha256 $portableReceipt.ArchiveSha256
Copy-VerifiedPackageFile -Source $setupCandidate -Destination (Join-Path $releaseCandidateDirectory "OliviaSoul-$version-Setup.exe") -ExpectedSha256 $setupHash
foreach ($name in @("使用说明.txt", "发布说明.md", "反馈指南.md")) {
    $guideManifestValue = [string]$frozenReceipt.Manifest[$name]
    if ([string]::IsNullOrWhiteSpace($guideManifestValue)) { throw "冻结发布说明缺失：$name" }
    $guideHash = $guideManifestValue.Split(':', 2)[1]
    Copy-VerifiedPackageFile -Source (Join-Path $frozenStage $name) -Destination (Join-Path $releaseCandidateDirectory $name) -ExpectedSha256 $guideHash
}
$releaseTrustedFiles = @{
    "OliviaSoul-$version-Portable.zip" = $portableReceipt.ArchiveSha256
    "OliviaSoul-$version-Setup.exe" = $setupHash
}
Write-ReleaseChecksums $releaseCandidateDirectory
$releaseManifest = Get-PublicPackageTreeManifest -Path $releaseCandidateDirectory -ForbiddenValues $forbiddenPackageValues -TrustedFiles $releaseTrustedFiles
$releaseFingerprint = Get-PackageManifestFingerprint $releaseManifest
Publish-VerifiedReleaseDirectory `
    -CandidateDirectory $releaseCandidateDirectory `
    -OutputDirectory $OutputDirectory `
    -ExpectedFingerprint $releaseFingerprint `
    -ForbiddenValues $forbiddenPackageValues `
    -TrustedFiles $releaseTrustedFiles
Write-Output "Olivia Soul release: $OutputDirectory"
