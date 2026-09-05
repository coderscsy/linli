param(
    [Parameter(Mandatory = $true)][string]$ArchivePath,
    [Parameter(Mandatory = $true)][string]$PreviousEditor,
    [Parameter(Mandatory = $true)][string]$NewEditor,
    [Parameter(Mandatory = $true)][string]$BackupDirectory
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archiveFile = [IO.Path]::GetFullPath($ArchivePath)
if ([IO.Path]::GetFileName($archiveFile) -ne 'feapp.dat') { throw 'Expected an explicit feapp.dat target' }
if (Get-Process -Name Olivia,OliviaSoul -ErrorAction SilentlyContinue) { throw 'Close the game and OliviaSoul before updating the shared editor' }
$old = [IO.File]::ReadAllText($PreviousEditor)
$new = [IO.File]::ReadAllText($NewEditor)
if ($old -eq $new) { throw 'Editor source has not changed' }
$utf8 = New-Object Text.UTF8Encoding $false
function Read-EntryText($entry) {
    $stream = $entry.Open()
    $reader = New-Object IO.StreamReader($stream, $utf8)
    try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
}
function Entry-Hashes($path) {
    $zip = [IO.Compression.ZipFile]::OpenRead($path)
    $hashes = @{}
    try {
        foreach ($entry in $zip.Entries) {
            $stream = $entry.Open(); $sha = [Security.Cryptography.SHA256]::Create()
            try { $hashes[$entry.FullName] = [BitConverter]::ToString($sha.ComputeHash($stream)) }
            finally { $stream.Dispose(); $sha.Dispose() }
        }
    } finally { $zip.Dispose() }
    return $hashes
}
$zip = [IO.Compression.ZipFile]::OpenRead($archiveFile)
try {
    $entries = @($zip.Entries | Where-Object { $_.FullName -match '^assets/main-[^/]+\.js$' })
    if ($entries.Count -ne 1) { throw 'Expected one main JavaScript entry' }
    $entryName = $entries[0].FullName
    $text = Read-EntryText $entries[0]
    if (([regex]::Matches($text, [regex]::Escape($old))).Count -ne 1) { throw 'Expected exactly one matching previous editor; archive was not changed' }
    $expected = $text.Replace($old, $new)
} finally { $zip.Dispose() }
$before = Entry-Hashes $archiveFile
New-Item -ItemType Directory -Path $BackupDirectory -Force | Out-Null
$backup = Join-Path $BackupDirectory 'feapp.before-preview.dat'
if (Test-Path -LiteralPath $backup) { throw 'Backup already exists; select a fresh backup directory' }
Copy-Item -LiteralPath $archiveFile -Destination $backup
$staged = $archiveFile + '.preview-' + [Guid]::NewGuid().ToString('N') + '.tmp'
try {
    Copy-Item -LiteralPath $archiveFile -Destination $staged
    $zip = [IO.Compression.ZipFile]::Open($staged, [IO.Compression.ZipArchiveMode]::Update)
    try {
        $entry = $zip.GetEntry($entryName); $stamp = $entry.LastWriteTime; $attributes = $entry.ExternalAttributes
        $entry.Delete()
        $entry = $zip.CreateEntry($entryName, [IO.Compression.CompressionLevel]::Optimal)
        $entry.LastWriteTime = $stamp; $entry.ExternalAttributes = $attributes
        $writer = New-Object IO.StreamWriter($entry.Open(), $utf8)
        try { $writer.Write($expected) } finally { $writer.Dispose() }
    } finally { $zip.Dispose() }
    $after = Entry-Hashes $staged
    if ($before.Count -ne $after.Count) { throw 'Archive entry count changed' }
    foreach ($key in $before.Keys) {
        if (!$after.ContainsKey($key) -or ($key -ne $entryName -and $before[$key] -ne $after[$key])) { throw "Unrelated archive entry changed: $key" }
    }
    $zip = [IO.Compression.ZipFile]::OpenRead($staged)
    try { if ((Read-EntryText $zip.GetEntry($entryName)) -cne $expected) { throw 'Editor replacement verification failed' } }
    finally { $zip.Dispose() }
    $localRollback = $archiveFile + '.before-preview-' + [Guid]::NewGuid().ToString('N') + '.bak'
    [IO.File]::Replace($staged, $archiveFile, $localRollback)
    Write-Output "Updated shared editor only; backup: $backup"
} finally {
    if (Test-Path -LiteralPath $staged) { Remove-Item -LiteralPath $staged -Force }
}
