function Assert-EmptyPackageDirectory {
    param([Parameter(Mandatory = $true)][string]$Path, [string[]]$ProtectedRoots = @())
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    $root = [IO.Path]::GetPathRoot($full).TrimEnd('\', '/')
    if ($full -eq $root) { throw "Package directory cannot be a filesystem root: $Path" }
    foreach ($protected in $ProtectedRoots) {
        $protectedFull = [IO.Path]::GetFullPath($protected).TrimEnd('\', '/')
        if ($full -eq $protectedFull -or $protectedFull.StartsWith($full + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw "Package directory cannot contain a protected source directory: $Path"
        }
    }
    $ancestor = $full
    while ($ancestor) {
        if (Test-Path -LiteralPath $ancestor) {
            $item = Get-Item -LiteralPath $ancestor -Force
            if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                throw "Package directory must not use files or reparse points: $ancestor"
            }
        }
        $ancestor = Split-Path $ancestor -Parent
    }
    if ((Test-Path -LiteralPath $full) -and @(Get-ChildItem -LiteralPath $full -Force).Count -gt 0) {
        throw "Package directory is not empty; choose a fresh directory: $full"
    }
}

function ConvertTo-PackageRelativePath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return $Path.TrimStart('\', '/').Replace('\', '/')
}

function Get-PackageForbiddenNeedles {
    param([string[]]$ForbiddenValues = @())

    $values = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($candidate in @($ForbiddenValues)) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        $value = [string]$candidate
        foreach ($variant in @(
            $value,
            $value.Replace('\', '/'),
            $value.Replace('/', '\'),
            $value.Replace('\', '\\')
        )) {
            if (-not [string]::IsNullOrWhiteSpace($variant)) { $null = $values.Add($variant) }
        }
    }
    return @($values)
}

function Get-PackageTreeFiles {
    param([Parameter(Mandatory = $true)][string]$Root)

    $pending = New-Object 'Collections.Generic.Stack[string]'
    $pending.Push($Root)
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        foreach ($item in Get-ChildItem -LiteralPath $directory -Force | Sort-Object FullName) {
            $relative = ConvertTo-PackageRelativePath $item.FullName.Substring($Root.Length)
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "[PRIVACY_RUNTIME_STATE] Package tree contains a reparse point: $relative"
            }
            if ($item.PSIsContainer) { $pending.Push($item.FullName) }
            else { Write-Output $item }
        }
    }
}

function Test-PackageCredentialPlaceholder {
    param([AllowNull()][string]$Value)

    if ($null -eq $Value) { return $true }
    $candidate = $Value.Trim().Trim('"', "'")
    if ([string]::IsNullOrWhiteSpace($candidate)) { return $true }
    if ($candidate -match '^\$(?:env:)?[A-Za-z_][A-Za-z0-9_]*$' -or
        $candidate -match '^\$\{(?:env:)?[A-Za-z_][A-Za-z0-9_]*\}$' -or
        $candidate -match '^%[A-Za-z_][A-Za-z0-9_]*%$') { return $true }
    if ($candidate -match '^<\s*(?:API[_ -]?KEY|TOKEN|SECRET|VALUE)\s*>$') { return $true }
    if ($candidate -match '^(?:YOUR[_ -]?(?:API[_ -]?KEY|KEY|TOKEN|SECRET)(?:[_ -]?HERE)?|PLACEHOLDER|EXAMPLE|CHANGEME)$') { return $true }
    return $false
}

function Assert-PackageTextContent {
    param(
        [Parameter(Mandatory = $true)][string]$Text,
        [Parameter(Mandatory = $true)][string]$RelativePath,
        [string[]]$ForbiddenNeedles = @()
    )

    foreach ($needle in @($ForbiddenNeedles)) {
        if ($Text.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            throw "[PRIVACY_CONTENT] Package privacy check rejected private content: $RelativePath"
        }
    }

    # Every generic rule below necessarily contains at least one of these
    # anchors. Most bytes in compressed executables contain none of them, so
    # avoid running all regular expressions for those windows while keeping
    # the explicit forbidden-value scan above unconditional.
    $privacyPatternAnchors = @(
        'Users',
        '/home/',
        'http://',
        'https://',
        'sk-',
        'api',
        'token',
        'secret'
    )
    $hasPrivacyPatternAnchor = $false
    foreach ($anchor in $privacyPatternAnchors) {
        if ($Text.IndexOf($anchor, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            $hasPrivacyPatternAnchor = $true
            break
        }
    }
    if (-not $hasPrivacyPatternAnchor) { return }

    foreach ($match in [regex]::Matches($Text, '(?i)(?:[A-Z]:[\\/]|\\\\[^\\/\r\n]+[\\/])Users[\\/](?<user>[^\\/\r\n]+)[\\/]')) {
        if ($match.Groups['user'].Value -ine 'YOUR_NAME') {
            throw "[PRIVACY_CONTENT] Package privacy check rejected private content: $RelativePath"
        }
    }
    foreach ($match in [regex]::Matches($Text, '(?i)(?:^|[\s"''=])/(?:Users|home)/(?<user>[^/\s"''<>]+)/')) {
        if ($match.Groups['user'].Value -ine 'YOUR_NAME') {
            throw "[PRIVACY_CONTENT] Package privacy check rejected private content: $RelativePath"
        }
    }

    foreach ($pattern in @(
        '(?i)https?://(?:10\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.|100\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.)',
        '(?i)https?://[A-Za-z0-9.-]+\.ts\.net(?:[:/]|$)',
        '(?i)https?://\[(?:f[cd][0-9a-f]{0,2}|fe[89ab][0-9a-f]):[0-9a-f:.%]+\]',
        '(?i)\bsk-[A-Za-z0-9_-]{16,}\b'
    )) {
        if ([regex]::IsMatch($Text, $pattern)) {
            throw "[PRIVACY_CONTENT] Package privacy check rejected private content: $RelativePath"
        }
    }

    $jsonCredentials = [regex]::Matches(
        $Text,
        '(?i)(?<![A-Za-z0-9_$])["'']?(?:api[_-]?key|token|secret)["'']?\s*:\s*["'']([^"''\r\n]*)["'']'
    )
    foreach ($match in $jsonCredentials) {
        if (-not (Test-PackageCredentialPlaceholder $match.Groups[1].Value)) {
            throw "[PRIVACY_CONTENT] Package privacy check rejected private content: $RelativePath"
        }
    }

    $literalAssignmentCredentials = [regex]::Matches(
        $Text,
        '(?im)^[ \t]*(?:(?:const|let|var)[ \t]+)?\$?[A-Z0-9_$]*(?:api[_-]?key|token|secret)[A-Z0-9_$]*[ \t]*=[ \t]*["'']([^"''\r\n]*)["'']'
    )
    foreach ($match in $literalAssignmentCredentials) {
        if (-not (Test-PackageCredentialPlaceholder $match.Groups[1].Value)) {
            throw "[PRIVACY_CONTENT] Package privacy check rejected private content: $RelativePath"
        }
    }

    # Environment variable names are conventionally uppercase. Keep this
    # case-sensitive so ordinary code parameters such as
    # `randomToken = randomUUID` are not treated as embedded credentials.
    $environmentCredentials = [regex]::Matches(
        $Text,
        '(?m)^[ \t]*(?:[A-Z0-9_]*(?:API_?KEY|TOKEN|SECRET)[A-Z0-9_]*)[ \t]*=[ \t]*([^\r\n#]*)'
    )
    foreach ($match in $environmentCredentials) {
        if (-not (Test-PackageCredentialPlaceholder $match.Groups[1].Value)) {
            throw "[PRIVACY_CONTENT] Package privacy check rejected private content: $RelativePath"
        }
    }
}

function Get-PackageStreamHash {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][IO.Stream]$Stream,
        [Parameter(Mandatory = $true)][string]$RelativePath,
        [string[]]$ForbiddenNeedles = @(),
        [bool]$SkipContent = $false
    )

    $sha256 = [Security.Cryptography.SHA256]::Create()
    $buffer = New-Object byte[] (1024 * 1024)
    [byte[]]$carry = @()
    $carryLimit = 65536
    try {
        while (($read = $Stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $null = $sha256.TransformBlock($buffer, 0, $read, $buffer, 0)
            if ($SkipContent) { continue }

            $combined = New-Object byte[] ($carry.Length + $read)
            if ($carry.Length -gt 0) { [Array]::Copy($carry, 0, $combined, 0, $carry.Length) }
            [Array]::Copy($buffer, 0, $combined, $carry.Length, $read)

            foreach ($encoding in @(
                [Text.Encoding]::GetEncoding(28591),
                [Text.Encoding]::UTF8,
                [Text.Encoding]::Unicode,
                [Text.Encoding]::BigEndianUnicode
            )) {
                Assert-PackageTextContent -Text $encoding.GetString($combined) -RelativePath $RelativePath -ForbiddenNeedles $ForbiddenNeedles
            }
            if ($combined.Length -gt 1) {
                Assert-PackageTextContent -Text ([Text.Encoding]::Unicode.GetString($combined, 1, $combined.Length - 1)) -RelativePath $RelativePath -ForbiddenNeedles $ForbiddenNeedles
                Assert-PackageTextContent -Text ([Text.Encoding]::BigEndianUnicode.GetString($combined, 1, $combined.Length - 1)) -RelativePath $RelativePath -ForbiddenNeedles $ForbiddenNeedles
            }

            $carryCount = [Math]::Min($carryLimit, $combined.Length)
            $carry = New-Object byte[] $carryCount
            if ($carryCount -gt 0) {
                [Array]::Copy($combined, $combined.Length - $carryCount, $carry, 0, $carryCount)
            }
        }
        [byte[]]$empty = @()
        $null = $sha256.TransformFinalBlock($empty, 0, 0)
        return ([BitConverter]::ToString($sha256.Hash)).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $sha256.Dispose()
    }
}

function Assert-PackageRelativePath {
    param([Parameter(Mandatory = $true)][string]$RelativePath)

    $relative = ConvertTo-PackageRelativePath $RelativePath
    $segments = @($relative -split '/')
    $fileName = [IO.Path]::GetFileName($relative)
    $extension = [IO.Path]::GetExtension($relative)
    $runtimeStateNames = @(
        'desktop-settings.json',
        'olivia-local.sqlite',
        'olivia-local.sqlite-shm',
        'olivia-local.sqlite-wal',
        'song-name-corrections.json'
    )
    if ($segments -contains 'UserData' -or
        $relative -match '(?i)(^|/)\.cursor/secrets(/|$)' -or
        $runtimeStateNames -contains $fileName -or
        $extension -in @('.sqlite', '.db', '.log')) {
        throw "[PRIVACY_RUNTIME_STATE] Package privacy check rejected runtime state: $relative"
    }
}

function Assert-PackageModelDefaults {
    param(
        [Parameter(Mandatory = $true)][string]$RelativePath,
        [Parameter(Mandatory = $true)][string]$Text
    )

    $relative = ConvertTo-PackageRelativePath $RelativePath
    if ([IO.Path]::GetFileName($relative) -ieq 'model-call.ps1') {
        $allowedModels = @('local-model', 'deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-pro')
        $literalDefaults = @{}
        foreach ($name in @('Model', 'Base', 'Auth', 'ApiKey')) {
            $all = [regex]::Matches($Text, '(?im)\$default' + $name + '\s*=')
            $literal = [regex]::Matches($Text, '(?im)\$default' + $name + '\s*=\s*["'']([^"'']*)["'']')
            if ($all.Count -ne $literal.Count) {
                throw "[PRIVACY_NEUTRAL_DEFAULT] Package privacy check requires a neutral local model default: $relative"
            }
            $literalDefaults[$name] = @($literal | ForEach-Object { $_.Groups[1].Value })
        }
        $models = @($literalDefaults['Model'])
        $bases = @($literalDefaults['Base'])
        $authModes = @($literalDefaults['Auth'])
        $apiKeys = @($literalDefaults['ApiKey'])
        $directApiKeys = [regex]::Matches($Text, '(?im)(?<![A-Za-z0-9_])\$apiKey\s*=\s*["'']([^"'']*)["'']')
        $modelScriptLines = @($Text -split '\r?\n')
        $apiKeyAssignmentLines = @($modelScriptLines | Where-Object { $_ -match '(?i)(?<![A-Za-z0-9_])\$apiKey\s*=' })
        $apiKeyValueLines = @($apiKeyAssignmentLines | Where-Object { $_ -match '(?i)\$apiKey\s*=\s*Get-ModelValue\b' })
        $apiKeyDefaultLines = @($apiKeyValueLines | Where-Object { $_ -match '(?i)_API_KEY' -and $_ -match '(?i)-Default\b' })
        $emptyApiKeyDefaults = @($apiKeyDefaultLines | Where-Object { $_ -match '(?i)-Default\s+["'']["''](?:\s|$)' })
        $unsupportedApiKeyAssignments = @($apiKeyAssignmentLines | Where-Object {
            $_ -notmatch '(?i)\$apiKey\s*=\s*["''][^"'']*["'']' -and
            $_ -notmatch '(?i)\$apiKey\s*=\s*Get-ModelValue\b' -and
            $_ -notmatch '(?i)\$apiKey\s*=\s*Assert-ModelSingleLine\s+-Value\s+\$apiKey\b'
        })
        if ($models.Count -lt 1 -or 'local-model' -notin $models -or @($models | Where-Object { $_ -notin $allowedModels }).Count -gt 0 -or
            @($bases | Where-Object { $_ -cne 'https://api.deepseek.com' -and $_ -notmatch '^http://(?:127\.0\.0\.1|localhost)(?::[0-9]+)?(?:/|$)' }).Count -gt 0 -or
            @($authModes | Where-Object { $_ -notin @('bearer', 'none') }).Count -gt 0 -or
            @($apiKeys | Where-Object { -not [string]::IsNullOrEmpty($_) }).Count -gt 0 -or
            @($directApiKeys | Where-Object { -not [string]::IsNullOrEmpty($_.Groups[1].Value) }).Count -gt 0 -or
            $unsupportedApiKeyAssignments.Count -gt 0 -or
            $apiKeyDefaultLines.Count -ne $emptyApiKeyDefaults.Count -or
            $apiKeyDefaultLines.Count -ne $apiKeyValueLines.Count) {
            throw "[PRIVACY_NEUTRAL_DEFAULT] Package privacy check requires a neutral local model default: $relative"
        }
    }

    if ($relative -ieq 'app/model-config.js') {
        $localProfiles = [regex]::Matches(
            $Text,
            '(?s)DEFAULT_LOCAL_PROFILE\s*=\s*Object\.freeze\s*\(\s*\{(?<body>.*?)\}\s*\)'
        )
        $remoteProfiles = [regex]::Matches(
            $Text,
            '(?s)DEFAULT_DEEPSEEK_PROFILE\s*=\s*Object\.freeze\s*\(\s*\{(?<body>.*?)\}\s*\)'
        )
        if ($localProfiles.Count -ne 1 -or $remoteProfiles.Count -ne 1) {
            throw "[PRIVACY_NEUTRAL_DEFAULT] Package privacy check requires a neutral local model default: $relative"
        }
        $localProfile = $localProfiles[0]
        $remoteProfile = $remoteProfiles[0]
        $localModel = [regex]::Match($localProfile.Groups['body'].Value, '(?im)\bmodel\s*:\s*["'']([^"'']+)["'']')
        $localBase = [regex]::Match($localProfile.Groups['body'].Value, '(?im)\bbaseUrl\s*:\s*["'']([^"'']+)["'']')
        $localAuth = [regex]::Match($localProfile.Groups['body'].Value, '(?im)\bauthMode\s*:\s*["'']([^"'']+)["'']')
        $localKey = [regex]::Match($localProfile.Groups['body'].Value, '(?im)\bapiKey\s*:\s*["'']([^"'']*)["'']')
        $remoteModel = [regex]::Match($remoteProfile.Groups['body'].Value, '(?im)\bmodel\s*:\s*["'']([^"'']+)["'']')
        $remoteBase = [regex]::Match($remoteProfile.Groups['body'].Value, '(?im)\bbaseUrl\s*:\s*["'']([^"'']+)["'']')
        $remoteAuth = [regex]::Match($remoteProfile.Groups['body'].Value, '(?im)\bauthMode\s*:\s*["'']([^"'']+)["'']')
        $remoteKey = [regex]::Match($remoteProfile.Groups['body'].Value, '(?im)\bapiKey\s*:\s*["'']([^"'']*)["'']')
        $allowedRemoteModels = @('deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-pro')
        if (-not $localModel.Success -or $localModel.Groups[1].Value -cne 'local-model' -or
            -not $localBase.Success -or $localBase.Groups[1].Value -notmatch '^http://(?:127\.0\.0\.1|localhost)(?::[0-9]+)?(?:/|$)' -or
            -not $localAuth.Success -or $localAuth.Groups[1].Value -cne 'none' -or
            -not $localKey.Success -or -not [string]::IsNullOrEmpty($localKey.Groups[1].Value) -or
            -not $remoteModel.Success -or $remoteModel.Groups[1].Value -notin $allowedRemoteModels -or
            -not $remoteBase.Success -or $remoteBase.Groups[1].Value -cne 'https://api.deepseek.com' -or
            -not $remoteAuth.Success -or $remoteAuth.Groups[1].Value -cne 'bearer' -or
            -not $remoteKey.Success -or -not [string]::IsNullOrEmpty($remoteKey.Groups[1].Value)) {
            throw "[PRIVACY_NEUTRAL_DEFAULT] Package privacy check requires a neutral local model default: $relative"
        }
    }
}

function Get-NormalizedTrustedFiles {
    param([hashtable]$TrustedFiles = @{})

    $normalized = @{}
    foreach ($key in @($TrustedFiles.Keys)) {
        $rawPath = [string]$key
        $relative = ConvertTo-PackageRelativePath $rawPath
        $hash = ([string]$TrustedFiles[$key]).Trim().ToLowerInvariant()
        if ([IO.Path]::IsPathRooted($rawPath) -or $rawPath.StartsWith('/') -or $rawPath.StartsWith('\') -or
            $relative -match '(^|/)(?:\.|\.\.)(/|$)' -or $hash -notmatch '^[0-9a-f]{64}$' -or
            $normalized.ContainsKey($relative)) {
            throw "[PRIVACY_TRUSTED_HASH] Package privacy check rejected trusted file declaration"
        }
        $normalized[$relative] = $hash
    }
    return $normalized
}

function Get-PublicPackageTreeManifest {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string[]]$ForbiddenValues = @(),
        [hashtable]$TrustedFiles = @{}
    )

    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    if (-not (Test-Path -LiteralPath $full -PathType Container)) {
        throw "Package privacy check requires an existing directory"
    }
    $forbiddenNeedles = @(Get-PackageForbiddenNeedles $ForbiddenValues)
    $trusted = Get-NormalizedTrustedFiles $TrustedFiles
    $manifest = New-Object 'Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)

    foreach ($file in Get-PackageTreeFiles -Root $full) {
        $relative = ConvertTo-PackageRelativePath $file.FullName.Substring($full.Length)
        Assert-PackageRelativePath $relative
        if ($manifest.ContainsKey($relative)) {
            throw "[PRIVACY_RUNTIME_STATE] Package privacy check rejected duplicate path: $relative"
        }

        $isTrusted = $trusted.ContainsKey($relative)
        if ([IO.Path]::GetFileName($relative) -ieq 'model-call.ps1' -or $relative -ieq 'app/model-config.js') {
            Assert-PackageModelDefaults -RelativePath $relative -Text ([IO.File]::ReadAllText($file.FullName))
        }
        $stream = [IO.File]::OpenRead($file.FullName)
        try {
            $hash = Get-PackageStreamHash -Stream $stream -RelativePath $relative -ForbiddenNeedles $forbiddenNeedles -SkipContent ([bool]$isTrusted)
        }
        finally {
            $stream.Dispose()
        }
        if ($isTrusted -and $hash -cne $trusted[$relative]) {
            throw "[PRIVACY_TRUSTED_HASH] Package privacy check rejected trusted file hash: $relative"
        }
        $manifest.Add($relative, ([string]$file.Length + ':' + $hash))
    }

    foreach ($relative in @($trusted.Keys)) {
        if (-not $manifest.ContainsKey($relative)) {
            throw "[PRIVACY_TRUSTED_HASH] Package privacy check requires trusted file: $relative"
        }
    }
    return $manifest
}

function Assert-PublicPackageTree {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string[]]$ForbiddenValues = @(),
        [hashtable]$TrustedFiles = @{}
    )

    $null = Get-PublicPackageTreeManifest -Path $Path -ForbiddenValues $ForbiddenValues -TrustedFiles $TrustedFiles
}

