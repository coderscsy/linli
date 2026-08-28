param(
    [Parameter(Mandatory = $true)][string]$GameRoot,
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$OriginalFile
)

$ErrorActionPreference = "Stop"
$relative = "$Version\resources\feapp.dat"
$destination = Join-Path $GameRoot $relative
if (-not (Test-Path -LiteralPath $OriginalFile)) { throw "original feapp.dat not found" }
$gamePrefix = [IO.Path]::GetFullPath($GameRoot).TrimEnd("\") + "\"
Get-CimInstance Win32_Process |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($gamePrefix, [StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Milliseconds 250
Copy-Item -LiteralPath $OriginalFile -Destination $destination -Force
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $destination).Hash
Write-Output "restored=$destination"
Write-Output "sha256=$hash"
