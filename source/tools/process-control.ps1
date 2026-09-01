function Stop-GameProcessById([int]$ProcessId) {
    try {
        Stop-Process -Id $ProcessId -Force -ErrorAction Stop
    }
    catch {
        if ($_.FullyQualifiedErrorId -notlike "NoProcessFoundForGivenId,*") {
            throw
        }
    }
}

function Stop-GameProcesses([string]$GameRoot) {
    $gamePrefix = [IO.Path]::GetFullPath($GameRoot).TrimEnd("\") + "\"
    Get-CimInstance Win32_Process |
        Where-Object {
            $_.ExecutablePath -and
            $_.ExecutablePath.StartsWith($gamePrefix, [StringComparison]::OrdinalIgnoreCase)
        } |
        ForEach-Object { Stop-GameProcessById $_.ProcessId }
}
