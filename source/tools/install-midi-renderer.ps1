param(
    [string]$InstallRoot = "",
    [string]$ManifestPath = (Join-Path $PSScriptRoot "..\midi-renderer\runtime-manifest.json"),
    [switch]$VerifyOnly,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $scriptDrive = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($PSScriptRoot))
    if ([string]::IsNullOrWhiteSpace($scriptDrive)) { throw "Unable to determine the script drive." }
    $InstallRoot = Join-Path $scriptDrive "OliviaSoulData\MidiRenderer"
}
$root = [IO.Path]::GetFullPath($InstallRoot)
$drive = [IO.Path]::GetPathRoot($root).TrimEnd("\")
if (-not [IO.Path]::IsPathRooted($root)) { throw "InstallRoot must be an absolute path" }
if (-not (Test-Path -LiteralPath $ManifestPath)) { throw "runtime manifest not found: $ManifestPath" }

$manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1) { throw "unsupported runtime manifest schema: $($manifest.schemaVersion)" }
$rootPrefix = $root.TrimEnd("\") + "\"

function Join-ManagedPath([string]$RelativePath) {
    $candidate = [IO.Path]::GetFullPath((Join-Path $root $RelativePath))
    if (-not $candidate.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "manifest path escapes InstallRoot: $RelativePath"
    }
    return $candidate
}

function Get-Sha256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Test-Receipt([object]$Package, [string]$Target) {
    if ($Package.archive -eq "none") {
        return (Test-Path -LiteralPath $Target -PathType Leaf) -and ((Get-Sha256 $Target) -eq $Package.sha256)
    }
    $exe = Join-Path $Target $Package.executablePath
    $receiptPath = Join-Path $Target ".install-receipt.json"
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf) -or -not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) {
        return $false
    }
    try {
        $receipt = Get-Content -LiteralPath $receiptPath -Raw -Encoding UTF8 | ConvertFrom-Json
        return $receipt.id -eq $Package.id -and $receipt.archiveSha256 -eq $Package.sha256
    }
    catch { return $false }
}

function Get-ValidatedDownload([object]$Package, [string]$DownloadRoot) {
    $cachePath = Join-Path $DownloadRoot $Package.filename
    if ((Test-Path -LiteralPath $cachePath -PathType Leaf) -and ((Get-Sha256 $cachePath) -eq $Package.sha256)) {
        return $cachePath
    }
    $downloadPath = "$cachePath.download-$([guid]::NewGuid().ToString('N'))"
    Write-Host "Downloading $($Package.id) $($Package.version) to $downloadPath"
    Invoke-WebRequest -UseBasicParsing -Uri $Package.url -OutFile $downloadPath
    $actual = Get-Sha256 $downloadPath
    if ($actual -ne $Package.sha256) {
        Remove-Item -LiteralPath $downloadPath -Force
        throw "SHA-256 mismatch for $($Package.id): expected $($Package.sha256), got $actual"
    }
    if (Test-Path -LiteralPath $cachePath) { Remove-Item -LiteralPath $cachePath -Force }
    Move-Item -LiteralPath $downloadPath -Destination $cachePath
    return $cachePath
}

function Move-Atomic([string]$Stage, [string]$Target) {
    $parent = [IO.Path]::GetDirectoryName($Target)
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $previous = "$Target.previous-$([guid]::NewGuid().ToString('N'))"
    if (Test-Path -LiteralPath $Target) { Move-Item -LiteralPath $Target -Destination $previous }
    try {
        Move-Item -LiteralPath $Stage -Destination $Target
        if (Test-Path -LiteralPath $previous) { Remove-Item -LiteralPath $previous -Recurse -Force }
    }
    catch {
        if ((-not (Test-Path -LiteralPath $Target)) -and (Test-Path -LiteralPath $previous)) {
            Move-Item -LiteralPath $previous -Destination $Target
        }
        throw
    }
}

