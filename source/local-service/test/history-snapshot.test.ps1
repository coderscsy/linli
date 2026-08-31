param(
    [Parameter(Mandatory = $true)][string]$MemoryLib,
    [Parameter(Mandatory = $true)][string]$Retrieval,
    [Parameter(Mandatory = $true)][string]$Snapshot
)

$ErrorActionPreference = "Stop"
. $MemoryLib
. $Retrieval
Read-HistorySnapshot -Path $Snapshot | Out-Null