function Get-PackageManifestFingerprint {
    param([Parameter(Mandatory = $true)][Collections.IDictionary]$Manifest)

    $builder = New-Object Text.StringBuilder
    foreach ($relative in @($Manifest.Keys | Sort-Object)) {
        $null = $builder.Append($relative.ToLowerInvariant())
        $null = $builder.Append('=')
        $null = $builder.Append([string]$Manifest[$relative])
        $null = $builder.Append("`n")
    }
    $bytes = [Text.Encoding]::UTF8.GetBytes($builder.ToString())
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha256.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $sha256.Dispose()
    }
}

function New-PackageArchiveFromTree {
    param(
        [Parameter(Mandatory = $true)][string]$Stage,
        [Parameter(Mandatory = $true)][string]$Archive
    )

    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $fullStage = [IO.Path]::GetFullPath($Stage).TrimEnd('\', '/')
    $zip = [IO.Compression.ZipFile]::Open($Archive, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($file in Get-PackageTreeFiles -Root $fullStage) {
            $relative = ConvertTo-PackageRelativePath $file.FullName.Substring($fullStage.Length)
            $entry = $zip.CreateEntry($relative, [IO.Compression.CompressionLevel]::Optimal)
            $inputStream = [IO.File]::OpenRead($file.FullName)
            try {
                $outputStream = $entry.Open()
                try { $inputStream.CopyTo($outputStream) }
                finally { $outputStream.Dispose() }
            }
            finally { $inputStream.Dispose() }
        }
    }
    finally { $zip.Dispose() }
}

function Assert-PublicPackageArchive {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Archive,
        [Parameter(Mandatory = $true)][string]$Stage,
        [string[]]$ForbiddenValues = @(),
        [hashtable]$TrustedFiles = @{}
    )

    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $stageManifest = Get-PublicPackageTreeManifest -Path $Stage -ForbiddenValues $ForbiddenValues -TrustedFiles $TrustedFiles
    $forbiddenNeedles = @(Get-PackageForbiddenNeedles $ForbiddenValues)
    $trusted = Get-NormalizedTrustedFiles $TrustedFiles
    $archiveManifest = New-Object 'Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        foreach ($entry in $zip.Entries) {
            $rawName = [string]$entry.FullName
            $relative = ConvertTo-PackageRelativePath $rawName
            if ($rawName.StartsWith('/') -or $rawName.StartsWith('\') -or $rawName.Contains('\') -or
                $relative -match '^[A-Za-z]:' -or $relative -match '(^|/)(?:\.|\.\.)(/|$)') {
                throw "[PRIVACY_ARCHIVE_MISMATCH] Package archive entry set or hash differs from audited stage"
            }
            if ([string]::IsNullOrEmpty($entry.Name)) { continue }
            if ($archiveManifest.ContainsKey($relative)) {
                throw "[PRIVACY_ARCHIVE_MISMATCH] Package archive entry set or hash differs from audited stage"
            }
            Assert-PackageRelativePath $relative

            $isTrusted = $trusted.ContainsKey($relative)
            if ([IO.Path]::GetFileName($relative) -ieq 'model-call.ps1' -or $relative -ieq 'app/model-config.js') {
                $modelStream = $entry.Open()
                try {
                    $reader = New-Object IO.StreamReader($modelStream, [Text.Encoding]::UTF8, $true)
                    try { $modelText = $reader.ReadToEnd() } finally { $reader.Dispose() }
                } finally { if ($modelStream) { $modelStream.Dispose() } }
                Assert-PackageModelDefaults -RelativePath $relative -Text $modelText
            }
            $stream = $entry.Open()
            try {
                $hash = Get-PackageStreamHash -Stream $stream -RelativePath $relative -ForbiddenNeedles $forbiddenNeedles -SkipContent ([bool]$isTrusted)
            }
            finally {
                $stream.Dispose()
            }
            if ($isTrusted -and $hash -cne $trusted[$relative]) {
                throw "[PRIVACY_TRUSTED_HASH] Package privacy check rejected trusted file hash: $relative"
            }
            $archiveManifest.Add($relative, ([string]$entry.Length + ':' + $hash))
        }
    }
    finally {
        $zip.Dispose()
    }

    if ($archiveManifest.Count -ne $stageManifest.Count) {
        throw "[PRIVACY_ARCHIVE_MISMATCH] Package archive entry set or hash differs from audited stage"
    }
    foreach ($relative in $stageManifest.Keys) {
        if (-not $archiveManifest.ContainsKey($relative) -or
            $archiveManifest[$relative] -cne $stageManifest[$relative]) {
            throw "[PRIVACY_ARCHIVE_MISMATCH] Package archive entry set or hash differs from audited stage: $relative"
        }
    }
}

