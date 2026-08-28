param(
    [Parameter(Mandatory = $true)][string]$Person,
    [Parameter(Mandatory = $true)][int]$N,
    [Parameter(Mandatory = $true)][string]$ArchivePath,
    [string]$Tag = "standalone",
    [string]$OutFile = ""
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$archive = (Resolve-Path -LiteralPath $ArchivePath).Path
$arguments = @{
    Person = $Person
    N = $N
    Root = $root
    ArchivePath = $archive
    RulesFile = (Join-Path $root "harness\写法.md")
    HarnessDir = (Join-Path $root "harness")
    Tag = $Tag
    InitializeState = $true
}
if (-not [string]::IsNullOrWhiteSpace($OutFile)) {
    $arguments.OutFile = $OutFile
}

& (Join-Path $root "scripts\harness-4step.ps1") @arguments
