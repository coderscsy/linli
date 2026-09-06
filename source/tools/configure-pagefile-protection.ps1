[CmdletBinding()]
param(
    [switch]$Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-OliviaPagefilePlan {
    param(
        [Parameter(Mandatory)]
        [pscustomobject]$DataDrive
    )

    if ($DataDrive.DriveLetter -ne 'G') {
        throw 'pagefile data drive must be G:'
    }
    if ($DataDrive.FileSystem -ne 'NTFS') {
        throw 'G: must use NTFS for a Windows pagefile'
    }
    if ([int64]$DataDrive.FreeBytes -lt 45GB) {
        throw 'G: needs at least 45 GiB free before configuring pagefile protection'
    }

    [pscustomobject]@{
        PagingFiles = @(
            'C:\pagefile.sys 1024 4096'
            'G:\pagefile.sys 16384 40960'
        )
        RebootRequired = $true
    }
}

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if ($MyInvocation.InvocationName -ne '.') {
    $volume = Get-Volume -DriveLetter G
    $plan = Get-OliviaPagefilePlan ([pscustomobject]@{
        DriveLetter = 'G'
        FileSystem  = [string]$volume.FileSystem
        FreeBytes  = [int64]$volume.SizeRemaining
    })

    Write-Host ('Target configuration: ' + ($plan.PagingFiles -join '; '))
    if (-not $Apply) {
        Write-Host 'Preview only. Run elevated with -Apply to write changes. This script never restarts Windows.'
        return
    }
    if (-not (Test-IsAdministrator)) {
        throw 'Administrator privileges are required. Run an elevated PowerShell with -Apply.'
    }

    $memoryKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management'
    $backupDir = Join-Path $PSScriptRoot '..\..\outputs\pagefile-backups'
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backupPath = Join-Path $backupDir "pagingfiles-$stamp.txt"
    $before = (Get-ItemProperty -LiteralPath $memoryKey -Name PagingFiles).PagingFiles
    @(
        "Captured=$((Get-Date).ToString('o'))"
        'PagingFiles:'
        $before
    ) | Set-Content -LiteralPath $backupPath -Encoding utf8

    Set-CimInstance -Query 'SELECT * FROM Win32_ComputerSystem' -Property @{ AutomaticManagedPagefile = $false } | Out-Null
    Set-ItemProperty -LiteralPath $memoryKey -Name PagingFiles -Type MultiString -Value $plan.PagingFiles

    $after = (Get-ItemProperty -LiteralPath $memoryKey -Name PagingFiles).PagingFiles
    Write-Host "Original configuration backup: $backupPath"
    Write-Host ('Configuration written: ' + ($after -join '; '))
    Write-Host 'Restart Windows manually later to activate the new pagefile configuration. This script will not restart it.'
}