function Publish-AuditedPackageArchive {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Stage,
        [Parameter(Mandatory = $true)][string]$CandidateArchive,
        [Parameter(Mandatory = $true)][string]$DestinationArchive,
        [string[]]$ForbiddenValues = @(),
        [hashtable]$TrustedFiles = @{},
        [string]$ExpectedStageFingerprint = ''
    )

    $stageManifest = Get-PublicPackageTreeManifest -Path $Stage -ForbiddenValues $ForbiddenValues -TrustedFiles $TrustedFiles
    $stageFingerprint = Get-PackageManifestFingerprint $stageManifest
    if (-not [string]::IsNullOrWhiteSpace($ExpectedStageFingerprint) -and $stageFingerprint -cne $ExpectedStageFingerprint) {
        throw "[PRIVACY_ARCHIVE_MISMATCH] Package stage differs from its audited snapshot"
    }
    if (Test-Path -LiteralPath $CandidateArchive) { throw "Package archive candidate already exists" }
    if (Test-Path -LiteralPath $DestinationArchive) { throw "Package archive destination already exists" }

    $candidateParent = Split-Path $CandidateArchive -Parent
    if (-not (Test-Path -LiteralPath $candidateParent)) {
        $null = New-Item -ItemType Directory -Path $candidateParent
    }
    New-PackageArchiveFromTree -Stage $Stage -Archive $CandidateArchive
    $lockedCandidate = [IO.File]::Open($CandidateArchive, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        Assert-PublicPackageArchive -Archive $CandidateArchive -Stage $Stage -ForbiddenValues $ForbiddenValues -TrustedFiles $TrustedFiles
        $lockedCandidate.Position = 0
        $archiveHash = Get-PackageStreamHash -Stream $lockedCandidate -RelativePath ([IO.Path]::GetFileName($CandidateArchive)) -SkipContent $true
        $lockedCandidate.Position = 0
        $destinationParent = Split-Path $DestinationArchive -Parent
        if (-not (Test-Path -LiteralPath $destinationParent)) {
            $null = New-Item -ItemType Directory -Path $destinationParent
        }
        $destinationStream = [IO.File]::Open($DestinationArchive, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $lockedCandidate.CopyTo($destinationStream) }
        finally { $destinationStream.Dispose() }
    }
    finally { $lockedCandidate.Dispose() }
    $destinationRead = [IO.File]::OpenRead($DestinationArchive)
    try { $destinationHash = Get-PackageStreamHash -Stream $destinationRead -RelativePath ([IO.Path]::GetFileName($DestinationArchive)) -SkipContent $true }
    finally { $destinationRead.Dispose() }
    if ($destinationHash -cne $archiveHash) {
        throw "[PRIVACY_ARCHIVE_MISMATCH] Package archive changed while publishing"
    }
    return [pscustomobject]@{ StageFingerprint = $stageFingerprint; ArchiveSha256 = $archiveHash }
}

