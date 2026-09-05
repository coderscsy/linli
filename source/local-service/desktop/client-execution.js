const literal = value => `'${String(value).replaceAll("'", "''")}'`;

// Run in the originating user's token: elevated sessions may not see mappings.
export function clientPathProbe(gameRoot) {
  return `$ErrorActionPreference = 'Stop'; try {
    $root = ${literal(gameRoot)};
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw '游戏目录不可用或无访问权限' }
    if ($root -match '^\\\\\\\\[^\\\\]+\\\\[^\\\\]+') { 'network' }
    elseif ($root -match '^[A-Za-z]:\\\\') {
      $drive = @(Get-CimInstance -ClassName Win32_LogicalDisk -Filter ("DeviceID='" + $root.Substring(0,2) + "'") -OperationTimeoutSec 10 -ErrorAction Stop);
      if ($drive.Count -ne 1) { throw '无法确认游戏磁盘类型' }
      if ($drive[0].DriveType -eq 4) { 'network' }
      elseif ($drive[0].DriveType -in @(2,3,5,6)) { 'local' }
      else { throw '无法确认游戏磁盘类型' }
    } else { throw '无法确认游戏目录路径' }
  } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
}

export function networkClosedGamePreflight(gameRoot, selectedExe) {
  return `
    $root = [IO.Path]::GetFullPath(${literal(gameRoot)}).TrimEnd('\\') + '\\';
    $knownNames = @('Olivia.exe', [IO.Path]::GetFileName(${literal(selectedExe)}));
    try { $processes = @(Get-CimInstance -ClassName Win32_Process -OperationTimeoutSec 10 -ErrorAction Stop) }
    catch { throw '无法确认游戏进程状态，请关闭游戏后重试' }
    if ($processes.Count -eq 0) { throw '无法确认游戏进程状态，请关闭游戏后重试' }
    foreach ($item in $processes) {
      if ([string]::IsNullOrWhiteSpace($item.Name)) { throw '无法确认游戏进程状态，请关闭游戏后重试' }
      if ([string]::IsNullOrWhiteSpace($item.ExecutablePath)) {
        if ($item.Name -in $knownNames) { throw '无法确认游戏已关闭，请关闭游戏后重试' }
      } else {
        try { $path = [IO.Path]::GetFullPath($item.ExecutablePath) }
        catch { throw '无法确认游戏进程路径，请关闭游戏后重试' }
        if ($path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw '游戏仍在运行，请关闭游戏后重试' }
      }
    }
  `;
}