function Install-ArchivePackage([object]$Package, [string]$ArchivePath, [string]$InstallTarget, [string]$WorkRoot) {
    $extractRoot = Join-Path $WorkRoot ("extract-" + $Package.id)
    $stageTarget = "$InstallTarget.install-$([guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $extractRoot,$stageTarget -Force | Out-Null
    Expand-Archive -LiteralPath $ArchivePath -DestinationPath $extractRoot -Force
    $payloadRoot = $extractRoot
    if ($Package.stripSingleDirectory) {
        $children = @(Get-ChildItem -LiteralPath $extractRoot -Force)
        if ($children.Count -eq 1 -and $children[0].PSIsContainer) { $payloadRoot = $children[0].FullName }
    }
    Copy-Item -Path (Join-Path $payloadRoot "*") -Destination $stageTarget -Recurse -Force

    $expectedExe = Join-Path $stageTarget $Package.executablePath
    if (-not (Test-Path -LiteralPath $expectedExe -PathType Leaf)) {
        $sourceExe = @(Get-ChildItem -LiteralPath $stageTarget -File -Recurse -Filter $Package.sourceExecutable)
        if ($sourceExe.Count -ne 1) { throw "expected one $($Package.sourceExecutable) for $($Package.id), got $($sourceExe.Count)" }
        $expectedDir = [IO.Path]::GetDirectoryName($expectedExe)
        New-Item -ItemType Directory -Path $expectedDir -Force | Out-Null
        if ($Package.sourceExecutable -ieq [IO.Path]::GetFileName($Package.executablePath)) {
            Copy-Item -Path (Join-Path $sourceExe[0].Directory.FullName "*") -Destination $expectedDir -Recurse -Force
        }
        else {
            Copy-Item -LiteralPath $sourceExe[0].FullName -Destination $expectedExe -Force
        }
    }
    $additionalExecutables = @()
    if ($null -ne $Package.additionalExecutables) {
        $additionalExecutables = @($Package.additionalExecutables | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    }
    foreach ($additional in $additionalExecutables) {
        $additionalTarget = Join-Path ([IO.Path]::GetDirectoryName($expectedExe)) $additional
        if (-not (Test-Path -LiteralPath $additionalTarget -PathType Leaf)) {
            $found = @(Get-ChildItem -LiteralPath $stageTarget -File -Recurse -Filter $additional)
            if ($found.Count -ne 1) { throw "expected one $additional for $($Package.id), got $($found.Count)" }
            Copy-Item -LiteralPath $found[0].FullName -Destination $additionalTarget -Force
        }
    }
    if (-not (Test-Path -LiteralPath $expectedExe -PathType Leaf)) { throw "installed executable missing: $expectedExe" }
    [ordered]@{
        id = $Package.id
        version = $Package.version
        archiveSha256 = $Package.sha256
        installedAt = [DateTimeOffset]::UtcNow.ToString("o")
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stageTarget ".install-receipt.json") -Encoding UTF8
    Move-Atomic $stageTarget $InstallTarget
}

function Test-Executable([object]$Package, [string]$InstallTarget) {
    if ($Package.archive -eq "none") { return }
    $exe = Join-Path $InstallTarget $Package.executablePath
    $verifyId = [guid]::NewGuid().ToString("N")
    $stdoutPath = Join-ManagedPath ("temp\verify-" + $verifyId + ".out")
    $stderrPath = Join-ManagedPath ("temp\verify-" + $verifyId + ".err")
    try {
        $process = Start-Process -FilePath $exe -ArgumentList @($Package.verifyArguments) -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
        if ($process.ExitCode -ne 0) { throw "$($Package.id) verification failed with exit code $($process.ExitCode)" }
        $output = @()
        if (Test-Path -LiteralPath $stdoutPath) { $output += @(Get-Content -LiteralPath $stdoutPath -ErrorAction SilentlyContinue) }
        if (Test-Path -LiteralPath $stderrPath) { $output += @(Get-Content -LiteralPath $stderrPath -ErrorAction SilentlyContinue) }
        $firstLine = @($output | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })[0]
        Write-Host ("verified {0}: {1}" -f $Package.id, $firstLine)
    }
    finally {
        if (Test-Path -LiteralPath $stdoutPath) { Remove-Item -LiteralPath $stdoutPath -Force }
        if (Test-Path -LiteralPath $stderrPath) { Remove-Item -LiteralPath $stderrPath -Force }
    }
}

