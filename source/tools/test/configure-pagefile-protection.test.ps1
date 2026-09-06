Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '..\configure-pagefile-protection.ps1')

function Assert-Equal($Expected, $Actual, [string]$Message) {
    if ($Expected -ne $Actual) {
        throw "$Message; expected=[$Expected] actual=[$Actual]"
    }
}

$plan = Get-OliviaPagefilePlan ([pscustomobject]@{ DriveLetter = 'G'; FileSystem = 'NTFS'; FreeBytes = 50GB })
Assert-Equal 'C:\pagefile.sys 1024 4096' $plan.PagingFiles[0] 'boot pagefile mismatch'
Assert-Equal 'G:\pagefile.sys 16384 40960' $plan.PagingFiles[1] 'data pagefile mismatch'
Assert-Equal $true $plan.RebootRequired 'reboot flag mismatch'

foreach ($invalid in @(
    [pscustomobject]@{ DriveLetter = 'F'; FileSystem = 'NTFS'; FreeBytes = 50GB },
    [pscustomobject]@{ DriveLetter = 'G'; FileSystem = 'exFAT'; FreeBytes = 50GB },
    [pscustomobject]@{ DriveLetter = 'G'; FileSystem = 'NTFS'; FreeBytes = 44GB }
)) {
    $threw = $false
    try { Get-OliviaPagefilePlan $invalid | Out-Null } catch { $threw = $true }
    Assert-Equal $true $threw 'invalid drive data must be rejected'
}

Write-Host 'configure-pagefile-protection: 6 assertions passed'