function Assert-PackageManifestsEqual {
    param(
        [Parameter(Mandatory = $true)][Collections.IDictionary]$Expected,
        [Parameter(Mandatory = $true)][Collections.IDictionary]$Actual,
        [Parameter(Mandatory = $true)][string]$ErrorCode
    )
    if ($Expected.Count -ne $Actual.Count) { throw "$ErrorCode Package file set or hash changed" }
    foreach ($relative in $Expected.Keys) {
        if (-not $Actual.ContainsKey($relative) -or [string]$Actual[$relative] -cne [string]$Expected[$relative]) {
            throw "$ErrorCode Package file set or hash changed: $relative"
        }
    }
}

function New-AuditedPackageSnapshot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$SourceStage,
        [Parameter(Mandatory = $true)][string]$SnapshotStage,
        [string[]]$ForbiddenValues = @(),
        [hashtable]$TrustedFiles = @{}
    )
    $sourceFull = [IO.Path]::GetFullPath($SourceStage).TrimEnd('\', '/')
    $snapshotFull = [IO.Path]::GetFullPath($SnapshotStage).TrimEnd('\', '/')
    if (Test-Path -LiteralPath $snapshotFull) { throw "[PRIVACY_SNAPSHOT_MUTATED] Frozen stage already exists" }
    $initial = Get-PublicPackageTreeManifest -Path $sourceFull -ForbiddenValues $ForbiddenValues -TrustedFiles $TrustedFiles
    $null = New-Item -ItemType Directory -Path $snapshotFull
    foreach ($file in Get-PackageTreeFiles -Root $sourceFull) {
        $relative = ConvertTo-PackageRelativePath $file.FullName.Substring($sourceFull.Length)
        $destination = Join-Path $snapshotFull $relative.Replace('/', '\')
        $parent = Split-Path $destination -Parent
        if (-not (Test-Path -LiteralPath $parent)) { $null = New-Item -ItemType Directory -Path $parent }
        $input = [IO.File]::Open($file.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        try {
            $output = [IO.File]::Open($destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try { $input.CopyTo($output) } finally { $output.Dispose() }
        } finally { $input.Dispose() }
    }
    $sourceAfter = Get-PublicPackageTreeManifest -Path $sourceFull -ForbiddenValues $ForbiddenValues -TrustedFiles $TrustedFiles
    $snapshot = Get-PublicPackageTreeManifest -Path $snapshotFull -ForbiddenValues $ForbiddenValues -TrustedFiles $TrustedFiles
    Assert-PackageManifestsEqual -Expected $initial -Actual $sourceAfter -ErrorCode '[PRIVACY_SNAPSHOT_MUTATED]'
    Assert-PackageManifestsEqual -Expected $initial -Actual $snapshot -ErrorCode '[PRIVACY_SNAPSHOT_MUTATED]'
    return [pscustomobject]@{ Fingerprint = (Get-PackageManifestFingerprint $snapshot); Manifest = $snapshot }
}

function Assert-PublicPackageFile {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$RelativePath,
        [string[]]$ForbiddenValues = @()
    )
    Assert-PackageRelativePath $RelativePath
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try { return Get-PackageStreamHash -Stream $stream -RelativePath $RelativePath -ForbiddenNeedles @(Get-PackageForbiddenNeedles $ForbiddenValues) -SkipContent $false }
    finally { $stream.Dispose() }
}

function Copy-VerifiedPackageFile {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256
    )
    $input = [IO.File]::Open($Source, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $actual = Get-PackageStreamHash -Stream $input -RelativePath ([IO.Path]::GetFileName($Source)) -SkipContent $true
        if ($actual -cne $ExpectedSha256.ToLowerInvariant()) { throw "[PRIVACY_RELEASE_MUTATED] Release source changed after audit" }
        $input.Position = 0
        $parent = Split-Path $Destination -Parent
        if (-not (Test-Path -LiteralPath $parent)) { $null = New-Item -ItemType Directory -Path $parent }
        $output = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $input.CopyTo($output) } finally { $output.Dispose() }
    } finally { $input.Dispose() }
    $copiedRead = [IO.File]::OpenRead($Destination)
    try { $copied = Get-PackageStreamHash -Stream $copiedRead -RelativePath ([IO.Path]::GetFileName($Destination)) -SkipContent $true }
    finally { $copiedRead.Dispose() }
    if ($copied -cne $ExpectedSha256.ToLowerInvariant()) { throw "[PRIVACY_RELEASE_MUTATED] Release copy differs from audited bytes" }
}

function Publish-VerifiedReleaseDirectory {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$CandidateDirectory,
        [Parameter(Mandatory = $true)][string]$OutputDirectory,
        [Parameter(Mandatory = $true)][string]$ExpectedFingerprint,
        [string[]]$ForbiddenValues = @(),
        [hashtable]$TrustedFiles = @{}
    )
    $candidateFull = [IO.Path]::GetFullPath($CandidateDirectory).TrimEnd('\', '/')
    $outputFull = [IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\', '/')
    if (Test-Path -LiteralPath $outputFull) { throw "[PRIVACY_RELEASE_MUTATED] Final release destination already exists" }
    $expected = Get-PublicPackageTreeManifest -Path $candidateFull -ForbiddenValues $ForbiddenValues -TrustedFiles $TrustedFiles
    if ((Get-PackageManifestFingerprint $expected) -cne $ExpectedFingerprint) {
        throw "[PRIVACY_RELEASE_MUTATED] Release candidate changed after audit"
    }
    $outputParent = Split-Path $outputFull -Parent
    if (-not (Test-Path -LiteralPath $outputParent)) { $null = New-Item -ItemType Directory -Path $outputParent }
    $temporary = Join-Path $outputParent ('.' + [IO.Path]::GetFileName($outputFull) + '.candidate-' + [Guid]::NewGuid().ToString('N'))
    $null = New-Item -ItemType Directory -Path $temporary
    foreach ($file in Get-PackageTreeFiles -Root $candidateFull) {
        $relative = ConvertTo-PackageRelativePath $file.FullName.Substring($candidateFull.Length)
        $parts = ([string]$expected[$relative]).Split(':', 2)
        Copy-VerifiedPackageFile -Source $file.FullName -Destination (Join-Path $temporary $relative.Replace('/', '\')) -ExpectedSha256 $parts[1]
    }
    $candidateAfter = Get-PublicPackageTreeManifest -Path $candidateFull -ForbiddenValues $ForbiddenValues -TrustedFiles $TrustedFiles
    $temporaryManifest = Get-PublicPackageTreeManifest -Path $temporary -ForbiddenValues $ForbiddenValues -TrustedFiles $TrustedFiles
    Assert-PackageManifestsEqual -Expected $expected -Actual $candidateAfter -ErrorCode '[PRIVACY_RELEASE_MUTATED]'
    Assert-PackageManifestsEqual -Expected $expected -Actual $temporaryManifest -ErrorCode '[PRIVACY_RELEASE_MUTATED]'
    [IO.Directory]::Move($temporary, $outputFull)
}

function Assert-AuditedInstallerSource {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$InstallerScript,
        [Parameter(Mandatory = $true)][string]$Stage,
        [string[]]$ForbiddenValues = @(),
        [hashtable]$TrustedFiles = @{},
        [string]$ExpectedStageFingerprint = '',
        [switch]$RequireEnvironmentBinding,
        [switch]$RequireExplicitSources
    )

    $stageFull = [IO.Path]::GetFullPath($Stage).TrimEnd('\', '/')
    $stageManifest = Get-PublicPackageTreeManifest -Path $stageFull -ForbiddenValues $ForbiddenValues -TrustedFiles $TrustedFiles
    if (-not [string]::IsNullOrWhiteSpace($ExpectedStageFingerprint) -and
        (Get-PackageManifestFingerprint $stageManifest) -cne $ExpectedStageFingerprint) {
        throw "[PRIVACY_INSTALLER_SOURCE] Installer stage differs from the audited Portable stage"
    }
    $installerStream = [IO.File]::OpenRead($InstallerScript)
    try {
        $null = Get-PackageStreamHash `
            -Stream $installerStream `
            -RelativePath ([IO.Path]::GetFileName($InstallerScript)) `
            -ForbiddenNeedles @(Get-PackageForbiddenNeedles $ForbiddenValues) `
            -SkipContent $false
    }
    finally { $installerStream.Dispose() }
    $text = [IO.File]::ReadAllText($InstallerScript)
    if ($text -match '(?m)\\[ \t]*\r?$') {
        throw "[PRIVACY_INSTALLER_SOURCE] Installer source is not limited to the audited stage"
    }
    $inlinePreprocessorCheck = $text.
        Replace('{#AppVersion}', '').
        Replace('{#StageDir}', '').
        Replace('{#OutputDir}', '')
    if ($inlinePreprocessorCheck -match '\{#') {
        throw "[PRIVACY_INSTALLER_SOURCE] Installer source is not limited to the audited stage"
    }
    $allowedDirectives = @(
        '#define AppVersion GetEnv("OLIVIA_SOUL_VERSION")',
        '#define StageDir GetEnv("OLIVIA_SOUL_STAGE")',
        '#define OutputDir GetEnv("OLIVIA_SOUL_OUTPUT")'
    )
    $directiveCounts = @{}
    $section = ''
    $fileSourceCount = 0
    $wildcardSourceCount = 0
    $explicitSources = New-Object 'Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
    $filesSectionCount = 0
    $allowedSections = @('Setup', 'InstallDelete', 'Files', 'Icons', 'Run', 'Code')
    foreach ($rawLine in @($text -split "`r?`n")) {
        $line = $rawLine.Trim()
        if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith(';')) { continue }
        if ($line.StartsWith('#')) {
            if ($line -cnotin $allowedDirectives) { throw "[PRIVACY_INSTALLER_SOURCE] Installer source is not limited to the audited stage" }
            if (-not $directiveCounts.ContainsKey($line)) { $directiveCounts[$line] = 0 }
            $directiveCounts[$line]++
            if ($directiveCounts[$line] -ne 1) { throw "[PRIVACY_INSTALLER_SOURCE] Installer source is not limited to the audited stage" }
            continue
        }
        if ($line -match '^\[(?<name>[^\]]+)\]$') {
            $section = $Matches['name']
            if ($section -cnotin $allowedSections) {
                throw "[PRIVACY_INSTALLER_SOURCE] Installer source is not limited to the audited stage"
            }
            if ($section -ieq 'Files') { $filesSectionCount++ }
            continue
        }
        if ($line -match '(?i)^Source\s*:') {
            if ($section -ine 'Files') { throw "[PRIVACY_INSTALLER_SOURCE] Installer source is not limited to the audited stage" }
            $sourceMatch = [regex]::Match($line, '(?i)^Source\s*:\s*"(?<source>[^"]+)"(?<rest>.*)$')
            $sourceParameters = [regex]::Matches($line, '(?i)(?:^|;)\s*Source\s*:')
            if (-not $sourceMatch.Success -or $sourceParameters.Count -ne 1) {
                throw "[PRIVACY_INSTALLER_SOURCE] Installer source is not limited to the audited stage"
            }
            $source = $sourceMatch.Groups['source'].Value
            if ($source -ieq '{#StageDir}\*') {
                if ($RequireExplicitSources -or
                    $sourceMatch.Groups['rest'].Value -cnotin @(
                        '; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs',
                        '; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs'
                    ) -or
                    $sourceMatch.Groups['rest'].Value -notmatch '(?i)\brecursesubdirs\b' -or
                    $sourceMatch.Groups['rest'].Value -notmatch '(?i)\bcreateallsubdirs\b') {
                    throw "[PRIVACY_INSTALLER_SOURCE] Installer source is not limited to the audited stage"
                }
                $wildcardSourceCount++
            }
            else {
                if (-not ($source.StartsWith('{#StageDir}\', [StringComparison]::OrdinalIgnoreCase) -or
                    $source.StartsWith('{#StageDir}/', [StringComparison]::OrdinalIgnoreCase))) {
                    throw "[PRIVACY_INSTALLER_SOURCE] Installer source is not limited to the audited stage"
                }
                $relativeSource = $source.Substring(12).Replace('\', '/')
                if ($relativeSource -match '(^|/)(?:\.|\.\.)(/|$)' -or $relativeSource -match '[*?{}"]') {
                    throw "[PRIVACY_INSTALLER_SOURCE] Installer source is not limited to the audited stage"
                }
                $fullSource = [IO.Path]::GetFullPath((Join-Path $stageFull $relativeSource.Replace('/', '\')))
                if (-not $fullSource.StartsWith($stageFull + '\', [StringComparison]::OrdinalIgnoreCase) -or
                    -not (Test-Path -LiteralPath $fullSource -PathType Leaf) -or $explicitSources.ContainsKey($relativeSource)) {
                    throw "[PRIVACY_INSTALLER_SOURCE] Installer source is not limited to the audited stage"
                }
                $windowsRelative = $relativeSource.Replace('/', '\')
                $directory = [IO.Path]::GetDirectoryName($windowsRelative)
                $destination = if ([string]::IsNullOrWhiteSpace($directory)) { '{app}' } else { '{app}\' + $directory }
                $expectedRest = '; DestDir: "' + $destination + '"; Flags: ignoreversion'
                if ($sourceMatch.Groups['rest'].Value -cne $expectedRest) {
                    throw "[PRIVACY_INSTALLER_SOURCE] Installer source is not limited to the audited stage"
                }
                $explicitSources.Add($relativeSource, $fullSource)
            }
            $fileSourceCount++
            continue
        }
        if ($section -ieq 'Files') {
            # The project emits a deliberately canonical Files entry with Source first.
            # Reject every other ordering so an otherwise valid Inno parameter cannot
            # bypass the explicit manifest comparison.
            throw "[PRIVACY_INSTALLER_SOURCE] Installer source is not limited to the audited stage"
        }
        if ($section -ieq 'Setup' -and
            $line -match '(?i)^(?:SignTool(?:MinimumTimeBetween|RetryCount|RetryDelay|RunMinimized)?|SignedUninstaller(?:Dir)?|SourceDir|OutputManifestFile)\s*=') {
            throw "[PRIVACY_INSTALLER_SOURCE] Installer source is not limited to the audited stage"
        }
        if ($section -ieq 'Setup' -and $line -match '(?i)^(?<key>SetupIconFile|LicenseFile|InfoBeforeFile|InfoAfterFile|WizardBackImageFile|WizardBackImageFileDynamicDark|WizardImageFile|WizardImageFileDynamicDark|WizardSmallImageFile|WizardSmallImageFileDynamicDark|WizardStyleFile|WizardStyleFileDynamicDark|MessagesFile|UninstallIconFile|UninstallStyle)\s*=\s*(?<value>.+)$') {
            $source = $Matches['value'].Trim().Trim('"')
            if (-not ($source.StartsWith('{#StageDir}\', [StringComparison]::OrdinalIgnoreCase) -or $source.StartsWith('{#StageDir}/', [StringComparison]::OrdinalIgnoreCase))) {
                throw "[PRIVACY_INSTALLER_SOURCE] Installer source is not limited to the audited stage"
            }
            $relativeSource = $source.Substring(12).Replace('/', '\')
            $fullSource = [IO.Path]::GetFullPath((Join-Path $stageFull $relativeSource))
            if ($relativeSource -match '(^|\\)(?:\.|\.\.)(\\|$)' -or $relativeSource.Contains(',') -or
                -not $fullSource.StartsWith($stageFull + '\', [StringComparison]::OrdinalIgnoreCase) -or
                -not (Test-Path -LiteralPath $fullSource -PathType Leaf)) {
                throw "[PRIVACY_INSTALLER_SOURCE] Installer source is not limited to the audited stage"
            }
            continue
        }
        if ($line -match '(?i)^(?:SetupIconFile|LicenseFile|InfoBeforeFile|InfoAfterFile|WizardBackImageFile|WizardBackImageFileDynamicDark|WizardImageFile|WizardImageFileDynamicDark|WizardSmallImageFile|WizardSmallImageFileDynamicDark|WizardStyleFile|WizardStyleFileDynamicDark|MessagesFile|UninstallIconFile|UninstallStyle)\s*=') {
            throw "[PRIVACY_INSTALLER_SOURCE] Installer source is not limited to the audited stage"
        }
        if ($line -match '(?i)\b(?:MessagesFile|LicenseFile|InfoBeforeFile|InfoAfterFile)\s*:') {
            if ($section -ine 'Languages') { throw "[PRIVACY_INSTALLER_SOURCE] Installer source is not limited to the audited stage" }
            $languageFiles = [regex]::Matches($line, '(?i)\b(?:MessagesFile|LicenseFile|InfoBeforeFile|InfoAfterFile)\s*:\s*"(?<value>[^"]+)"')
            if ($languageFiles.Count -lt 1) { throw "[PRIVACY_INSTALLER_SOURCE] Installer source is not limited to the audited stage" }
            foreach ($languageFile in $languageFiles) {
                foreach ($source in @($languageFile.Groups['value'].Value -split ',')) {
                    $source = $source.Trim()
                    if (-not ($source.StartsWith('{#StageDir}\', [StringComparison]::OrdinalIgnoreCase) -or $source.StartsWith('{#StageDir}/', [StringComparison]::OrdinalIgnoreCase))) {
                        throw "[PRIVACY_INSTALLER_SOURCE] Installer source is not limited to the audited stage"
                    }
                    $relativeSource = $source.Substring(12).Replace('/', '\')
                    $fullSource = [IO.Path]::GetFullPath((Join-Path $stageFull $relativeSource))
                    if ($relativeSource -match '(^|\\)(?:\.|\.\.)(\\|$)' -or -not $fullSource.StartsWith($stageFull + '\', [StringComparison]::OrdinalIgnoreCase) -or
                        -not (Test-Path -LiteralPath $fullSource -PathType Leaf)) {
                        throw "[PRIVACY_INSTALLER_SOURCE] Installer source is not limited to the audited stage"
                    }
                }
            }
        }
    }
    if ($filesSectionCount -ne 1 -or $fileSourceCount -lt 1 -or
        ($wildcardSourceCount -gt 0 -and ($wildcardSourceCount -ne 1 -or $fileSourceCount -ne 1))) {
        throw "[PRIVACY_INSTALLER_SOURCE] Installer source is not limited to the audited stage"
    }
    if ($wildcardSourceCount -eq 0) {
        if ($explicitSources.Count -ne $stageManifest.Count) {
            throw "[PRIVACY_INSTALLER_SOURCE] Installer explicit source set differs from the audited stage"
        }
        foreach ($relative in $stageManifest.Keys) {
            if (-not $explicitSources.ContainsKey($relative)) {
                throw "[PRIVACY_INSTALLER_SOURCE] Installer explicit source set differs from the audited stage"
            }
        }
    }
    if ($RequireEnvironmentBinding) {
        if (-not $directiveCounts.ContainsKey('#define StageDir GetEnv("OLIVIA_SOUL_STAGE")') -or
            $directiveCounts['#define StageDir GetEnv("OLIVIA_SOUL_STAGE")'] -ne 1 -or
            [string]::IsNullOrWhiteSpace($env:OLIVIA_SOUL_STAGE) -or
            [IO.Path]::GetFullPath($env:OLIVIA_SOUL_STAGE).TrimEnd('\', '/') -ine $stageFull) {
            throw "[PRIVACY_INSTALLER_SOURCE] Installer source is not bound to the audited stage"
        }
    }
}

function New-AuditedInstallerCompileScript {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$TemplateScript,
        [Parameter(Mandatory = $true)][string]$OutputScript,
        [Parameter(Mandatory = $true)][string]$Stage,
        [string[]]$ForbiddenValues = @(),
        [hashtable]$TrustedFiles = @{},
        [string]$ExpectedStageFingerprint = ''
    )

    if (Test-Path -LiteralPath $OutputScript) { throw "[PRIVACY_INSTALLER_SOURCE] Installer compile source already exists" }
    Assert-AuditedInstallerSource `
        -InstallerScript $TemplateScript `
        -Stage $Stage `
        -ForbiddenValues $ForbiddenValues `
        -TrustedFiles $TrustedFiles `
        -ExpectedStageFingerprint $ExpectedStageFingerprint
    $manifest = Get-PublicPackageTreeManifest -Path $Stage -ForbiddenValues $ForbiddenValues -TrustedFiles $TrustedFiles
    $fingerprint = Get-PackageManifestFingerprint $manifest
    if (-not [string]::IsNullOrWhiteSpace($ExpectedStageFingerprint) -and $fingerprint -cne $ExpectedStageFingerprint) {
        throw "[PRIVACY_INSTALLER_SOURCE] Installer stage differs from its audited snapshot"
    }
    $templateText = [IO.File]::ReadAllText($TemplateScript)
    $wildcardLines = [regex]::Matches($templateText, '(?im)^\s*Source\s*:\s*"\{#StageDir\}\\\*"[^\r\n]*\r?$')
    if ($wildcardLines.Count -ne 1) { throw "[PRIVACY_INSTALLER_SOURCE] Installer template must contain one audited stage wildcard" }
    $sourceLines = foreach ($relative in @($manifest.Keys | Sort-Object)) {
        if ($relative -match '[*?{}"]') { throw "[PRIVACY_INSTALLER_SOURCE] Installer stage contains an unsupported file name" }
        $windowsRelative = $relative.Replace('/', '\')
        $directory = [IO.Path]::GetDirectoryName($windowsRelative)
        $destination = if ([string]::IsNullOrWhiteSpace($directory)) { '{app}' } else { '{app}\' + $directory }
        'Source: "{#StageDir}\' + $windowsRelative + '"; DestDir: "' + $destination + '"; Flags: ignoreversion'
    }
    $wildcard = $wildcardLines[0]
    $replacement = $sourceLines -join "`r`n"
    $compileText = $templateText.Substring(0, $wildcard.Index) + $replacement + $templateText.Substring($wildcard.Index + $wildcard.Length)
    $parent = Split-Path $OutputScript -Parent
    if (-not (Test-Path -LiteralPath $parent)) { $null = New-Item -ItemType Directory -Path $parent }
    [IO.File]::WriteAllText($OutputScript, $compileText, (New-Object Text.UTF8Encoding $false))
    Assert-AuditedInstallerSource `
        -InstallerScript $OutputScript `
        -Stage $Stage `
        -ForbiddenValues $ForbiddenValues `
        -TrustedFiles $TrustedFiles `
        -ExpectedStageFingerprint $fingerprint `
        -RequireExplicitSources
    return [pscustomobject]@{ StageFingerprint = $fingerprint; Manifest = $manifest }
}

function Invoke-AuditedInstallerCompiler {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$InstallerScript,
        [Parameter(Mandatory = $true)][string]$Stage,
        [Parameter(Mandatory = $true)][scriptblock]$Compiler,
        [string[]]$ForbiddenValues = @(),
        [hashtable]$TrustedFiles = @{},
        [string]$ExpectedStageFingerprint = '',
        [switch]$RequireEnvironmentBinding,
        [switch]$RequireExplicitSources
    )

    if (-not $RequireExplicitSources) {
        throw "[PRIVACY_INSTALLER_SOURCE] Installer compilation requires an explicit audited source list"
    }
    $stageFull = [IO.Path]::GetFullPath($Stage).TrimEnd('\', '/')
    Assert-AuditedInstallerSource `
        -InstallerScript $InstallerScript `
        -Stage $stageFull `
        -ForbiddenValues $ForbiddenValues `
        -TrustedFiles $TrustedFiles `
        -ExpectedStageFingerprint $ExpectedStageFingerprint `
        -RequireEnvironmentBinding:$RequireEnvironmentBinding `
        -RequireExplicitSources
    $initialManifest = Get-PublicPackageTreeManifest -Path $stageFull -ForbiddenValues $ForbiddenValues -TrustedFiles $TrustedFiles
    $initialFingerprint = Get-PackageManifestFingerprint $initialManifest
    $initialInstallerHash = Assert-PublicPackageFile -Path $InstallerScript -RelativePath ([IO.Path]::GetFileName($InstallerScript)) -ForbiddenValues $ForbiddenValues
    if (-not [string]::IsNullOrWhiteSpace($ExpectedStageFingerprint) -and $initialFingerprint -cne $ExpectedStageFingerprint) {
        throw "[PRIVACY_INSTALLER_SOURCE] Installer stage differs from the audited Portable stage"
    }

    $locks = New-Object 'Collections.Generic.List[IDisposable]'
    try {
        foreach ($relative in @($initialManifest.Keys | Sort-Object)) {
            $path = Join-Path $stageFull $relative.Replace('/', '\')
            $locks.Add([IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read))
        }
        $installerLock = [IO.File]::Open($InstallerScript, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        $locks.Add($installerLock)
        $lockedInstallerHash = Get-PackageStreamHash -Stream $installerLock -RelativePath ([IO.Path]::GetFileName($InstallerScript)) -SkipContent $true
        if ($lockedInstallerHash -cne $initialInstallerHash) {
            throw "[PRIVACY_INSTALLER_COMPILE] Installer source changed before compilation"
        }
        $lockedManifest = Get-PublicPackageTreeManifest -Path $stageFull -ForbiddenValues $ForbiddenValues -TrustedFiles $TrustedFiles
        Assert-PackageManifestsEqual -Expected $initialManifest -Actual $lockedManifest -ErrorCode '[PRIVACY_INSTALLER_COMPILE]'

        try { & $Compiler $InstallerScript }
        catch { throw "[PRIVACY_INSTALLER_COMPILE] Installer compiler failed while audited inputs were locked" }
        $finalManifest = Get-PublicPackageTreeManifest -Path $stageFull -ForbiddenValues $ForbiddenValues -TrustedFiles $TrustedFiles
        Assert-PackageManifestsEqual -Expected $initialManifest -Actual $finalManifest -ErrorCode '[PRIVACY_INSTALLER_COMPILE]'
        Assert-AuditedInstallerSource `
            -InstallerScript $InstallerScript `
            -Stage $stageFull `
            -ForbiddenValues $ForbiddenValues `
            -TrustedFiles $TrustedFiles `
            -ExpectedStageFingerprint $initialFingerprint `
            -RequireEnvironmentBinding:$RequireEnvironmentBinding `
            -RequireExplicitSources
    }
    finally {
        foreach ($lock in $locks) { $lock.Dispose() }
    }
}
