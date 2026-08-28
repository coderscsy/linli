param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Enable", "Disable")]
    [string]$Mode,
    [string]$Executable = "",
    [string]$Arguments = ""
)

$ErrorActionPreference = "Stop"
$taskName = "OliviaSoulAutoStart"

$legacyTasks = @(Get-ScheduledTask | Where-Object {
    $_.TaskName -eq "OliviaLocalLettersAutoStart" -or
    ($_.TaskName -like "Olivia *" -and $_.TaskName -ne $taskName)
})
foreach ($task in $legacyTasks) {
    Unregister-ScheduledTask -TaskName $task.TaskName -Confirm:$false -ErrorAction SilentlyContinue
}

if ($Mode -eq "Disable") {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    exit 0
}

if ([string]::IsNullOrWhiteSpace($Executable)) { throw "Executable is required" }
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $Executable -Argument $Arguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Days 3650)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "Start Olivia Soul with elevated privileges" -Force | Out-Null