$downloadRoot = Join-ManagedPath "downloads"
$workRoot = Join-ManagedPath ("temp\install-" + [guid]::NewGuid().ToString("N"))
$rendererSource = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\midi-renderer\godot"))
$rendererTarget = Join-ManagedPath "renderer\godot"

if ($VerifyOnly) {
    foreach ($package in $manifest.packages) {
        $target = Join-ManagedPath $package.installPath
        if (-not (Test-Receipt $package $target)) { throw "runtime verification failed: $($package.id)" }
        Test-Executable $package $target
    }
    if (-not (Test-Path -LiteralPath (Join-Path $rendererTarget "project.godot") -PathType Leaf)) {
        throw "Godot renderer project is not installed: $rendererTarget"
    }
    [ordered]@{ verified = $true; installRoot = $root; packages = @($manifest.packages.id) } | ConvertTo-Json -Compress
    exit 0
}

New-Item -ItemType Directory -Path $root,$downloadRoot,$workRoot -Force | Out-Null
foreach ($relative in @("inputs", "jobs", "outputs", "temp", "soundfonts", "runtime", "renderer")) {
    New-Item -ItemType Directory -Path (Join-ManagedPath $relative) -Force | Out-Null
}

try {
    foreach ($package in $manifest.packages) {
        $target = Join-ManagedPath $package.installPath
        $targetParent = [IO.Path]::GetDirectoryName($target)
        $stalePattern = [IO.Path]::GetFileName($target) + ".install-*"
        if (Test-Path -LiteralPath $targetParent) {
            Get-ChildItem -LiteralPath $targetParent -Force -Filter $stalePattern | Remove-Item -Recurse -Force
        }
        if (-not $Force -and (Test-Receipt $package $target)) {
            Write-Host "Using verified $($package.id) $($package.version)"
            Test-Executable $package $target
            continue
        }
        $download = Get-ValidatedDownload $package $downloadRoot
        if ($package.archive -eq "none") {
            $stageFile = "$target.install-$([guid]::NewGuid().ToString('N'))"
            New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($target)) -Force | Out-Null
            Copy-Item -LiteralPath $download -Destination $stageFile -Force
            if ((Get-Sha256 $stageFile) -ne $package.sha256) { throw "installed hash mismatch for $($package.id)" }
            Move-Atomic $stageFile $target
        }
        elseif ($package.archive -eq "zip") {
            Install-ArchivePackage $package $download $target $workRoot
        }
        else { throw "unsupported archive type: $($package.archive)" }
        if (-not (Test-Receipt $package $target)) { throw "post-install verification failed: $($package.id)" }
        Test-Executable $package $target
    }

    if (-not (Test-Path -LiteralPath (Join-Path $rendererSource "project.godot") -PathType Leaf)) {
        throw "renderer source not found: $rendererSource"
    }
    $rendererStage = "$rendererTarget.install-$([guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $rendererStage -Force | Out-Null
    Copy-Item -Path (Join-Path $rendererSource "*") -Destination $rendererStage -Recurse -Force
    Move-Atomic $rendererStage $rendererTarget
}
finally {
    if (Test-Path -LiteralPath $workRoot) { Remove-Item -LiteralPath $workRoot -Recurse -Force }
}

[ordered]@{ installed = $true; installRoot = $root; packages = @($manifest.packages.id) } | ConvertTo-Json -Compress
