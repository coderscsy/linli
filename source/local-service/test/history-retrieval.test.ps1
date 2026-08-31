param(
    [Parameter(Mandatory = $true)][string]$MemoryLib,
    [Parameter(Mandatory = $true)][string]$Retrieval,
    [Parameter(Mandatory = $true)][string]$Snapshot,
    [Parameter(Mandatory = $true)][string]$ExpectedSha256
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
. $MemoryLib
. $Retrieval

$history = Read-HistorySnapshot -Path $Snapshot
$query = ([string]$history.exchanges[0].reply).Substring(0, 2)
$hits = @(Search-HistorySnapshot -Snapshot $history -Query $query -Side reply)
if ($hits.Count -ne 1 -or $hits[0].letterId -ne "letter-1") { throw "search failed" }

$budget = New-HistoryBudget
$intent = [pscustomobject]@{
    action = "lookup"
    lookups = @([pscustomobject]@{
        operation = "read"
        letterId = "letter-1"
        order = 0
        date = ""
        intent = "verify"
    })
}
$result = Invoke-HistoryRetrieval -Snapshot $history -Intent $intent -Budget $budget
if ($result.evidence.Count -ne 1 -or $result.evidence[0].exactSha256 -ne $ExpectedSha256) { throw "read failed" }

$forbiddenRejected = $false
try {
    Search-HistorySnapshot -Snapshot $history -Query "https://example.com" | Out-Null
}
catch {
    $forbiddenRejected = $true
}
if (-not $forbiddenRejected) { throw "forbidden query accepted" }
